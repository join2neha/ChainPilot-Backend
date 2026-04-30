import { Injectable, Logger } from '@nestjs/common';
import { Decision } from './types';

@Injectable()
export class LlmService {
    private readonly logger = new Logger(LlmService.name);

    async formatResponseWithLLM(input: Decision | string): Promise<string> {
        
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            return typeof input === 'string'
                ? input
                : `${input.reasoning} Suggestion: ${input.suggestion}`;
        }

        const structuredText =
            typeof input === 'string'
                ? input
                : `Action: ${input.action}
                    Confidence: ${input.confidence}
                    Reasoning: ${input.reasoning}
                    Suggestion: ${input.suggestion}`;

        const prompt = `Convert the following structured crypto trading insight into a short, friendly, conversational explanation. Do NOT change the meaning or decision. ${structuredText}`;

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

            if (!response.ok) {
                const fallback =
                    typeof input === 'string'
                        ? input
                        : `${input.reasoning} Suggestion: ${input.suggestion}`;
                return fallback;
            }

            const data = (await response.json()) as {
                output_text?: string;
            };

            return data.output_text?.trim() || structuredText;
        } catch (error) {
            this.logger.warn('LLM formatting failed, falling back to plain response');
            return typeof input === 'string'
                ? input
                : `${input.reasoning} Suggestion: ${input.suggestion}`;
        }
    }
}