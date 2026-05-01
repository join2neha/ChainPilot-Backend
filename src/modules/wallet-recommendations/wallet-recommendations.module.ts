import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { WalletIntelligenceModule } from '../wallet-intelligence/wallet-intelligence.module';
import { WalletRecommendationsController } from './wallet-recommendations.controller';
import { WalletRecommendationsService } from './wallet-recommendations.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { Web3Module } from 'src/config/web3.module';
import { WalletAnalysis } from 'src/database/entities/wallet-analysis.entity';
import { User } from 'src/database/entities/user.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([User, WalletAnalysis]),
        JwtModule.register({}),
        AuthModule,
        Web3Module,
        WalletModule,
        WalletIntelligenceModule
    ],
    controllers: [WalletRecommendationsController],
    providers: [WalletRecommendationsService],
    exports: [WalletRecommendationsService],
})
export class WalletRecommendationsModule { }