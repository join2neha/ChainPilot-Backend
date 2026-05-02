import { Injectable, Logger } from '@nestjs/common';
import { AiAgentSessionService } from './ai-agent-session.service';
import { AiAgentContextBuilder } from './ai-agent-context.builder';
import { AiAgentStepsService } from './ai-agent-steps.service';
import { AiAgentLlmService } from './ai-agent-llm.service';
import { AiAgentMemoryService } from './ai-agent-memory.service';
import { AgentResponse, AgentSession } from './types/ai-agent.types';

@Injectable()
export class AiAgentService {
    private readonly logger = new Logger(AiAgentService.name);

    constructor(
        private readonly sessionService: AiAgentSessionService,
        private readonly contextBuilder: AiAgentContextBuilder,
        private readonly stepsService: AiAgentStepsService,
        private readonly llmService: AiAgentLlmService,
        private readonly memoryService: AiAgentMemoryService,
    ) { }

    async handleMessage(userId: string, message: string): Promise<AgentResponse> {
        // Empty message restarts the flow
        if (!message.trim()) {
            await this.sessionService.clearSession(userId);
            this.logger.log(`[${userId}] Empty message — session reset`);
        }

        const session = await this.loadOrCreateSession(userId);
        this.logger.log(`[${userId}] Step: ${session.step} | Message: "${message}"`);

        return this.dispatch(session, message);
    }

    // ─── Session bootstrapping ─────────────────────────────────────────────────

    private async loadOrCreateSession(userId: string): Promise<AgentSession> {
        const existing = await this.sessionService.getSession(userId);
        if (existing) return existing;

        const fresh = this.sessionService.createInitSession(userId);
        await this.sessionService.saveSession(fresh);
        return fresh;
    }

    // ─── Step dispatcher ───────────────────────────────────────────────────────

    private async dispatch(session: AgentSession, message: string): Promise<AgentResponse> {
        switch (session.step) {
            case 'INIT': return this.runInit(session);
            case 'GOAL': return this.runGoal(session, message);
            case 'STRATEGY': return this.runStrategy(session);
            case 'CONFIRM': return this.runConfirm(session, message);
            case 'COMPLETE': return this.buildCompleteResponse(session);
            default: return this.handleInvalidStep(session);
        }
    }

    // ─── Step: INIT ────────────────────────────────────────────────────────────

    private async runInit(session: AgentSession): Promise<AgentResponse> {
        const context = await this.contextBuilder.buildContext(session.userId).catch((err) => {
            this.logger.error(`Context build failed for ${session.userId}: ${err.message}`);
            return null;
        });

        if (!context) {
            return this.errorResponse('Could not load your wallet data. Please try again in a moment.');
        }

        const rawQuestion = this.stepsService.buildInitQuestion(context);
        const llmReply = await this.llmService.explainInitQuestion(context, rawQuestion);

        const { reply, nextSession } = this.stepsService.handleInit(session, context, llmReply);
        await this.sessionService.saveSession(nextSession);

        return { success: true, data: { reply, step: 'GOAL' } };
    }

    // ─── Step: GOAL ────────────────────────────────────────────────────────────

    private async runGoal(session: AgentSession, message: string): Promise<AgentResponse> {
        const result = this.stepsService.handleGoal(session, message);

        if (!result) {
            return {
                success: true,
                data: {
                    reply: `I didn't quite catch that. Please tell me your goal: increase returns, reduce risk, or explore options?`,
                    step: 'GOAL',
                    actions: ['Increase returns', 'Reduce risk', 'Explore'],
                },
            };
        }

        await this.sessionService.saveSession(result.nextSession);

        // Immediately advance to strategy — no need for an extra round-trip
        return this.runStrategy(result.nextSession);
    }

    // ─── Step: STRATEGY ────────────────────────────────────────────────────────

    private async runStrategy(session: AgentSession): Promise<AgentResponse> {
        const context = session.contextSnapshot;
        if (!context) {
            return this.errorResponse('Session context is missing. Please restart the conversation.');
        }

        const { suggestedTrade, nextSession } = this.stepsService.handleStrategy(session, context);
        await this.sessionService.saveSession(nextSession);

        const llmExplanation = await this.llmService.explainSuggestion(context, suggestedTrade);

        return this.stepsService.buildConfirmResponse(nextSession, llmExplanation);
    }

    // ─── Step: CONFIRM ─────────────────────────────────────────────────────────

    private async runConfirm(session: AgentSession, message: string): Promise<AgentResponse> {
        const decision = this.stepsService.parseConfirmation(message);

        if (decision === 'proceed') {
            return this.runComplete(session);
        }

        if (decision === 'cancel') {
            await this.sessionService.clearSession(session.userId);
            return {
                success: true,
                data: { reply: `Understood — trade cancelled. Your session has been cleared. Come back anytime.`, step: 'COMPLETE' },
            };
        }

        // 'modify' — re-prompt goal
        const nextSession: AgentSession = { ...session, step: 'GOAL', suggestedTrade: undefined };
        await this.sessionService.saveSession(nextSession);
        return {
            success: true,
            data: {
                reply: `No problem. Let me know what you'd like to change — would you prefer to increase returns, reduce risk, or explore differently?`,
                step: 'GOAL',
                actions: ['Increase returns', 'Reduce risk', 'Explore'],
            },
        };
    }

    // ─── Step: COMPLETE ────────────────────────────────────────────────────────

    private async runComplete(session: AgentSession): Promise<AgentResponse> {
        const trade = session.suggestedTrade;

        await this.memoryService.storeDecisionMemory(session.userId, session);
        await this.sessionService.clearSession(session.userId);

        this.logger.log(`[${session.userId}] Trade decision recorded. Session cleared.`);

        return {
            success: true,
            data: {
                reply: `Your decision has been recorded. Trade details are ready below — share this with your execution layer when you're ready.`,
                step: 'COMPLETE',
                trade,
            },
        };
    }

    private buildCompleteResponse(session: AgentSession): AgentResponse {
        return {
            success: true,
            data: {
                reply: `This conversation is already complete. Start a new session to explore another trade.`,
                step: 'COMPLETE',
                trade: session.suggestedTrade,
            },
        };
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────

    private handleInvalidStep(session: AgentSession): AgentResponse {
        this.logger.warn(`[${session.userId}] Invalid step: ${session.step} — resetting`);
        void this.sessionService.clearSession(session.userId);
        return this.errorResponse('Session state was invalid. Please start over.');
    }

    private errorResponse(reply: string): AgentResponse {
        return { success: true, data: { reply, step: 'INIT' } };
    }
}