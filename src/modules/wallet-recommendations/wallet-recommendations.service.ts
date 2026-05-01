import {
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import Redis from 'ioredis';
import { WalletService } from '../wallet/wallet.service';
import { WalletIntelligenceService } from '../wallet-intelligence/wallet-intelligence.service';


type Priority = 'HIGH' | 'MEDIUM' | 'LOW';

type SignalType = 'RISK' | 'ALLOCATION' | 'REBALANCE' | 'POSITION';

type Signal = {
    type: SignalType;
    severity: Priority;
    message: string;
    action: string;
    confidence: number;
};

type Recommendation = {
    title: string;
    description: string;
    priority: Priority;
    confidence: number;
    action: string;
};

type PortfolioToken = {
    symbol: string;
    allocationPercent: number;
    currentValueUsd?: number;
};

type PortfolioData = {
    tokens: PortfolioToken[];
};

type IntelligenceData = {
    riskExposure?: {
        L1?: number;
        DeFi?: number;
        Memes?: number;
        Stables?: number;
    };
};

@Injectable()
export class WalletRecommendationsService {
    private readonly logger = new Logger(WalletRecommendationsService.name);
    private static readonly CACHE_TTL_SECONDS = 60;
    private static readonly MAX_RECOMMENDATIONS = 6;

    constructor(
        private readonly walletService: WalletService,
        private readonly walletIntelligenceService: WalletIntelligenceService,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
    ) { }

    async getRecommendations(userId: string) {
        try {
            const cacheKey = `wallet:recommendations:${userId}`;
            const cached = await this.get<any>(cacheKey);
            if (cached) return { ...cached, cache: true };

            const [portfolioRaw, intelligenceRaw] = await Promise.all([
                this.walletService.getPortfolioSummary(userId),
                this.walletIntelligenceService.getWalletIntelligence(userId),
            ]);

            const portfolio = this.extractPortfolio(portfolioRaw);
            const intelligence = this.extractIntelligence(intelligenceRaw);

            if (!portfolio.tokens.length) {
                const empty = {
                    success: true,
                    data: { recommendations: [] as Recommendation[] },
                    cache: false,
                };
                await this.set(cacheKey, empty, WalletRecommendationsService.CACHE_TTL_SECONDS);
                return empty;
            }

            const signals = this.generateSignals(portfolio, intelligence);
            const recommendations = this.mapSignals(signals);
            const enhanced = await this.getGptEnhancedRecommendations(recommendations);

            const result = {
                success: true,
                data: {
                    recommendations: enhanced.slice(0, WalletRecommendationsService.MAX_RECOMMENDATIONS),
                },
                cache: false,
            };

            await this.set(cacheKey, result, WalletRecommendationsService.CACHE_TTL_SECONDS);
            return result;
        } catch (error) {
            this.handleServiceError(error, 'Wallet recommendations');
        }
    }

    // -----------------------------
    // Signal Engine
    // -----------------------------
    private generateSignals(portfolio: PortfolioData, intelligence: IntelligenceData): Signal[] {
        const signals: Signal[] = [];
        const tokens = portfolio.tokens.filter((t) => (t.allocationPercent ?? 0) > 0);

        if (!tokens.length) return [];

        const risk = intelligence.riskExposure ?? {};
        const memes = risk.Memes ?? 0;
        const stables = risk.Stables ?? 0;

        // Risk: Memes > 10%
        if (memes > 10) {
            signals.push(
                this.makeSignal({
                    type: 'RISK',
                    severity: 'HIGH',
                    message: `Memecoin exposure is elevated at ${this.r2(memes)}%.`,
                    action: 'Reduce volatile allocation',
                    dataQuality: this.dataQuality(tokens),
                    signalStrength: this.strengthOverThreshold(memes, 10, 35),
                }),
            );
        }

        // Risk: Stables < 10%
        if (stables < 10) {
            signals.push(
                this.makeSignal({
                    type: 'RISK',
                    severity: 'MEDIUM',
                    message: `Defensive stablecoin allocation is low at ${this.r2(stables)}%.`,
                    action: 'Increase stable allocation',
                    dataQuality: this.dataQuality(tokens),
                    signalStrength: this.strengthBelowThreshold(stables, 10, 0),
                }),
            );
        }

        // Allocation: any single token > 40%
        const maxToken = this.maxByAllocation(tokens);
        if (maxToken && maxToken.allocationPercent > 40) {
            signals.push(
                this.makeSignal({
                    type: 'ALLOCATION',
                    severity: 'HIGH',
                    message: `${maxToken.symbol} represents ${this.r2(maxToken.allocationPercent)}% of portfolio.`,
                    action: `Reduce ${maxToken.symbol} concentration`,
                    dataQuality: this.dataQuality(tokens),
                    signalStrength: this.strengthOverThreshold(maxToken.allocationPercent, 40, 80),
                }),
            );
        }

        // Rebalance: ETH/BTC ratio outside [0.7, 1.5]
        const eth = this.getAllocation(tokens, 'ETH');
        const btc = this.getAllocation(tokens, 'BTC');
        if (eth > 0 && btc > 0) {
            const ratio = eth / btc;
            if (ratio > 1.5 || ratio < 0.7) {
                const deviation = ratio > 1.5 ? ratio - 1.5 : 0.7 - ratio;
                signals.push(
                    this.makeSignal({
                        type: 'REBALANCE',
                        severity: 'MEDIUM',
                        message: `ETH/BTC allocation ratio is ${this.r2(ratio)} (outside target band 0.7–1.5).`,
                        action: 'Rebalance ETH/BTC weights',
                        dataQuality: this.dataQuality(tokens),
                        signalStrength: this.clamp(deviation / 0.8, 0, 1),
                    }),
                );
            }
        }

        // Position: one token > 2x average allocation
        const avgAllocation =
            tokens.reduce((sum, t) => sum + t.allocationPercent, 0) / Math.max(tokens.length, 1);

        const oversized = tokens.find((t) => t.allocationPercent > avgAllocation * 2);
        if (oversized) {
            const strength = this.clamp(
                (oversized.allocationPercent - avgAllocation * 2) / Math.max(avgAllocation * 2, 1),
                0,
                1,
            );

            signals.push(
                this.makeSignal({
                    type: 'POSITION',
                    severity: 'LOW',
                    message: `${oversized.symbol} is oversized relative to average position size.`,
                    action: `Scale out ${oversized.symbol} gradually`,
                    dataQuality: this.dataQuality(tokens),
                    signalStrength: strength,
                }),
            );
        }

        return this.dedupeSignals(signals).slice(0, WalletRecommendationsService.MAX_RECOMMENDATIONS);
    }

    private makeSignal(input: {
        type: SignalType;
        severity: Priority;
        message: string;
        action: string;
        dataQuality: number;
        signalStrength: number;
    }): Signal {
        return {
            type: input.type,
            severity: input.severity,
            message: input.message,
            action: input.action,
            confidence: this.calculateConfidence(input.severity, input.dataQuality, input.signalStrength),
        };
    }

    private calculateConfidence(
        severity: Priority,
        dataQuality: number,
        signalStrength: number,
    ): number {
        const severityWeight = severity === 'HIGH' ? 1 : severity === 'MEDIUM' ? 0.7 : 0.5;
        const raw = severityWeight * 50 + dataQuality * 30 + signalStrength * 20;
        return Math.round(this.clamp(raw, 60, 95));
    }

    // -----------------------------
    // Signal -> Recommendation
    // -----------------------------
    private mapSignals(signals: Signal[]): Recommendation[] {
        return signals.map((s) => ({
            title: this.titleFromSignalType(s.type),
            description: s.message,
            priority: s.severity,
            confidence: s.confidence,
            action: s.action,
        }));
    }

    private titleFromSignalType(type: SignalType): string {
        if (type === 'RISK') return 'Risk Management Alert';
        if (type === 'ALLOCATION') return 'Allocation Concentration Alert';
        if (type === 'REBALANCE') return 'Rebalance Opportunity';
        return 'Position Sizing Insight';
    }

    // -----------------------------
    // GPT enhancement (optional)
    // -----------------------------
    private async getGptEnhancedRecommendations(
        recommendations: Recommendation[],
    ): Promise<Recommendation[]> {
        if (!recommendations.length) return recommendations;

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return recommendations;

        const prompt = [
            'Rewrite these crypto portfolio recommendations to sound more natural, actionable, and user-friendly.',
            'Do not change meaning, priority, action, or confidence.',
            'Return strict JSON array with same fields: title, description, priority, confidence, action.',
            JSON.stringify(recommendations),
        ].join('\n\n');

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
                    temperature: 0.3,
                }),
            });

            if (!response.ok) return recommendations;

            const data = (await response.json()) as { output_text?: string };
            const parsed = this.tryParseRecommendationArray(data.output_text ?? '');
            if (!parsed) return recommendations;

            return parsed.slice(0, WalletRecommendationsService.MAX_RECOMMENDATIONS);
        } catch {
            return recommendations;
        }
    }

    private tryParseRecommendationArray(text: string): Recommendation[] | null {
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start === -1 || end === -1 || end <= start) return null;

        try {
            const parsed = JSON.parse(text.slice(start, end + 1));
            if (!Array.isArray(parsed)) return null;

            const valid: Recommendation[] = [];
            for (const item of parsed) {
                const p = item?.priority;
                if (p !== 'HIGH' && p !== 'MEDIUM' && p !== 'LOW') continue;
                if (
                    typeof item?.title !== 'string' ||
                    typeof item?.description !== 'string' ||
                    typeof item?.action !== 'string'
                ) {
                    continue;
                }

                valid.push({
                    title: item.title.trim(),
                    description: item.description.trim(),
                    priority: p,
                    confidence: Math.round(this.clamp(Number(item.confidence) || 70, 60, 95)),
                    action: item.action.trim(),
                });
            }

            return valid.length ? valid : null;
        } catch {
            return null;
        }
    }

    // -----------------------------
    // Helpers
    // -----------------------------
    private extractPortfolio(raw: any): PortfolioData {
        const tokens = raw?.data?.tokens;
        if (!Array.isArray(tokens)) return { tokens: [] };

        const normalized = tokens
            .map((t: any) => ({
                symbol: String(t?.symbol ?? '').toUpperCase(),
                allocationPercent: Number(t?.allocationPercent ?? 0),
                currentValueUsd: Number(t?.currentValueUsd ?? 0),
            }))
            .filter((t: PortfolioToken) => t.symbol && Number.isFinite(t.allocationPercent));

        return { tokens: normalized };
    }

    private extractIntelligence(raw: any): IntelligenceData {
        return {
            riskExposure: raw?.data?.riskExposure ?? {},
        };
    }

    private dedupeSignals(signals: Signal[]): Signal[] {
        const map = new Map<string, Signal>();
        for (const s of signals) {
            const key = `${s.type}:${s.action}`; // stable duplicate key
            if (!map.has(key)) map.set(key, s);
        }
        return Array.from(map.values());
    }

    private maxByAllocation(tokens: PortfolioToken[]): PortfolioToken | null {
        if (!tokens.length) return null;
        return tokens.reduce((max, t) =>
            t.allocationPercent > max.allocationPercent ? t : max,
        );
    }

    private getAllocation(tokens: PortfolioToken[], symbol: string): number {
        const found = tokens.find((t) => t.symbol === symbol);
        return found?.allocationPercent ?? 0;
    }

    private dataQuality(tokens: PortfolioToken[]): number {
        // 0..1 score based on how many meaningful positions we have
        const meaningful = tokens.filter((t) => t.allocationPercent > 0.1).length;
        return this.clamp(meaningful / 6, 0.4, 1);
    }

    private strengthOverThreshold(value: number, threshold: number, upperBound: number): number {
        return this.clamp((value - threshold) / Math.max(upperBound - threshold, 1), 0, 1);
    }

    private strengthBelowThreshold(value: number, threshold: number, lowerBound: number): number {
        return this.clamp((threshold - value) / Math.max(threshold - lowerBound, 1), 0, 1);
    }

    private r2(n: number): number {
        return Number(n.toFixed(2));
    }

    private clamp(n: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, n));
    }

    private async set(key: string, value: unknown, ttl = 60) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    }

    private async get<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
    }

    private handleServiceError(error: unknown, context: string): never {
        if (error instanceof HttpException) throw error;
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`${context} failed: ${message}`, error instanceof Error ? error.stack : undefined);
        throw new InternalServerErrorException(`${context} failed`);
    }
}