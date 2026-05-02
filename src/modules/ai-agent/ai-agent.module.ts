import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletAnalysis } from 'src/database/entities/wallet-analysis.entity';
import { WalletIntelligenceModule } from '../wallet-intelligence/wallet-intelligence.module';
import { AiAgentController } from './ai-agent.controller';
import { AiAgentService } from './ai-agent.service';
import { AiAgentSessionService } from './ai-agent-session.service';
import { AiAgentContextBuilder } from './ai-agent-context.builder';
import { AiAgentStepsService } from './ai-agent-steps.service';
import { AiAgentLlmService } from './ai-agent-llm.service';
import { AiAgentMemoryService } from './ai-agent-memory.service';
import { User } from 'src/database/entities/user.entity';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([User, WalletAnalysis]),
        JwtModule.register({}),
        AuthModule,
        WalletIntelligenceModule,
    ],
    controllers: [AiAgentController],
    providers: [
        AiAgentService,
        AiAgentSessionService,
        AiAgentContextBuilder,
        AiAgentStepsService,
        AiAgentLlmService,
        AiAgentMemoryService,
    ],
})
export class AiAgentModule { }