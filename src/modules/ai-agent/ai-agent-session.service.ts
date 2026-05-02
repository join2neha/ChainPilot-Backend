import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { AgentSession, AgentStep } from './types/ai-agent.types';

const SESSION_TTL_SECONDS = 15 * 60; // 15 minutes
const SESSION_KEY = (userId: string) => `agent:session:${userId}`;

@Injectable()
export class AiAgentSessionService {
    private readonly logger = new Logger(AiAgentSessionService.name);

    constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) { }

    async getSession(userId: string): Promise<AgentSession | null> {
        const raw = await this.redis.get(SESSION_KEY(userId));
        if (!raw) return null;
        try {
            return JSON.parse(raw) as AgentSession;
        } catch {
            this.logger.warn(`Corrupt session for ${userId}, resetting`);
            await this.clearSession(userId);
            return null;
        }
    }

    async saveSession(session: AgentSession): Promise<void> {
        const updated: AgentSession = { ...session, updatedAt: Date.now() };
        await this.redis.set(
            SESSION_KEY(session.userId),
            JSON.stringify(updated),
            'EX',
            SESSION_TTL_SECONDS,
        );
    }

    async clearSession(userId: string): Promise<void> {
        await this.redis.del(SESSION_KEY(userId));
    }

    createInitSession(userId: string): AgentSession {
        return {
            userId,
            step: 'INIT',
            updatedAt: Date.now(),
        };
    }

    advanceTo(session: AgentSession, step: AgentStep): AgentSession {
        return { ...session, step, updatedAt: Date.now() };
    }
}