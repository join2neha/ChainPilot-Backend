import { HttpException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import Redis from 'ioredis';

type InsightCard = {
    symbol: string;
    name: string;
    priceUsd: number;
    change24hPercent: number;
    rsi: number;
    sparkline: number[];
};

type RecommendationAction = 'BUY' | 'SELL' | 'HOLD';

type Recommendation = {
    action: RecommendationAction;
    symbol: string;
    timeframe: '1h';
    confidence: number;
    reason: string;
    source: 'RULES' | 'GPT';
};

type HeroToken = {
    symbol: string;
    priceUsd: number;
    change24hPercent: number;
    rsi: number;
};

@Injectable()
export class MarketService {
    private readonly logger = new Logger(MarketService.name);

    constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) { }

    // ----------------------------
    // Redis helpers
    // ----------------------------
    private async set(key: string, value: any, ttl = 60) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    }

    private async get<T>(key: string): Promise<T | null> {
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
    }

    private handleServiceError(error: unknown, context: string): never {
        if (error instanceof HttpException) {
            throw error;
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`${context} failed: ${message}`, error instanceof Error ? error.stack : undefined);

        throw new InternalServerErrorException(`${context} failed`);
    }

    // ----------------------------
    // Technical helpers
    // ----------------------------
    private clamp(value: number, min: number, max: number) {
        return Math.max(min, Math.min(max, value));
    }

    private calculateRsiFromSeries(series: number[], period = 14): number {
        if (!series || series.length < period + 1) return 50;

        let gains = 0;
        let losses = 0;

        for (let i = series.length - period; i < series.length; i++) {
            const diff = series[i] - series[i - 1];
            if (diff >= 0) gains += diff;
            else losses += Math.abs(diff);
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        const rsi = 100 - 100 / (1 + rs);

        return Number(rsi.toFixed(2));
    }

    // ----------------------------
    // Rule recommendation
    // ----------------------------
    private buildRuleRecommendation(cards: InsightCard[]): Recommendation {
        const scored = cards.map((c) => {
            const momentum = c.change24hPercent;
            const score = momentum - Math.max(c.rsi - 60, 0); // penalize overbought
            return { ...c, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const top = scored[0];

        let action: RecommendationAction = 'HOLD';
        let reason = 'Market signals are mixed.';

        if (top.rsi < 35 && top.change24hPercent > -2) {
            action = 'BUY';
            reason = `RSI is low (${top.rsi}) and momentum is stabilizing.`;
        } else if (top.rsi > 70 && top.change24hPercent < 0) {
            action = 'SELL';
            reason = `RSI is high (${top.rsi}) with weakening momentum.`;
        } else if (top.change24hPercent > 1) {
            action = 'BUY';
            reason = `Positive momentum is building on ${top.symbol}.`;
        }

        const confidenceBase = Math.min(
            Math.abs(top.change24hPercent) * 8 + (50 - Math.abs(top.rsi - 50)),
            95,
        );
        const confidence = Number(Math.max(55, confidenceBase).toFixed(0));

        return {
            action,
            symbol: top.symbol,
            timeframe: '1h',
            confidence,
            reason,
            source: 'RULES',
        };
    }

    private applySafetyGuardrails(
        draft: Recommendation,
        selectedCard?: InsightCard,
    ): Recommendation {
        let { action, confidence, reason } = draft;
        const rsi = selectedCard?.rsi ?? 50;

        // hard override guardrails
        if (rsi > 80 && action === 'BUY') {
            action = 'HOLD';
            reason = `Guardrail: RSI extremely high (${rsi}), avoid fresh BUY.`;
            confidence = Math.min(confidence, 70);
        }

        if (rsi < 20 && action === 'SELL') {
            action = 'HOLD';
            reason = `Guardrail: RSI extremely low (${rsi}), avoid panic SELL.`;
            confidence = Math.min(confidence, 70);
        }

        return {
            ...draft,
            action,
            confidence: this.clamp(Math.round(confidence), 35, 95),
            reason,
        };
    }

    // ----------------------------
    // GPT recommendation (optional)
    // ----------------------------
    private parseJsonObject(text: string): Record<string, any> | null {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return null;

        try {
            return JSON.parse(text.slice(start, end + 1));
        } catch {
            return null;
        }
    }

    private normalizeAction(value: unknown): RecommendationAction | null {
        if (typeof value !== 'string') return null;
        const v = value.toUpperCase();
        if (v === 'BUY' || v === 'SELL' || v === 'HOLD') return v;
        return null;
    }

    private async getGptRecommendation(
        cards: InsightCard[],
        fallback: Recommendation,
    ): Promise<Recommendation> {

        const apiKey = process.env.OPENAI_API_KEY?.trim();

        if (!apiKey) {
            this.logger.warn("OpenAI API key missing");
            return fallback;
        }

        const compactCards = cards.map((c) => ({
            symbol: c.symbol,
            priceUsd: c.priceUsd,
            change24hPercent: c.change24hPercent,
            rsi: c.rsi,
        }));

        const prompt = `You are a crypto signal assistant.
                Return ONLY valid JSON.

                Data: ${JSON.stringify(compactCards)}

                Return:
                    {
                        "action": "BUY|SELL|HOLD",
                        "symbol": "TOKEN",
                        "timeframe": "1h",
                        "confidence": 75,
                        "reason": "short explanation"
                }`;

        try {
            const response = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'gpt-4.1',
                    input: prompt,
                }),
            });

            if (!response.ok) {
                const errText = await response.text();
                console.log("GPT ERROR:", errText);
                return fallback;
            }

            const data = await response.json();

            //correct parsing
            const text =
                data?.output?.[0]?.content?.[0]?.text ||
                data?.output_text ||
                '';

            if (!text) return fallback;

            const parsed = this.parseJsonObject(text);
            if (!parsed) return fallback;

            const action = this.normalizeAction(parsed.action);
            const symbol = String(parsed.symbol || '').toUpperCase();
            const reason = String(parsed.reason || '').trim();

            if (!action || !symbol || !reason) return fallback;

            return {
                action,
                symbol,
                timeframe: '1h',
                confidence: 70,
                reason,
                source: 'GPT',
            };

        } catch (error) {
            console.log("GPT EXCEPTION:", error);
            return fallback;
        }
    }

    // ----------------------------
    // Main API method
    // ----------------------------
    async getLiveInsights(forceRefresh = false) {
        const cacheKey = 'market:live-insights:v1';

        // 1) Return cache first
        if (!forceRefresh) {
            const cached = await this.get<any>(cacheKey);
            if (cached) {
                return { ...cached, cache: true };
            }
        }

        const baseUrl = process.env.COINGECKO_BASE_URL;
        const apiKey = process.env.COINGECKO_API_KEY;

        if (!baseUrl || !apiKey) {
            throw new InternalServerErrorException('CoinGecko env config is missing');
        }

        // 2) Fetch market cards
        const ids = ['ethereum', 'bitcoin', 'solana', 'arbitrum'];

        const url =
            `${baseUrl}/coins/markets` +
            `?vs_currency=usd` +
            `&ids=${ids.join(',')}` +
            `&order=market_cap_desc` +
            `&per_page=4&page=1` +
            `&sparkline=true` +
            `&price_change_percentage=24h`;

        const res = await fetch(url, {
            method: 'GET',
            headers: {
                'x_cg_demo_api_key': apiKey,
            },
        });

        if (!res.ok) {
            const txt = await res.text();
            this.logger.error(`CoinGecko markets API failed: ${res.status} ${txt}`);
            throw new InternalServerErrorException('Failed to fetch live market insights');
        }

        const json = await res.json();

        const cards: InsightCard[] = (json || []).map((coin: any) => {
            const sparkline: number[] = coin?.sparkline_in_7d?.price?.slice(-30) ?? [];
            return {
                symbol: String(coin.symbol || '').toUpperCase(),
                name: coin.name ?? 'Unknown',
                priceUsd: Number((coin.current_price ?? 0).toFixed(2)),
                change24hPercent: Number((coin.price_change_percentage_24h ?? 0).toFixed(2)),
                rsi: this.calculateRsiFromSeries(sparkline, 14),
                sparkline: sparkline.map((n) => Number(Number(n).toFixed(2))),
            };
        });

        if (!cards.length) {
            throw new InternalServerErrorException('No market data available');
        }

        // 3) Rule recommendation as baseline + guardrails
        const ruleRecommendation = this.buildRuleRecommendation(cards);
        const guardedRuleRecommendation = this.applySafetyGuardrails(
            ruleRecommendation,
            cards.find((c) => c.symbol === ruleRecommendation.symbol),
        );

        // 4) GPT recommendation with fallback
        const recommendation = await this.getGptRecommendation(cards, guardedRuleRecommendation);

        const result = {
            success: true,
            data: {
                updatedAt: new Date().toISOString(),
                cards,
                recommendation,
            },
            cache: false,
        };

        // 5) Cache result (60s TTL)
        await this.set(cacheKey, result, 60);

        return result;
    }

    private buildHeroRecommendation(tokens: HeroToken[]) {
        const scored = tokens.map((t) => {
            const momentumNorm = Math.max(0, Math.min(1, (t.change24hPercent + 10) / 20)); // -10..10 -> 0..1
            const rsiQuality = 1 - Math.abs(t.rsi - 50) / 50; // 0..1
            const score = 0.7 * momentumNorm + 0.3 * rsiQuality;
            return { ...t, score };
        });
        scored.sort((a, b) => b.score - a.score);
        const top = scored[0];
        let action: 'BUY' | 'HOLD' | 'SELL' = 'HOLD';
        if (top.score >= 0.65) action = 'BUY';
        else if (top.score <= 0.35) action = 'SELL';
        // Guardrails
        if (top.rsi > 80 && action === 'BUY') action = 'HOLD';
        if (top.rsi < 20 && action === 'SELL') action = 'HOLD';
        const confidence = Math.round(55 + Math.abs(top.score - 0.5) * 90); // 55..100
        return {
            token: top.symbol,
            action,
            confidence: Math.max(55, Math.min(95, confidence)),
            rsi: Number(top.rsi.toFixed(2)),
            priceUsd: Number(top.priceUsd.toFixed(2)),
            change24hPercent: Number(top.change24hPercent.toFixed(2)),
            reason:
                action === 'BUY'
                    ? `${top.symbol} shows positive momentum with healthy RSI.`
                    : action === 'SELL'
                        ? `${top.symbol} appears weak relative to current momentum/RSI setup.`
                        : `${top.symbol} is in a neutral zone; waiting is safer now.`,
        };
    }

    async getHeroRecommendation(forceRefresh = false) {
        try {
            const cacheKey = 'market:hero-recommendation:v1';
            if (!forceRefresh) {
                const cached = await this.get<any>(cacheKey);
                if (cached) return { ...cached, cache: true };
            }
            const baseUrl = process.env.COINGECKO_BASE_URL;
            const apiKey = process.env.COINGECKO_API_KEY;
            if (!baseUrl || !apiKey) {
                throw new InternalServerErrorException('CoinGecko env config is missing');
            }
            const ids = ['ethereum', 'bitcoin', 'solana', 'arbitrum'];
            const url =
                `${baseUrl}/coins/markets` +
                `?vs_currency=usd` +
                `&ids=${ids.join(',')}` +
                `&order=market_cap_desc&per_page=4&page=1` +
                `&sparkline=true&price_change_percentage=24h`;
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'x_cg_demo_api_key': apiKey },
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new InternalServerErrorException(`Failed to fetch market data: ${res.status} ${txt}`);
            }
            const json = await res.json();
            const tokens: HeroToken[] = (json || []).map((coin: any) => {
                const sparkline: number[] = coin?.sparkline_in_7d?.price?.slice(-30) ?? [];
                return {
                    symbol: String(coin.symbol || '').toUpperCase(),
                    priceUsd: Number(coin.current_price ?? 0),
                    change24hPercent: Number(coin.price_change_percentage_24h ?? 0),
                    rsi: this.calculateRsiFromSeries(sparkline, 14),
                };
            });
            if (!tokens.length) {
                throw new InternalServerErrorException('No market data available');
            }
            const recommendation = this.buildHeroRecommendation(tokens);
            const result = {
                success: true,
                data: {
                    updatedAt: new Date().toISOString(),
                    recommendation,
                },
                cache: false,
            };
            await this.set(cacheKey, result, 60); // 60s cache
            return result;
        } catch (error) {
            this.handleServiceError(error, 'Get global market data');
        }
    }
}