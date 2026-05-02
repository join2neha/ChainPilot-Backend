import { Injectable, Logger } from '@nestjs/common';
import { DecisionMemory, AgentSession } from './types/ai-agent.types';

@Injectable()
export class AiAgentMemoryService {
    private readonly logger = new Logger(AiAgentMemoryService.name);

    /**
     * Stores the final decision context for future recall.
     * Currently a placeholder — replace the body with the 0G SDK call when ready.
     * The shape of DecisionMemory is intentionally 0G-compatible.
     */
    async storeDecisionMemory(userId: string, session: AgentSession): Promise<void> {
        const memory: DecisionMemory = {
            userId,
            decision: session.suggestedTrade,
            goal: session.goal,
            timestamp: Date.now(),
            contextSnapshot: session.contextSnapshot,
        };

        // TODO: Replace this with 0G SDK storage call, e.g.:
        // await this.zgClient.store(memory);
        this.logger.log(`[0G-READY] Decision memory stored for ${userId}: ${JSON.stringify(memory)}`);
    }
}