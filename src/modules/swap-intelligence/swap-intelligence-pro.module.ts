import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { SwapIntelligenceProService } from './swap-intelligence-pro.service';
import { SwapIntelligenceProController } from './swap-intelligence-pro.controller';
import { AgentMemory } from 'src/database/entities/agent-memory.entity';
import { User } from 'src/database/entities/user.entity';
import { OnchainModule } from '../onchain/onchain.module';
import { AuthModule } from '../auth/auth.module';
import { Web3Module } from 'src/config/web3.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([AgentMemory, User]),
        JwtModule.register({}),
        AuthModule,
        OnchainModule,
        Web3Module,
    ],
    controllers: [SwapIntelligenceProController],
    providers: [SwapIntelligenceProService],
})
export class SwapIntelligenceProModule {}