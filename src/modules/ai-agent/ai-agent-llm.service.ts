import { Injectable, Logger } from '@nestjs/common';
import { AgentContextSnapshot, SuggestedTrade } from './types/ai-agent.types';

@Injectable()
export class AiAgentLlmService {
    private readonly logger = new Logger(AiAgentLlmService.name);

    async explainInitQuestion(context: AgentContextSnapshot, question: string): Promise<string> {
        const prompt = this.buildInitPrompt(context, question);
        return this.callLlm(prompt, question);
    }

    async explainSuggestion(
        context: AgentContextSnapshot,
        suggestion: SuggestedTrade,
    ): Promise<string> {
        const prompt = this.buildSuggestionPrompt(context, suggestion);
        const fallback = this.buildSuggestionFallback(suggestion);
        return this.callLlm(prompt, fallback);
    }

    private buildInitPrompt(ctx: AgentContextSnapshot, question: string): string {
        return `
You are a friendly crypto trading assistant. The user's wallet has:
- Stablecoins: ${ctx.stablePercent.toFixed(0)}%
- L1 assets (ETH/BTC): ${ctx.l1Percent.toFixed(0)}%
- Alt tokens: ${ctx.altPercent.toFixed(0)}%
- Risk score: ${ctx.riskScore}/10
- Wallet level: ${ctx.walletLevel}

Rephrase this question naturally in 1-2 sentences. Keep it friendly and wallet-specific.
Question: "${question}"
Do NOT add trade suggestions yet. Just ask the question.
`.trim();
    }

    private buildSuggestionPrompt(ctx: AgentContextSnapshot, trade: SuggestedTrade): string {
        return `
You are a crypto trading assistant explaining a trade suggestion. Be concise (2-3 sentences), mention the risk clearly, and NEVER suggest the user should execute immediately.

Trade: Swap ${trade.amountPercent}% of ${trade.tokenIn} → ${trade.tokenOut}
User context: ${ctx.walletLevel} wallet, risk score ${ctx.riskScore}/10, ${ctx.stablePercent.toFixed(0)}% stables

Explain why this trade fits their situation and what the risk is. End with: "Would you like to proceed, modify, or cancel?"
`.trim();
    }

    private buildSuggestionFallback(trade: SuggestedTrade): string {
        return (
            `Based on your portfolio, I suggest swapping ${trade.amountPercent}% of your ${trade.tokenIn} into ${trade.tokenOut}. ` +
            `This is a moderate move — please review before deciding. Would you like to proceed, modify, or cancel?`
        );
    }

    private async callLlm(prompt: string, fallback: string): Promise<string> {
        const apiKey = process.env.OPENAI_API_KEY;

        if (!apiKey) return fallback;

        try {
            const response = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'gpt-4.1-mini',
                    input: prompt,
                    temperature: 0.4,
                }),
            });


            if (!response.ok) return fallback;

            const data = await response.json();
            const text = data?.output?.[0]?.content?.[0]?.text;

            return text?.trim() || fallback;
        } catch (err) {
            this.logger.warn('LLM call failed, using fallback');
            return fallback;
        }
    }
}