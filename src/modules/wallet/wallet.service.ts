import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { User, UserLevel } from 'src/database/entities/user.entity';

@Injectable()
export class WalletService {
    constructor(
        @InjectRepository(User)
        private readonly userRepository: Repository<User>,
        private readonly jwtService: JwtService,
    ) { }

    async analyzeWallet(walletAddress: string) {
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
    }
}