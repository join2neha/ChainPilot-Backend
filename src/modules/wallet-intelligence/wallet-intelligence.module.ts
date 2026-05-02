import { Module } from '@nestjs/common';
import { WalletIntelligenceController } from './wallet-intelligence.controller';
import { WalletIntelligenceService } from './wallet-intelligence.service';
import { User } from 'src/database/entities/user.entity';
import { WalletAnalysis } from 'src/database/entities/wallet-analysis.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { Web3Module } from 'src/config/web3.module';

@Module({
  imports: [
      TypeOrmModule.forFeature([User, WalletAnalysis]),
      JwtModule.register({}),
      AuthModule,
      Web3Module
    ],
  controllers: [WalletIntelligenceController],
  providers: [WalletIntelligenceService],
  exports: [WalletIntelligenceService],
})
export class WalletIntelligenceModule {}
