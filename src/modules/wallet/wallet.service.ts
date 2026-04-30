import { HttpException, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User, UserLevel } from '../../database/entities/user.entity'
import { AssetTransfersCategory } from '../../common/constants/constants';
import { Web3Service } from '../../config/web3.service'
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

@Injectable()
export class WalletService {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        private readonly jwtService: JwtService,
        private readonly web3Service: Web3Service,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
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
                },
                wallet_level: walletLevel,
                insight,
                cache: false,
                generatedAt: new Date().toISOString(),
            };

            await this.set(cacheKey, result, 300);

            return result;
        } catch (error) {
            this.handleServiceError(error, 'Wallet analyze');
        }
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

                console.log("-----> errorText",errorText);

                console.log("-----> response", response);
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
            console.log("-----> error", error);
            this.handleServiceError(error, 'Get global market data');
        }
    }
}