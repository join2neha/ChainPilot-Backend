import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WalletAnalysis } from 'src/database/entities/wallet-analysis.entity';
import { WalletIntelligenceService } from '../wallet-intelligence/wallet-intelligence.service';
import { AgentContextSnapshot } from './types/ai-agent.types';

@Injectable()
export class AiAgentContextBuilder {
    private readonly logger = new Logger(AiAgentContextBuilder.name);

    constructor(
        @InjectRepository(WalletAnalysis)
        private readonly walletAnalysisRepo: Repository<WalletAnalysis>,
        private readonly walletIntelligenceService: WalletIntelligenceService,
    ) { }

    async buildContext(userId: string): Promise<AgentContextSnapshot> {
        const [analysis, intelligence] = await Promise.allSettled([
            this.loadLatestAnalysis(userId),
            this.walletIntelligenceService.getWalletIntelligence(userId),
        ]);

        const db = analysis.status === 'fulfilled' ? analysis.value : null;
        const intel = intelligence.status === 'fulfilled' ? intelligence.value : null;

        // Risk exposure from live wallet intelligence
        const riskExposure = intel?.data?.riskExposure ?? {
            L1: 0, DeFi: 0, Memes: 0, Stables: 0,
        };

        // Summarize into percentages (guardrail: use safe defaults on failure)
        return {
            stablePercent: riskExposure.Stables ?? 0,
            l1Percent: riskExposure.L1 ?? 0,
            altPercent: (riskExposure.DeFi ?? 0) + (riskExposure.Memes ?? 0),
            riskScore: Number(db?.riskScore ?? 5),
            walletLevel: db?.walletLevel ?? 'BEGINNER',
            behavior: db?.behaviorType ?? 'HOLDER',
            avgHoldDays: Number(db?.avgHoldTimeDays ?? 0),
        };
    }

    private async loadLatestAnalysis(userId: string): Promise<WalletAnalysis | null> {
        return this.walletAnalysisRepo.findOne({
            where: { userId },
            order: { createdAt: 'DESC' },
        });
    }
}