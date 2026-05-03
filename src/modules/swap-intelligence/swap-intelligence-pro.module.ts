import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { SwapIntelligenceProService } from './swap-intelligence-pro.service';
import { SwapIntelligenceProController } from './swap-intelligence-pro.controller';
import { AgentMemory } from 'src/database/entities/agent-memory.entity';
import { OnchainModule } from '../onchain/onchain.module';
import { WalletIntelligenceModule } from '../wallet-intelligence/wallet-intelligence.module';
import { AuthModule } from '../auth/auth.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([AgentMemory]),
        JwtModule.register({}),
        AuthModule,
        OnchainModule,
        WalletModule,
        WalletIntelligenceModule,
    ],
    controllers: [SwapIntelligenceProController],
    providers: [SwapIntelligenceProService],
})
export class SwapIntelligenceProModule {}