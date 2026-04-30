import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { WalletAnalysis } from 'src/database/entities/wallet-analysis.entity';
import { LlmService } from './llm.service';

@Module({
  imports: [TypeOrmModule.forFeature([WalletAnalysis])],
  controllers: [AgentController],
  providers: [AgentService, LlmService],
  exports: [AgentService],
})
export class AgentModule {}