import { HttpException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User, UserLevel } from '../../database/entities/user.entity'
import { AssetTransfersCategory } from '../../common/constants/constants';
import { Web3Service } from '../../config/web3.service'
import { WalletAnalysis } from '../../database/entities/wallet-analysis.entity';
import Redis from 'ioredis';


type Trade = {
    token: string;
    buyPrice: number;
    sellPrice: number;
    buyTime: number;
    sellTime: number;
};

type Transfer = {
    asset?: string;
    value?: number | string;
    metadata: {
        blockTimestamp: string;
    };
    type: 'IN' | 'OUT';
};

type TokenRow = {
    contractAddress: string | null;
    symbol: string;
    name: string;
    decimals: number;
    quantity: number;
    currentPriceUsd: number;
    currentValueUsd: number;
    allocationPercent: number;
};

type AllocationRow = {
    symbol: string;
    name: string;
    valueUsd: number;
    allocationPercent: number;
};


@Injectable()
export class WalletService {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        private readonly jwtService: JwtService,
        private readonly web3Service: Web3Service,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
        @InjectRepository(WalletAnalysis)
        private readonly walletAnalysisRepository: Repository<WalletAnalysis>,
    ) { }

    private readonly logger = new Logger(WalletService.name);

    private handleServiceError(error: unknown, context: string): never {
        if (error instanceof HttpException) {
            throw error;
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`${context} failed: ${message}`, error instanceof Error ? error.stack : undefined);

        throw new InternalServerErrorException(`${context} failed`);
    }

    private normalizeTransfers(incoming: any[], outgoing: any[]) {
        return [
            ...incoming.map(t => ({ ...t, type: "IN" })),
            ...outgoing.map(t => ({ ...t, type: "OUT" })),
        ];
    }

    async walletConnect(walletAddress: string) {
        try {
            const normalizedAddress = walletAddress.toLowerCase().trim();

            let user = await this.userRepository.findOne({
                where: { walletAddress: normalizedAddress },
            });

            if (!user) {
                user = this.userRepository.create({
                    walletAddress: normalizedAddress,
                    level: UserLevel.BEGINNER,
                });
                user = await this.userRepository.save(user);
            }

            const payload = {
                sub: user.id,
                walletAddress: user.walletAddress,
            };

            const accessToken = await this.jwtService.signAsync(payload, {
                secret: process.env.JWT_ACCESS_SECRET,
                expiresIn: '15m',
            });

            const refreshToken = await this.jwtService.signAsync(payload, {
                secret: process.env.JWT_REFRESH_SECRET,
                expiresIn: '7d',
            });

            const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
            await this.userRepository.update(user.id, { refreshTokenHash });

            const cacheKey = `wallet:analyze:${user.id}:${user.walletAddress.toLowerCase()}`;
            await this.del(cacheKey);

            return {
                success: true,
                data: {
                    user: {
                        id: user.id,
                        walletAddress: user.walletAddress,
                        level: user.level,
                    },
                    tokens: {
                        accessToken,
                        refreshToken,
                    },
                },
            };
        } catch (error) {
            this.handleServiceError(error, 'Wallet connect');
        }
    }

    private buildTrades(transfers: Transfer[]): Trade[] {
        const grouped = new Map<string, Transfer[]>();

        for (const tx of transfers) {
            const token = tx.asset || "ETH";
            if (!grouped.has(token)) grouped.set(token, []);
            grouped.get(token)!.push(tx);
        }

        const trades: Trade[] = [];

        for (const [token, txs] of grouped.entries()) {
            txs.sort(
                (a, b) =>
                    new Date(a.metadata.blockTimestamp).getTime() -
                    new Date(b.metadata.blockTimestamp).getTime()
            );

            let lastBuy: any = null;

            for (const tx of txs) {
                const value = Number(tx.value || 0);
                const time = new Date(tx.metadata.blockTimestamp).getTime();

                if (tx.type === "IN") {
                    lastBuy = { price: value, time };
                } else if (tx.type === "OUT" && lastBuy) {
                    trades.push({
                        token,
                        buyPrice: lastBuy.price,
                        sellPrice: value,
                        buyTime: lastBuy.time,
                        sellTime: time,
                    });
                    lastBuy = null;
                }
            }
        }

        return trades;
    }

    private calculateWinRate(trades: Trade[]): number {
        if (!trades.length) return 0;

        const wins = trades.filter(t => t.sellPrice > t.buyPrice).length;
        return Number(((wins / trades.length) * 100).toFixed(2));
    }

    private calculateAvgHoldTime(trades: Trade[]): number {
        if (!trades.length) return 0;

        const total = trades.reduce(
            (sum, t) => sum + (t.sellTime - t.buyTime),
            0
        );

        return Number(
            (total / trades.length / (1000 * 60 * 60 * 24)).toFixed(2)
        );
    }

    private calculateTradeFrequency(trades: Trade[]): number {
        if (trades.length < 2) return trades.length;

        const times = trades.flatMap(t => [t.buyTime, t.sellTime]);
        const days =
            (Math.max(...times) - Math.min(...times)) /
            (1000 * 60 * 60 * 24);

        return Number((trades.length / (days || 1)).toFixed(2));
    }

    private calculateRiskScore(
        trades: Trade[],
        avgHold: number,
        frequency: number
    ): number {
        if (!trades.length) return 0;

        const returns = trades.map(
            t => (t.sellPrice - t.buyPrice) / (t.buyPrice || 1)
        );

        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

        const variance =
            returns.reduce((s, r) => s + (r - mean) ** 2, 0) /
            returns.length;

        const volatility = Math.sqrt(variance);

        const score =
            0.5 * Math.min(volatility * 100, 100) +
            0.3 * Math.min(frequency * 10, 100) +
            0.2 * (avgHold < 3 ? 100 : avgHold < 10 ? 60 : 20);

        return Number(Math.min(score, 100).toFixed(2));
    }

    private getBehaviorType(avgHold: number, freq: number, risk: number): string {
        if (avgHold > 30 && freq < 2) return "Holder";
        if (avgHold < 3 && freq > 10) return "Day Trader";
        if (risk > 80) return "Degenerate";
        if (avgHold < 15) return "Swing Trader";
        return "Balanced";
    }

    private calculateWalletHealth(
        winRate: number,
        risk: number,
        trades: Trade[]
    ): number {
        if (!trades.length) return 0;

        const totalBuy = trades.reduce((s, t) => s + t.buyPrice, 0);
        const profit = trades.reduce(
            (s, t) => s + (t.sellPrice - t.buyPrice),
            0
        );

        const roi = totalBuy ? profit / totalBuy : 0;

        return Number(
            (
                0.4 * winRate +
                0.3 * (100 - risk) +
                0.3 * Math.min(roi * 100, 100)
            ).toFixed(2)
        );
    }

    private calculateBasicMetrics(transfers: Transfer[]) {
        return {
            totalTransactions: transfers.length,
            uniqueTokens: new Set(transfers.map(t => t.asset || "ETH")).size,
        };
    }

    private getWalletLevel(
        tx: number,
        freq: number,
        winRate: number
    ): string {
        if (tx < 20 && freq < 1) return "BEGINNER";
        if (tx < 100 && freq < 5 && winRate < 70) return "INTERMEDIATE";
        return "ADVANCED";
    }

    private generateWalletInsight(
        tx: number,
        tokens: number,
        freq: number
    ): string {
        if (tx < 20) {
            return "Low on-chain activity detected — user is likely new to crypto.";
        }

        if (tx < 100 || tokens < 5) {
            return "Moderate activity with some diversification across tokens.";
        }

        if (freq > 5 && tokens > 5) {
            return "High activity wallet with strong on-chain presence.";
        }

        return "Wallet shows balanced activity with steady participation.";
    }

    async set(key: string, value: any, ttl = 60) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    }

    async get<T>(key: string): Promise<T | null> {
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
    }

    async del(key: string) {
        await this.redis.del(key);
    }

    async analyzeWalletDetails(userId: string) {
        try {
            const user = await this.userRepository.findOne({ where: { id: userId } });
            if (!user) throw new NotFoundException('User not found');
            const address = user.walletAddress.toLowerCase();

            const cacheKey = `wallet:analyze:${user.id}:${address}`;
            // 1) Try cache first
            const cached = await this.get<any>(cacheKey);
            if (cached) {
                return {
                    ...cached,
                    cache: true,
                };
            }

            const alchemy = this.web3Service.alchemy;

            const tokenBalancesRes = await alchemy.core.getTokenBalances(address);

            const nonZeroTokenBalances = tokenBalancesRes.tokenBalances.filter(
                (t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x',
            );

            const tokenHoldings = await Promise.all(
                nonZeroTokenBalances.map(async (t) => {
                    const metadata = await alchemy.core.getTokenMetadata(t.contractAddress);
                    const decimals = metadata.decimals ?? 18;
                    const raw = t.tokenBalance ?? '0x0';
                    const rawBigInt = BigInt(raw);
                    const normalized =
                        Number(rawBigInt) / Math.pow(10, decimals); // MVP-friendly
                    return {
                        contractAddress: t.contractAddress,
                        symbol: metadata.symbol ?? 'UNKNOWN',
                        name: metadata.name ?? 'Unknown Token',
                        decimals,
                        rawBalance: rawBigInt.toString(),
                        balance: normalized,
                        logo: metadata.logo ?? null,
                    };
                }),
            );

            const tokenHoldingCount = tokenHoldings.length;

            const [incoming, outgoing] = await Promise.all([
                alchemy.core.getAssetTransfers({
                    fromBlock: "0x0",
                    toAddress: address,
                    category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
                    withMetadata: true,
                    excludeZeroValue: true,
                    maxCount: 100,
                }),
                alchemy.core.getAssetTransfers({
                    fromBlock: "0x0",
                    fromAddress: address,
                    category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
                    withMetadata: true,
                    excludeZeroValue: true,
                    maxCount: 100,
                }),
            ]);

            const transfers = this.normalizeTransfers(
                incoming.transfers,
                outgoing.transfers
            );

            const trades = this.buildTrades(transfers);

            //metrics
            const winRate = this.calculateWinRate(trades);
            const avgHold = this.calculateAvgHoldTime(trades);
            const frequency = this.calculateTradeFrequency(trades);
            const risk = this.calculateRiskScore(trades, avgHold, frequency);
            const behavior = this.getBehaviorType(avgHold, frequency, risk);
            const health = this.calculateWalletHealth(winRate, risk, trades);
            const { totalTransactions, uniqueTokens } = this.calculateBasicMetrics(transfers);

            const walletLevel = this.getWalletLevel(
                totalTransactions,
                frequency,
                winRate
            );

            const insight = this.generateWalletInsight(
                totalTransactions,
                uniqueTokens,
                frequency
            );

            const result = {
                win_rate: winRate,
                risk_score: risk,
                behavior_type: behavior,
                avg_hold_time_days: avgHold,
                trade_frequency: frequency,
                wallet_health_score: health,
                metrics: {
                    totalTransactions,
                    uniqueTokens,
                    tokenHoldingCount
                },
                holdings: tokenHoldings,
                wallet_level: walletLevel,
                insight,
                cache: false,
                generatedAt: new Date().toISOString(),
            };

            await this.set(cacheKey, result, 300);

            const analysis = this.walletAnalysisRepository.create({
                userId: user.id,
                walletAddress: address,
                winRate,
                riskScore: risk,
                behaviorType: behavior,
                avgHoldTimeDays: avgHold,
                tradeFrequency: frequency,
                walletHealthScore: health,
                totalTransactions,
                uniqueTokens,
                walletLevel: walletLevel as 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED',
                insight,
                rawData: {
                    incomingCount: incoming.transfers.length,
                    outgoingCount: outgoing.transfers.length,
                    generatedAt: new Date().toISOString(),
                },
            });
            await this.walletAnalysisRepository.save(analysis);

            // keep users table in sync with latest analyzed level
            await this.userRepository.update(user.id, {
                level: walletLevel as UserLevel,
            });

            return result;
        } catch (error) {
            this.handleServiceError(error, 'Wallet analyze');
        }
    }

    private formatUnits(raw: string, decimals: number): number {
        const value = BigInt(raw || '0x0');
        const base = 10 ** Math.min(decimals, 18);
        const normalized = Number(value) / base / 10 ** Math.max(decimals - 18, 0);
        return Number.isFinite(normalized) ? normalized : 0;
    }

    /**
    * Batch price fetch (much faster than per-token API calls)
    */
    private async getPricesUsd(symbols: string[]): Promise<Record<string, number>> {
        const baseUrl = process.env.COINGECKO_BASE_URL;
        const apiKey = process.env.COINGECKO_API_KEY;

        const map: Record<string, string> = {
            ETH: 'ethereum',
            BTC: 'bitcoin',
            SOL: 'solana',
            USDC: 'usd-coin',
            ARB: 'arbitrum',
        };

        const ids = symbols
            .map((s) => map[s.toUpperCase()])
            .filter(Boolean)
            .join(',');

        if (!ids) return {};

        const res = await fetch(
            `${baseUrl}/simple/price?ids=${ids}&vs_currencies=usd`, {
            headers: {
                'x_cg_demo_api_key': apiKey as string
            },
        }
        );

        if (!res.ok) return {};

        const json = await res.json();

        const result: Record<string, number> = {};

        for (const symbol of symbols) {
            const coinId = map[symbol.toUpperCase()];
            if (coinId && json[coinId]?.usd) {
                result[symbol] = json[coinId].usd;
            }
        }

        return result;
    }

    private async getHistoricalPrice(
        contractAddress: string,
        date: string,
    ): Promise<number | null> {

        const baseUrl = process.env.COINGECKO_BASE_URL;

        try {
            const res = await fetch(
                `${baseUrl}/coins/ethereum/contract/${contractAddress}/history?date=${date}`
            );

            if (!res.ok) return null;

            const json = await res.json();

            return json?.market_data?.current_price?.usd ?? null;

        } catch {
            return null;
        }
    }

    private async estimateAvgBuyPriceUsd(
        address: string,
        contractAddress: string,
    ): Promise<number | null> {

        const alchemy = this.web3Service.alchemy;

        try {
            const transfers = await alchemy.core.getAssetTransfers({
                fromBlock: "0x0",
                toAddress: address,
                contractAddresses: [contractAddress],
                category: [AssetTransfersCategory.ERC20],
                withMetadata: true,
                maxCount: 50, // MVP limit
            });

            if (!transfers.transfers.length) return null;

            let totalQty = 0;
            let totalCost = 0;

            for (const tx of transfers.transfers) {

                // ✅ Skip if metadata missing
                if (!tx.metadata?.blockTimestamp) continue;

                const qty = Number(tx.value || 0);
                if (!qty) continue;

                const dateObj = new Date(tx.metadata.blockTimestamp);

                const formattedDate = `${dateObj.getDate()}-${dateObj.getMonth() + 1}-${dateObj.getFullYear()}`;

                const price = await this.getHistoricalPrice(contractAddress, formattedDate);

                if (!price) continue;

                totalQty += qty;
                totalCost += qty * price;
            }

            if (totalQty === 0) return null;

            return totalCost / totalQty;

        } catch (err) {
            console.error("Avg buy price error:", err);
            return null;
        }
    }

    async getPortfolioSummary(userId: string) {
        const user = await this.userRepository.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');

        const address = user.walletAddress.toLowerCase();
        const cacheKey = `wallet:portfolio:${user.id}:${address}`;

        // 1) cache-first
        const cached = await this.get<any>(cacheKey);
        if (cached) {
            return { ...cached, cache: true };
        }

        try {
            const alchemy = this.web3Service.alchemy;
            const tokens: TokenRow[] = [];

            // 2) balances
            const balances = await this.withAlchemyRetry(
                'alchemy.getTokenBalances',
                () => alchemy.core.getTokenBalances(address),
            );

            const nonZero = balances.tokenBalances.filter(
                (t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x',
            );

            // prevent metadata storm on huge wallets
            const capped = nonZero.slice(0, 80);

            // 3) metadata with partial-failure tolerance
            const metadataResults = await Promise.allSettled(
                capped.map((t) =>
                    this.withAlchemyRetry(
                        `alchemy.getTokenMetadata:${t.contractAddress}`,
                        () => alchemy.core.getTokenMetadata(t.contractAddress),
                        1,
                    ),
                ),
            );

            const metadataList = metadataResults.map((res, i) => {
                if (res.status === 'fulfilled') return res.value;

                const contract = capped[i]?.contractAddress ?? 'unknown';
                this.logger.warn(`Metadata fetch failed for: ${contract}`);

                return {
                    symbol: 'UNKNOWN',
                    name: 'Unknown Token',
                    decimals: 18,
                    logo: null,
                };
            });

            // 4) eth
            const ethBalanceWei = await this.withAlchemyRetry(
                'alchemy.getBalance',
                () => alchemy.core.getBalance(address),
            );
            const ethQuantity = Number(ethBalanceWei) / 1e18;

            // 5) price symbols (skip unknown)
            const symbols = metadataList
                .map((m) => (m.symbol ?? 'UNKNOWN').toUpperCase())
                .filter((s) => s !== 'UNKNOWN');

            if (ethQuantity > 0) symbols.push('ETH');

            const priceMap = await this.getPricesUsd(symbols);

            // 6) process ERC20 holdings
            for (let i = 0; i < capped.length; i++) {
                const t = capped[i];
                const metadata = metadataList[i];

                const decimals = metadata.decimals ?? 18;
                const symbol = (metadata.symbol ?? 'UNKNOWN').toUpperCase();
                const name = metadata.name ?? 'Unknown Token';

                const quantity = this.formatUnits(t.tokenBalance ?? '0x0', decimals);
                if (quantity <= 0) continue;

                // skip unknown + unpriced tokens to avoid noisy portfolio
                if (symbol === 'UNKNOWN') continue;

                const currentPriceUsd = priceMap[symbol] ?? 0;
                if (!currentPriceUsd || currentPriceUsd <= 0) continue;

                const currentValueUsd = quantity * currentPriceUsd;

                tokens.push({
                    contractAddress: t.contractAddress,
                    symbol,
                    name,
                    decimals,
                    quantity: Number(quantity.toFixed(6)),
                    currentPriceUsd: Number(currentPriceUsd.toFixed(4)),
                    currentValueUsd: Number(currentValueUsd.toFixed(2)),
                    allocationPercent: 0,
                });
            }

            // 7) add ETH
            if (ethQuantity > 0) {
                const ethPrice = priceMap['ETH'] ?? 0;
                const ethValue = ethQuantity * ethPrice;

                if (ethPrice > 0 && ethValue > 0) {
                    tokens.push({
                        contractAddress: null,
                        symbol: 'ETH',
                        name: 'Ethereum',
                        decimals: 18,
                        quantity: Number(ethQuantity.toFixed(6)),
                        currentPriceUsd: Number(ethPrice.toFixed(4)),
                        currentValueUsd: Number(ethValue.toFixed(2)),
                        allocationPercent: 0,
                    });
                }
            }

            // 8) sort + allocation
            tokens.sort((a, b) => b.currentValueUsd - a.currentValueUsd);

            const totalValueUsd = tokens.reduce((sum, t) => sum + t.currentValueUsd, 0);

            for (const t of tokens) {
                t.allocationPercent =
                    totalValueUsd > 0
                        ? Number(((t.currentValueUsd / totalValueUsd) * 100).toFixed(2))
                        : 0;
            }

            const result = {
                success: true,
                data: {
                    walletAddress: address,
                    totalValueUsd: Number(totalValueUsd.toFixed(2)),
                    uniqueTokens: tokens.length,
                    change24hPercent: 0,
                    tokens,
                },
                cache: false,
                generatedAt: new Date().toISOString(),
            };

            await this.set(cacheKey, result, 300);
            return result;
        } catch (error) {
            // stale-cache fallback on upstream failures
            const stale = await this.get<any>(cacheKey);
            if (stale) {
                return {
                    ...stale,
                    cache: true,
                    stale: true,
                    warning: 'Live provider unavailable, returned cached portfolio.',
                };
            }

            this.handleServiceError(error, 'Wallet portfolio summary');
        }
    }

    private isRetryableAlchemyError(error: unknown): boolean {
        const msg = error instanceof Error ? error.message : String(error);
        return (
            msg.includes('SERVER_ERROR') ||
            msg.includes('429') ||
            msg.toLowerCase().includes('timeout') ||
            msg.toLowerCase().includes('network') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('ECONNRESET')
        );
    }

    private sanitizeErrorMessage(error: unknown): string {
        const raw = error instanceof Error ? error.message : String(error);
        return raw
            .replace(/https:\/\/[^ ]+/g, '[redacted-url]')
            .replace(/\/v2\/[A-Za-z0-9_-]+/g, '/v2/[redacted-key]');
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async withAlchemyRetry<T>(
        operationName: string,
        fn: () => Promise<T>,
        retries = 2,
    ): Promise<T> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const retryable = this.isRetryableAlchemyError(error);

                if (!retryable || attempt === retries) break;

                const backoffMs = 250 * Math.pow(2, attempt);
                this.logger.warn(
                    `${operationName} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${backoffMs}ms: ${this.sanitizeErrorMessage(error)}`,
                );
                await this.sleep(backoffMs);
            }
        }

        this.logger.error(`${operationName} failed: ${this.sanitizeErrorMessage(lastError)}`);
        throw lastError;
    }

    async logout(userId: string) {
        try {
            const user = await this.userRepository.findOne({ where: { id: userId } });
            if (!user) {
                throw new NotFoundException('User not found');
            }

            // Invalidate refresh session
            await this.userRepository.update(user.id, { refreshTokenHash: null });

            //clear cached wallet analysis
            const cacheKey = `wallet:analyze:${user.id}:${user.walletAddress.toLowerCase()}`;
            await this.del(cacheKey);

            return {
                success: true,
                message: 'Logged out successfully',
            };
        } catch (error) {
            this.handleServiceError(error, 'Wallet logout');
        }
    }

    async getGlobalMarketData() {
        try {
            const baseUrl = process.env.COINGECKO_BASE_URL;
            const apiKey = process.env.COINGECKO_API_KEY;

            if (!baseUrl || !apiKey) {
                throw new InternalServerErrorException(
                    'CoinGecko env config is missing',
                );
            }

            const response = await fetch(`${baseUrl}/global`, {
                method: 'GET',
                headers: {
                    'x_cg_demo_api_key': apiKey,
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                this.logger.error(
                    `CoinGecko global API failed: ${response.status} ${errorText}`,
                );
                throw new InternalServerErrorException('Failed to fetch global market data');
            }

            const data = await response.json();

            return {
                success: true,
                data,
            };
        } catch (error) {
            this.handleServiceError(error, 'Get global market data');
        }
    }

    private mapSymbolToCoinId(symbol: string): string | null {
        const map: Record<string, string> = {
            ETH: 'ethereum',
            BTC: 'bitcoin',
            SOL: 'solana',
            USDC: 'usd-coin',
            ARB: 'arbitrum',
        };
        return map[symbol.toUpperCase()] ?? null;
    }

    private async getCoinMarketChartUsd(
        coinId: string,
        days: number,
    ): Promise<Array<[number, number]>> {
        const baseUrl = process.env.COINGECKO_BASE_URL;
        const apiKey = process.env.COINGECKO_API_KEY;
        if (!baseUrl || !apiKey) return [];
        try {
            const res = await fetch(
                `${baseUrl}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
                {
                    headers: {
                        'x_cg_demo_api_key': apiKey,
                    },
                },
            );
            if (!res.ok) return [];
            const json = await res.json();
            // [timestamp, price]
            return Array.isArray(json?.prices) ? json.prices : [];
        } catch {
            return [];
        }
    }

    private normalizeToLength(series: number[], len: number): number[] {
        if (!series.length) return Array.from({ length: len }, () => 1);
        if (series.length === len) return series;
        if (series.length > len) {
            return series.slice(series.length - len);
        }
        const out = [...series];
        while (out.length < len) out.unshift(series[0]);
        return out;
    }

    private buildD30Points(params: {
        portfolioSeries: number[];
        benchmarkSeries: number[];
        startDate: Date;
    }) {
        const { portfolioSeries, benchmarkSeries, startDate } = params;
        const len = Math.min(30, portfolioSeries.length, benchmarkSeries.length);
        const points: Array<{
            day: string;
            ts: string;
            benchmark: number;
            value: number;
        }> = [];
        for (let i = 0; i < len; i++) {
            const d = new Date(startDate);
            d.setUTCDate(d.getUTCDate() + i);
            points.push({
                day: `D${i + 1}`,
                ts: d.toISOString(),
                benchmark: Number(benchmarkSeries[i].toFixed(2)),
                value: Number(portfolioSeries[i].toFixed(2)),
            });
        }
        const first = points[0]?.value ?? 0;
        const last = points[points.length - 1]?.value ?? 0;
        const changePercent = first > 0 ? Number((((last - first) / first) * 100).toFixed(2)) : 0;
        return {
            currentValueUsd: Number(last.toFixed(2)),
            changePercent,
            points,
        };
    }

    private async buildPortfolioAndBenchmarkSeries30d(params: {
        allocation: AllocationRow[];
        totalValueUsd: number;
    }): Promise<{ portfolioSeries: number[]; benchmarkSeries: number[] }> {
        const { allocation, totalValueUsd } = params;
        const DAYS = 30;
        // 1) Portfolio series (weighted from token historical prices)
        const relBySymbol: Record<string, number[]> = {};
        for (const row of allocation) {
            const coinId = this.mapSymbolToCoinId(row.symbol);
            if (!coinId) continue;
            const chart = await this.getCoinMarketChartUsd(coinId, DAYS);
            const prices = chart.map((p: [number, number]) => Number(p[1])).filter((n) => Number.isFinite(n) && n > 0);
            if (!prices.length) continue;
            const normalized = this.normalizeToLength(prices, DAYS);
            const base = normalized[0] || 1;
            relBySymbol[row.symbol] = normalized.map((p) => p / base);
        }
        let portfolioIndex = Array.from({ length: DAYS }, () => 0);
        for (const row of allocation) {
            const rel = relBySymbol[row.symbol];
            if (!rel) continue;
            const weight = row.allocationPercent / 100;
            for (let i = 0; i < DAYS; i++) {
                portfolioIndex[i] += weight * rel[i];
            }
        }
        // fallback if no historical data
        if (portfolioIndex.every((v) => v === 0)) {
            portfolioIndex = Array.from({ length: DAYS }, (_, i) => 1 + i * 0.0025);
        }
        const portfolioSeries = portfolioIndex.map((idx) => idx * totalValueUsd);
        // 2) Benchmark series (60% BTC + 40% ETH)
        const btcChart = await this.getCoinMarketChartUsd('bitcoin', DAYS);
        const ethChart = await this.getCoinMarketChartUsd('ethereum', DAYS);
        const btc = this.normalizeToLength(
            btcChart.map((p: [number, number]) => Number(p[1])).filter((n) => Number.isFinite(n) && n > 0),
            DAYS,
        );
        const eth = this.normalizeToLength(
            ethChart.map((p: [number, number]) => Number(p[1])).filter((n) => Number.isFinite(n) && n > 0),
            DAYS,
        );
        const btcBase = btc[0] || 1;
        const ethBase = eth[0] || 1;
        const benchmarkIndex = Array.from({ length: DAYS }, (_, i) => {
            const btcRel = (btc[i] || btcBase) / btcBase;
            const ethRel = (eth[i] || ethBase) / ethBase;
            return 0.6 * btcRel + 0.4 * ethRel;
        });
        const benchmarkSeries = benchmarkIndex.map((idx) => idx * totalValueUsd);
        return { portfolioSeries, benchmarkSeries };
    }

    private buildAssetAllocationTop4WithOthers(
        rows: Array<{ symbol: string; name: string; valueUsd: number }>,
    ) {
        const total = rows.reduce((s, r) => s + r.valueUsd, 0);
        const sorted = [...rows].sort((a, b) => b.valueUsd - a.valueUsd);
        const top4 = sorted.slice(0, 4);
        const rest = sorted.slice(4);
        const othersValue = rest.reduce((s, r) => s + r.valueUsd, 0);
        const mappedTop4 = top4.map((r) => ({
            symbol: r.symbol,
            name: r.name,
            valueUsd: Number(r.valueUsd.toFixed(2)),
            allocationPercent: total > 0 ? Number(((r.valueUsd / total) * 100).toFixed(2)) : 0,
        }));
        if (othersValue > 0) {
            mappedTop4.push({
                symbol: 'OTHERS',
                name: 'Others',
                valueUsd: Number(othersValue.toFixed(2)),
                allocationPercent: total > 0 ? Number(((othersValue / total) * 100).toFixed(2)) : 0,
            });
        }
        return mappedTop4;
    }

    async getPortfolioAnalytics(userId: string) {
        try {
            const user = await this.userRepository.findOne({ where: { id: userId } });
            if (!user) throw new NotFoundException('User not found');
            const address = user.walletAddress.toLowerCase();
            const cacheKey = `wallet:portfolio-analytics:${user.id}:${address}:30d`;
            // 1) cache-first
            const cached = await this.get<any>(cacheKey);
            if (cached) {
                return { ...cached, cache: true };
            }
            const alchemy = this.web3Service.alchemy;
            // 2) balances + metadata
            const balances = await alchemy.core.getTokenBalances(address);
            const nonZero = balances.tokenBalances.filter(
                (t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x',
            );
            const metadataList = await Promise.all(
                nonZero.map((t) => alchemy.core.getTokenMetadata(t.contractAddress)),
            );
            const ethBalanceWei = await alchemy.core.getBalance(address);
            const ethQty = Number(ethBalanceWei) / 1e18;
            const symbols = metadataList.map((m) => m.symbol ?? 'UNKNOWN');
            if (ethQty > 0) symbols.push('ETH');
            const priceMap = await this.getPricesUsd(symbols);
            // 3) build current allocation
            const allocationRaw: Array<{
                symbol: string;
                name: string;
                quantity: number;
                valueUsd: number;
            }> = [];
            for (let i = 0; i < nonZero.length; i++) {
                const t = nonZero[i];
                const m = metadataList[i];
                const symbol = m.symbol ?? 'UNKNOWN';
                const name = m.name ?? 'Unknown Token';
                const decimals = m.decimals ?? 18;
                const qty = this.formatUnits(t.tokenBalance ?? '0x0', decimals);
                if (qty <= 0) continue;
                const price = priceMap[symbol] ?? 0;
                const valueUsd = qty * price;
                if (valueUsd <= 0) continue;
                allocationRaw.push({
                    symbol,
                    name,
                    quantity: Number(qty.toFixed(6)),
                    valueUsd: Number(valueUsd.toFixed(2)),
                });
            }
            if (ethQty > 0) {
                const ethPrice = priceMap['ETH'] ?? 0;
                const ethValue = ethQty * ethPrice;
                if (ethValue > 0) {
                    allocationRaw.push({
                        symbol: 'ETH',
                        name: 'Ethereum',
                        quantity: Number(ethQty.toFixed(6)),
                        valueUsd: Number(ethValue.toFixed(2)),
                    });
                }
            }
            const totalValueUsd = allocationRaw.reduce((sum, r) => sum + r.valueUsd, 0);
            const assetAllocation = this.buildAssetAllocationTop4WithOthers(allocationRaw);

            // 4) build 30d portfolio + benchmark lines
            const { portfolioSeries, benchmarkSeries } = await this.buildPortfolioAndBenchmarkSeries30d({
                allocation: assetAllocation,
                totalValueUsd: Number(totalValueUsd.toFixed(2)),
            });

            const startDate = new Date();
            startDate.setUTCDate(startDate.getUTCDate() - 29); // D1 ... D30

            const perf = this.buildD30Points({
                portfolioSeries,
                benchmarkSeries,
                startDate,
            });

            const result = {
                success: true,
                data: {
                    range: '30d',
                    walletAddress: address,
                    currentValueUsd: perf.currentValueUsd,
                    changePercent: perf.changePercent,
                    portfolioPerformance: {
                        points: perf.points, // D1..D30 with { benchmark, value }
                    },
                    assetAllocation, // donut/pie chart
                    meta: {
                        currency: 'USD',
                        benchmarkLabel: 'Crypto Market Index (60% BTC, 40% ETH)',
                        generatedAt: new Date().toISOString(),
                    },
                },
                cache: false,
            };

            // 5) cache for 5 min
            await this.set(cacheKey, result, 300);

            return result;
        } catch (error) {
            this.handleServiceError(error, 'Portfolio Analytics');
        }
    }
}