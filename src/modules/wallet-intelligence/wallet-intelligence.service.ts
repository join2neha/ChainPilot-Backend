import {
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';

import { User } from '../../database/entities/user.entity';
import { Web3Service } from '../../config/web3.service';
import { AssetTransfersCategory } from '../../common/constants/constants';
import { PriceService } from '../price/price.service';

type NormalizedTransfer = {
    token: string;
    amount: number;
    direction: 'IN' | 'OUT';
    timestamp: number;
    txHash: string;
};

type SwapTx = {
    hash: string;
    timestamp: number;
    tokensIn: { symbol: string; amount: number }[];
    tokensOut: { symbol: string; amount: number }[];
};

type Trade = {
    token: string;
    buyTimestamp: number;
    sellTimestamp: number;
    holdTimeSec: number;
};

type ProfileMetrics = {
    winRate: number;
    avgHoldDays: number;
    tradesPerWeek: number;
    profitabilityScore: number;
};

type BehaviorBreakdown = {
    swingTrader: number;
    whaleFollower: number;
    longTermHolder: number;
    degen: number;
};

type RiskExposure = {
    L1: number;
    DeFi: number;
    Memes: number;
    Stables: number;
};

@Injectable()
export class WalletIntelligenceService {
    private readonly logger = new Logger(WalletIntelligenceService.name);

    // MVP-safe transfer cap: 150 incoming + 150 outgoing ~= 300 max
    private static readonly TRANSFER_LIMIT_PER_DIRECTION = 150;
    private static readonly CACHE_TTL_SECONDS = 60;

    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        private readonly web3Service: Web3Service,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
        private readonly priceService: PriceService,
    ) { }

    async getWalletIntelligence(userId: string) {
        try {
            // Step 0: load user
            const user = await this.userRepository.findOne({ where: { id: userId } });
            if (!user) throw new NotFoundException('User not found');

            const address = user.walletAddress.toLowerCase();
            const cacheKey = `wallet:intelligence:${user.id}:${address}`;

            // Step 1: cache first
            const cached = await this.get<any>(cacheKey);
            if (cached) {
                return { ...cached, cache: true };
            }

            // Step 2: fetch + normalize transfers
            const transfers = await this.fetchAndNormalizeTransfers(address);

            // Step 3: build trade approximations
            const trades = this.buildRealTrades(transfers);

            // Step 4: compute profile metrics
            const profile = this.computeProfileMetrics(trades);

            // Step 5: classify behavior
            const behavior = this.computeBehavior(trades, profile.tradesPerWeek);

            // Step 6: compute risk exposure from current holdings
            const riskExposure = await this.computeRiskExposure(address);

            const result = {
                success: true,
                data: {
                    profile,
                    behavior,
                    riskExposure,
                    isEstimated: true,
                },
                cache: false,
                generatedAt: new Date().toISOString(),
            };

            // Step 8: cache response
            await this.set(cacheKey, result, WalletIntelligenceService.CACHE_TTL_SECONDS);

            return result;
        } catch (error) {
            this.handleServiceError(error, 'Wallet intelligence');
        }
    }

    // -----------------------------
    // Step 1 + 2: transfers
    // -----------------------------
    private async fetchAndNormalizeTransfers(address: string): Promise<NormalizedTransfer[]> {
        const alchemy = this.web3Service.alchemy;
        const maxCount = WalletIntelligenceService.TRANSFER_LIMIT_PER_DIRECTION;

        const [incoming, outgoing] = await Promise.all([
            alchemy.core.getAssetTransfers({
                fromBlock: '0x0',
                toAddress: address,
                category: [AssetTransfersCategory.ERC20],
                withMetadata: true,
                excludeZeroValue: true,
                maxCount,
            }),
            alchemy.core.getAssetTransfers({
                fromBlock: '0x0',
                fromAddress: address,
                category: [AssetTransfersCategory.ERC20],
                withMetadata: true,
                excludeZeroValue: true,
                maxCount,
            }),
        ]);

        const normalizedIn = this.normalizeTransferList(incoming.transfers, 'IN');
        const normalizedOut = this.normalizeTransferList(outgoing.transfers, 'OUT');

        return [...normalizedIn, ...normalizedOut].sort((a, b) => a.timestamp - b.timestamp);
    }

    private normalizeTransferList(
        list: any[],
        direction: 'IN' | 'OUT',
    ): NormalizedTransfer[] {
        const normalized: NormalizedTransfer[] = [];

        for (const tx of list) {
            const isoTs = tx?.metadata?.blockTimestamp;
            if (!isoTs) continue;

            const timestamp = new Date(isoTs).getTime();
            if (!Number.isFinite(timestamp) || timestamp <= 0) continue;

            const txHash = String(tx?.hash ?? '').trim();
            if (!txHash) continue;

            const amount = Number(tx?.value ?? 0);
            if (!Number.isFinite(amount) || amount <= 0) continue;

            const token = String(tx?.asset ?? 'UNKNOWN').toUpperCase();

            normalized.push({
                token,
                amount,
                direction,
                timestamp,
                txHash,
            });
        }

        return normalized;
    }

    // -----------------------------
    // Step 3: trade approximation
    // -----------------------------

    private groupTransfersByTx(
        transfers: NormalizedTransfer[],
    ): Map<string, NormalizedTransfer[]> {
        const byTx = new Map<string, NormalizedTransfer[]>();

        for (const t of transfers) {
            const arr = byTx.get(t.txHash);
            if (arr) arr.push(t);
            else byTx.set(t.txHash, [t]);
        }

        return byTx;
    }

    private extractSwapTransactions(
        grouped: Map<string, NormalizedTransfer[]>,
    ): SwapTx[] {
        const swaps: SwapTx[] = [];

        for (const [hash, txTransfers] of grouped.entries()) {
            if (!txTransfers.length) continue;

            const tokensIn: { symbol: string; amount: number }[] = [];
            const tokensOut: { symbol: string; amount: number }[] = [];

            let ts = Number.MAX_SAFE_INTEGER;

            for (const t of txTransfers) {
                if (!Number.isFinite(t.timestamp) || t.timestamp <= 0) continue;
                if (!Number.isFinite(t.amount) || t.amount <= 0) continue;

                ts = Math.min(ts, t.timestamp);

                if (t.direction === 'IN') {
                    tokensIn.push({ symbol: t.token, amount: t.amount });
                } else {
                    tokensOut.push({ symbol: t.token, amount: t.amount });
                }
            }

            // swap = at least 1 token in + 1 token out - relaxed condition
            if (tokensIn.length + tokensOut.length < 2) continue;
            if (!Number.isFinite(ts) || ts === Number.MAX_SAFE_INTEGER) continue;

            swaps.push({
                hash,
                timestamp: ts,
                tokensIn,
                tokensOut,
            });
        }

        swaps.sort((a, b) => a.timestamp - b.timestamp);
        return swaps;
    }

    private buildRealTrades(transfers: NormalizedTransfer[]): Trade[] {
        if (!transfers.length) return [];

        const grouped = this.groupTransfersByTx(transfers);
        const swaps = this.extractSwapTransactions(grouped);

        const buyQueues = new Map<string, number[]>();
        const trades: Trade[] = [];

        for (const swap of swaps) {

            // BUY → tokens received
            for (const tin of swap.tokensIn) {
                const queue = buyQueues.get(tin.symbol) ?? [];
                queue.push(swap.timestamp);
                buyQueues.set(tin.symbol, queue);
            }

            // SELL → tokens sent
            for (const tout of swap.tokensOut) {
                const queue = buyQueues.get(tout.symbol);

                if (!queue || queue.length === 0) {
                    //fallback trade (IMPORTANT)
                    trades.push({
                        token: tout.symbol,
                        buyTimestamp: swap.timestamp - 3600 * 1000, // assume 1h hold
                        sellTimestamp: swap.timestamp,
                        holdTimeSec: 3600,
                    });
                    continue;
                }

                const buyTimestamp = queue.shift()!;

                trades.push({
                    token: tout.symbol,
                    buyTimestamp,
                    sellTimestamp: swap.timestamp,
                    holdTimeSec: Math.max(
                        60,
                        Math.floor((swap.timestamp - buyTimestamp) / 1000),
                    ),
                });
            }
        }

        //HARD FALLBACK (if still no trades)
        if (!trades.length) {
            console.log("No swaps detected → using fallback trades");
            return this.buildFallbackTrades(transfers);
        }

        console.log({
            transfers: transfers.length,
            swaps: swaps.length,
            trades: trades.length,
        });

        return trades;
    }

    private buildFallbackTrades(transfers: NormalizedTransfer[]): Trade[] {
        const trades: Trade[] = [];

        const byToken = new Map<string, NormalizedTransfer[]>();

        for (const t of transfers) {
            const arr = byToken.get(t.token) ?? [];
            arr.push(t);
            byToken.set(t.token, arr);
        }

        for (const [token, txs] of byToken.entries()) {
            txs.sort((a, b) => a.timestamp - b.timestamp);

            for (let i = 0; i < txs.length - 1; i++) {
                const a = txs[i];
                const b = txs[i + 1];

                if (a.direction === 'IN' && b.direction === 'OUT') {
                    trades.push({
                        token,
                        buyTimestamp: a.timestamp,
                        sellTimestamp: b.timestamp,
                        holdTimeSec: Math.max(
                            60,
                            Math.floor((b.timestamp - a.timestamp) / 1000),
                        ),
                    });
                }
            }
        }

        return trades;
    }

    // -----------------------------
    // Step 4: metrics
    // -----------------------------
    private computeProfileMetrics(trades: Trade[]): ProfileMetrics {
        // Edge case: no trades
        if (!trades.length) {
            return {
                winRate: 50,
                avgHoldDays: 1,
                tradesPerWeek: 2,
                profitabilityScore: 50,
            };
        }

        const winRate = this.computeWinRate(trades);
        const avgHoldDays = this.computeAvgHoldDays(trades);
        const tradesPerWeek = this.computeTradesPerWeek(trades);

        // Frequency sub-score: map 0..20+ trades/week => 0..100
        const frequencyScore = this.clamp((tradesPerWeek / 20) * 100, 0, 100);

        // Consistency sub-score: lower variance in hold durations => higher consistency
        const consistencyScore = this.computeConsistencyScore(trades);

        // Profitability score weighting:
        // winRate (40%), trade frequency (30%), consistency (30%)
        const profitabilityScore = this.round2(
            this.clamp(
                0.4 * winRate + 0.3 * frequencyScore + 0.3 * consistencyScore,
                0,
                100,
            ),
        );

        return {
            winRate: this.round2(winRate),
            avgHoldDays: this.round2(avgHoldDays),
            tradesPerWeek: this.round2(tradesPerWeek),
            profitabilityScore,
        };
    }

    private computeWinRate(trades: Trade[]): number {
        // MVP assumption: sell after buy is profitable
        const profitableTrades = trades.filter((t) => t.sellTimestamp > t.buyTimestamp).length;
        return trades.length ? (profitableTrades / trades.length) * 100 : 0;
    }

    private computeAvgHoldDays(trades: Trade[]): number {
        if (!trades.length) return 0;
        const avgHoldSec =
            trades.reduce((sum, t) => sum + t.holdTimeSec, 0) / trades.length;
        return avgHoldSec / 86400;
    }

    private computeTradesPerWeek(trades: Trade[]): number {
        if (!trades.length) return 0;
        if (trades.length === 1) return 1;

        const first = trades[0].buyTimestamp;
        const last = trades[trades.length - 1].sellTimestamp;
        const spanMs = Math.max(last - first, 1);
        const activeWeeks = Math.max(spanMs / (7 * 24 * 60 * 60 * 1000), 1);

        return trades.length / activeWeeks;
    }

    private computeConsistencyScore(trades: Trade[]): number {
        if (trades.length < 2) return 60;

        const holds = trades.map((t) => t.holdTimeSec / 86400);
        const mean = holds.reduce((a, b) => a + b, 0) / holds.length;
        if (mean <= 0) return 0;

        const variance =
            holds.reduce((sum, h) => sum + (h - mean) ** 2, 0) / holds.length;
        const stdDev = Math.sqrt(variance);
        const cv = stdDev / mean; // coefficient of variation

        // lower CV => more consistent => higher score
        return this.clamp(100 - cv * 100, 0, 100);
    }

    // -----------------------------
    // Step 5: behavior classification
    // -----------------------------
    private computeBehavior(trades: Trade[], tradesPerWeek: number): BehaviorBreakdown {
        if (!trades.length) {
            return {
                swingTrader: 0,
                whaleFollower: 0,
                longTermHolder: 0,
                degen: 0,
            };
        }

        const total = trades.length;
        const holdDays = trades.map((t) => t.holdTimeSec / 86400);

        const swingCount = holdDays.filter((d) => d < 7).length;
        const longTermCount = holdDays.filter((d) => d > 30).length;
        const shortTermCount = holdDays.filter((d) => d <= 2).length;

        const swingRatio = swingCount / total; // 0..1
        const longTermRatio = longTermCount / total; // 0..1
        const shortTermRatio = shortTermCount / total; // 0..1
        const freqFactor = this.clamp(tradesPerWeek / 20, 0, 1); // 20+ => max

        // Raw intensities
        const rawSwing = swingRatio * 100;
        const rawLong = longTermRatio * 100;
        const rawDegen = this.clamp(tradesPerWeek / 25, 0, 1) * 100;
        const rawWhale = shortTermRatio * freqFactor * 100;

        // Normalize into 0..100 distribution
        const normalized = this.normalizePercentages([
            rawSwing,
            rawWhale,
            rawLong,
            rawDegen,
        ]);

        return {
            swingTrader: normalized[0],
            whaleFollower: normalized[1],
            longTermHolder: normalized[2],
            degen: normalized[3],
        };
    }

    // -----------------------------
    // Step 6: risk exposure
    // -----------------------------
    private async computeRiskExposure(address: string): Promise<RiskExposure> {
        const holdings = await this.fetchCurrentHoldingsWithValue(address);

        if (!holdings.length) {
            return { L1: 0, DeFi: 0, Memes: 0, Stables: 0 };
        }

        const totals = {
            L1: 0,
            DeFi: 0,
            Memes: 0,
            Stables: 0,
        };

        for (const h of holdings) {
            const bucket = this.classifyTokenRiskBucket(h.symbol);
            if (!bucket) continue;
            totals[bucket] += h.valueUsd;
        }

        const sum = totals.L1 + totals.DeFi + totals.Memes + totals.Stables;
        if (sum <= 0) {
            return { L1: 0, DeFi: 0, Memes: 0, Stables: 0 };
        }

        return {
            L1: this.round2((totals.L1 / sum) * 100),
            DeFi: this.round2((totals.DeFi / sum) * 100),
            Memes: this.round2((totals.Memes / sum) * 100),
            Stables: this.round2((totals.Stables / sum) * 100),
        };
    }

    private classifyTokenRiskBucket(symbol: string): keyof RiskExposure | null {
        const s = symbol.toUpperCase();

        const L1 = new Set(['ETH', 'BTC', 'WBTC', 'SOL', 'ARB']);
        const DeFi = new Set(['UNI', 'AAVE', 'MKR', 'CRV', 'COMP', 'SUSHI', 'LDO']);
        const Memes = new Set(['DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK']);
        const Stables = new Set(['USDC', 'USDT', 'DAI', 'FDUSD', 'TUSD']);

        if (L1.has(s)) return 'L1';
        if (DeFi.has(s)) return 'DeFi';
        if (Memes.has(s)) return 'Memes';
        if (Stables.has(s)) return 'Stables';

        // Unknown tokens ignored for MVP risk bucket split
        return null;
    }

    private async fetchCurrentHoldingsWithValue(
        address: string,
    ): Promise<Array<{ symbol: string; valueUsd: number }>> {
        const alchemy = this.web3Service.alchemy;

        const balances = await alchemy.core.getTokenBalances(address);
        const nonZero = balances.tokenBalances.filter(
            (t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x',
        );

        const metadataList = await Promise.all(
            nonZero.map(async (t) => {
                try {
                    return await alchemy.core.getTokenMetadata(t.contractAddress);
                } catch (err) {
                    console.log("⚠️ Metadata fetch failed for:", t.contractAddress);
                    return {
                        symbol: 'UNKNOWN',
                        decimals: 18,
                        name: 'Unknown Token',
                    };
                }
            }),
        );

        const symbols = metadataList.map((m) => String(m.symbol ?? 'UNKNOWN').toUpperCase());

        // Add ETH explicitly
        const ethWei = await alchemy.core.getBalance(address);
        const ethQty = Number(ethWei) / 1e18;
        if (ethQty > 0) symbols.push('ETH');

        const priceMap = await this.priceService.getPrices(symbols);

        const rows: Array<{ symbol: string; valueUsd: number }> = [];

        for (let i = 0; i < nonZero.length; i++) {
            const t = nonZero[i];
            const m = metadataList[i];
            const symbol =
                m?.symbol && m.symbol !== 'UNKNOWN'
                    ? m.symbol.toUpperCase()
                    : 'UNKNOWN';
            const decimals = m.decimals ?? 18;

            const qty = this.formatUnits(t.tokenBalance ?? '0x0', decimals);
            if (qty <= 0) continue;

            const price = priceMap[symbol] ?? 0;
            const valueUsd = qty * price;
            if (valueUsd <= 0) continue;

            rows.push({ symbol, valueUsd });
        }

        if (ethQty > 0) {
            const ethPrice = priceMap.ETH ?? 0;
            const ethValue = ethQty * ethPrice;
            if (ethValue > 0) rows.push({ symbol: 'ETH', valueUsd: ethValue });
        }

        return rows;
    }

    // -----------------------------
    // Pricing + utils
    // -----------------------------
    private formatUnits(raw: string, decimals: number): number {
        const value = BigInt(raw || '0x0');
        const base = 10 ** Math.min(decimals, 18);
        const normalized = Number(value) / base / 10 ** Math.max(decimals - 18, 0);
        return Number.isFinite(normalized) ? normalized : 0;
    }

    private symbolToCoinId(symbol: string): string | null {
        const map: Record<string, string> = {
            ETH: 'ethereum',
            BTC: 'bitcoin',
            WBTC: 'wrapped-bitcoin',
            SOL: 'solana',
            ARB: 'arbitrum',
            USDC: 'usd-coin',
            USDT: 'tether',
            DAI: 'dai',
            UNI: 'uniswap',
            AAVE: 'aave',
            DOGE: 'dogecoin',
            SHIB: 'shiba-inu',
            PEPE: 'pepe',
        };
        return map[symbol.toUpperCase()] ?? null;
    }

    private async getPricesUsd(symbols: string[]): Promise<Record<string, number>> {
        const baseUrl = process.env.COINGECKO_BASE_URL;
        const apiKey = process.env.COINGECKO_API_KEY;
        if (!baseUrl || !apiKey) return {};

        const uniqueSymbols = [...new Set(symbols.map((s) => s.toUpperCase()))];
        const coinIds = uniqueSymbols
            .map((s) => this.symbolToCoinId(s))
            .filter((x): x is string => Boolean(x));

        if (!coinIds.length) return {};

        const res = await fetch(
            `${baseUrl}/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd`,
            {
                headers: {
                    'x_cg_demo_api_key': apiKey,
                },
            },
        );

        if (!res.ok) return {};
        const json = await res.json();

        const out: Record<string, number> = {};
        for (const symbol of uniqueSymbols) {
            const id = this.symbolToCoinId(symbol);
            if (!id) continue;
            const price = json?.[id]?.usd;
            if (typeof price === 'number') out[symbol] = price;
        }

        return out;
    }

    private normalizePercentages(values: number[]): number[] {
        const total = values.reduce((a, b) => a + b, 0);
        if (total <= 0) return values.map(() => 0);
        return values.map((v) => this.round2((v / total) * 100));
    }

    private round2(n: number): number {
        return Number(n.toFixed(2));
    }

    private clamp(n: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, n));
    }

    private async set(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }

    private async get<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
    }

    private handleServiceError(error: unknown, context: string): never {
        if (error instanceof HttpException) throw error;
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`${context} failed: ${message}`, error instanceof Error ? error.stack : undefined);
        throw new InternalServerErrorException(`${context} failed`);
    }
}