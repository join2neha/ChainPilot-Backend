import { Injectable, Logger } from '@nestjs/common';
import {
    AgentContextSnapshot,
    AgentGoal,
    AgentResponse,
    AgentSession,
    SuggestedTrade,
} from './types/ai-agent.types';

@Injectable()
export class AiAgentStepsService {
    private readonly logger = new Logger(AiAgentStepsService.name);

    // ─── INIT ──────────────────────────────────────────────────────────────────

    handleInit(
        session: AgentSession,
        context: AgentContextSnapshot,
        llmReply: string,
    ): { reply: string; nextSession: AgentSession } {
        const nextSession: AgentSession = { ...session, step: 'GOAL', contextSnapshot: context };
        return { reply: llmReply, nextSession };
    }

    buildInitQuestion(context: AgentContextSnapshot): string {
        if (context.stablePercent >= 70) {
            return `You're heavily in stablecoins (${context.stablePercent.toFixed(0)}% of portfolio). Want to increase returns by putting some of that to work?`;
        }
        if (context.altPercent >= 60) {
            return `You have significant exposure to alt tokens (${context.altPercent.toFixed(0)}% of portfolio). Would you like to reduce risk or explore further?`;
        }
        if (context.l1Percent >= 70) {
            return `Most of your portfolio is in L1 assets (${context.l1Percent.toFixed(0)}%). Are you looking to explore, grow, or reduce risk?`;
        }
        return `I've analyzed your wallet. You have a balanced portfolio. What's your current trading goal — increase returns, reduce risk, or explore options?`;
    }

    // ─── GOAL ──────────────────────────────────────────────────────────────────

    handleGoal(
        session: AgentSession,
        message: string,
    ): { reply: string; nextSession: AgentSession } | null {
        const goal = this.parseGoal(message);
        if (!goal) return null;

        const nextSession: AgentSession = { ...session, step: 'STRATEGY', goal };
        const reply = `Got it — your goal is to ${goal.replace('_', ' ')}. Let me build a strategy for you.`;
        return { reply, nextSession };
    }

    private parseGoal(message: string): AgentGoal | null {
        const lower = message.toLowerCase();
        if (lower.includes('return') || lower.includes('profit') || lower.includes('grow') || lower.includes('increase')) {
            return 'increase_returns';
        }
        if (lower.includes('risk') || lower.includes('safe') || lower.includes('stable') || lower.includes('reduce')) {
            return 'reduce_risk';
        }
        if (lower.includes('explore') || lower.includes('option') || lower.includes('diversif')) {
            return 'explore';
        }
        return null;
    }

    // ─── STRATEGY ──────────────────────────────────────────────────────────────

    handleStrategy(
        session: AgentSession,
        context: AgentContextSnapshot,
    ): { suggestedTrade: SuggestedTrade; nextSession: AgentSession } {
        const trade = this.generateTrade(session.goal!, context);
        const nextSession: AgentSession = { ...session, step: 'CONFIRM', suggestedTrade: trade };
        return { suggestedTrade: trade, nextSession };
    }

    private generateTrade(goal: AgentGoal, ctx: AgentContextSnapshot): SuggestedTrade {
        switch (goal) {
            case 'increase_returns':
                return this.tradeForReturns(ctx);
            case 'reduce_risk':
                return this.tradeForSafety(ctx);
            case 'explore':
                return this.tradeForExploration(ctx);
        }
    }

    private tradeForReturns(ctx: AgentContextSnapshot): SuggestedTrade {
        if (ctx.stablePercent >= 50) {
            return { tokenIn: 'USDC', tokenOut: 'ETH', amountPercent: 25 };
        }
        if (ctx.l1Percent >= 40) {
            return { tokenIn: 'ETH', tokenOut: 'BTC', amountPercent: 20 };
        }
        return { tokenIn: 'USDC', tokenOut: 'ETH', amountPercent: 20 };
    }

    private tradeForSafety(ctx: AgentContextSnapshot): SuggestedTrade {
        if (ctx.altPercent >= 40) {
            return { tokenIn: 'ETH', tokenOut: 'USDC', amountPercent: 30 };
        }
        if (ctx.l1Percent >= 60) {
            return { tokenIn: 'ETH', tokenOut: 'USDC', amountPercent: 20 };
        }
        return { tokenIn: 'ETH', tokenOut: 'USDC', amountPercent: 20 };
    }

    private tradeForExploration(ctx: AgentContextSnapshot): SuggestedTrade {
        if (ctx.stablePercent >= 30) {
            return { tokenIn: 'USDC', tokenOut: 'ETH', amountPercent: 15 };
        }
        return { tokenIn: 'ETH', tokenOut: 'BTC', amountPercent: 10 };
    }

    // ─── CONFIRM ───────────────────────────────────────────────────────────────

    buildConfirmResponse(session: AgentSession, llmExplanation: string): AgentResponse {
        return {
            success: true,
            data: {
                reply: llmExplanation,
                step: 'CONFIRM',
                actions: ['Proceed', 'Modify', 'Cancel'],
                trade: session.suggestedTrade,
            },
        };
    }

    // ─── COMPLETE ──────────────────────────────────────────────────────────────

    parseConfirmation(message: string): 'proceed' | 'cancel' | 'modify' {
        const lower = message.toLowerCase();
        if (lower.includes('proceed') || lower.includes('yes') || lower.includes('confirm') || lower.includes('ok')) {
            return 'proceed';
        }
        if (lower.includes('cancel') || lower.includes('no') || lower.includes('stop')) {
            return 'cancel';
        }
        return 'modify';
    }
}