import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../database/entities/user.entity';
import { Web3Module } from '../../config/web3.module';

import { WalletIntelligenceModule } from '../wallet-intelligence/wallet-intelligence.module';
import { WalletRecommendationsModule } from '../wallet-recommendations/wallet-recommendations.module';
import { OnchainModule } from '../onchain/onchain.module';

import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { AuthModule } from '../auth/auth.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.register({}),
    AuthModule,
    Web3Module,
    WalletIntelligenceModule,
    WalletRecommendationsModule,
    OnchainModule,
  ],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}