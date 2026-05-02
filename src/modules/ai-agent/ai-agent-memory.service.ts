import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import { DecisionMemory, AgentSession } from './types/ai-agent.types';
import { AgentMemory } from 'src/database/entities/agent-memory.entity';

@Injectable()
export class AiAgentMemoryService {
    private readonly logger = new Logger(AiAgentMemoryService.name);

    private readonly indexer: Indexer;
    private readonly signer: ethers.Wallet;
    private readonly rpcUrl: string;

    constructor(
        @InjectRepository(AgentMemory)
        private readonly agentMemoryRepo: Repository<AgentMemory>,
    ) {
        this.rpcUrl = process.env.ZG_RPC_URL!;
        const provider = new ethers.JsonRpcProvider(this.rpcUrl);
        this.signer = new ethers.Wallet(process.env.ZG_PRIVATE_KEY!, provider);
        this.indexer = new Indexer(process.env.ZG_INDEXER_RPC!);
    }

    async storeDecisionMemory(userId: string, session: AgentSession): Promise<void> {
        const memory: DecisionMemory = {
            userId,
            decision: session.suggestedTrade,
            goal: session.goal,
            timestamp: Date.now(),
            contextSnapshot: session.contextSnapshot,
        };

        try {
            const encoded = new TextEncoder().encode(JSON.stringify(memory));
            const file = new MemData(encoded);

            const [rootHash, err] = await this.indexer.upload(file, this.rpcUrl, this.signer);
            if (err) throw err;

            this.logger.log(`[0G] Memory stored for ${userId} | rootHash: ${JSON.stringify(rootHash)}`);

            if ('txHash' in rootHash) {
                await this.agentMemoryRepo.save({
                    userId,
                    txHash: rootHash.txHash,
                    rootHash: rootHash.rootHash,
                    txSeq: rootHash.txSeq,
                    exploreUrl: `https://chainscan-galileo.0g.ai/tx/${rootHash.txHash}`,
                    goal: session.goal ?? null,
                    decision: session.suggestedTrade ?? null,
                    contextSnapshot: session.contextSnapshot ?? null,
                });
                this.logger.log(`[0G] Memory record saved to DB for ${userId}`);
            }
        } catch (error) {
            this.logger.error(`[0G] Failed to store memory for ${userId}: ${error}`);
        }
    }
}