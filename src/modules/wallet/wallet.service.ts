import { HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User, UserLevel } from 'src/database/entities/user.entity';
import { alchemy } from 'src/config/web3.config';
import { AssetTransfersCategory } from 'src/common/constants/constants';

@Injectable()
export class WalletService {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        private readonly jwtService: JwtService,
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

    async analyzeWalletDetails(userId: string) {
        try {
            const user = await this.userRepository.findOne({ where: { id: userId } });
            if (!user) {
                throw new NotFoundException('User not found');
            }

            const address = user.walletAddress.toLowerCase();

            // 1. Fetch transaction history
            const [incoming, outgoing] = await Promise.all([
                alchemy.core.getAssetTransfers({
                    fromBlock: "0x0",
                    toAddress: address,
                    category: [
                        AssetTransfersCategory.EXTERNAL,
                        AssetTransfersCategory.ERC20,
                    ],
                    withMetadata: true,
                    excludeZeroValue: true,
                    maxCount: 100,
                }),

                alchemy.core.getAssetTransfers({
                    fromBlock: "0x0",
                    fromAddress: address,
                    category: [
                        AssetTransfersCategory.EXTERNAL,
                        AssetTransfersCategory.ERC20,
                    ],
                    withMetadata: true,
                    excludeZeroValue: true,
                    maxCount: 100,
                }),
            ]);

            const transfers = [
                ...incoming.transfers.map(t => ({ ...t, type: "IN" })),
                ...outgoing.transfers.map(t => ({ ...t, type: "OUT" })),
            ];

            const totalTransactions = transfers.length;

            // 2. Fetch token balances
            const balances = await alchemy.core.getTokenBalances(address);

            const nonZeroTokens = balances.tokenBalances.filter(
                (t) => t.tokenBalance !== "0x0"
            );

            const uniqueTokens = nonZeroTokens.length;

            // 3. Classify user
            const level = this.classifyUser(totalTransactions, uniqueTokens);

            // 4. Generate insight (important for AI feel)
            const insight = this.generateInsight(totalTransactions, uniqueTokens);

            return {
                success: true,
                data: {
                    walletAddress: address,
                    metrics: {
                        totalTransactions,
                        uniqueTokens,
                    },
                    level,
                    insight,
                },
            };
        } catch (error) {
            this.handleServiceError(error, 'Analyze wallet');
        }
    }

    private classifyUser(txns: number, tokens: number): string {
        if (txns < 20 && tokens <= 2) return 'BEGINNER';
        if (txns < 100) return 'INTERMEDIATE';
        return 'ADVANCED';
    }

    private generateInsight(txns: number, tokens: number): string {
        if (txns < 20) {
            return "Low on-chain activity detected — user is likely new to crypto.";
        }

        if (txns < 100) {
            return "Moderate activity with some diversification across tokens.";
        }

        return "High activity wallet with strong on-chain presence.";
    }
}