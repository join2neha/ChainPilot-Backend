import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { OnchainService } from '../onchain/onchain.service';
import { WalletIntelligenceService } from '../wallet-intelligence/wallet-intelligence.service';
import { AgentMemory } from 'src/database/entities/agent-memory.entity';
import { WalletService } from '../wallet/wallet.service';

// ─── Types ─────────────────────────────────────────────────────────────────

type Mode = 'conservative' | 'balanced' | 'aggressive';
type Risk = 'low' | 'medium' | 'high';

type Opportunity = {
    tokenIn: string;
    tokenOut: string;
    percent: number;
};

type Quote = {
    amountOut: string;
    priceImpact: string;
    route: string;
};

type Suggestion = {
    tokenIn: string;
    tokenOut: string;
    percent: number;
    impact: string;
    confidence: number;
    risk: Risk;
    quote: Quote | null;
    reasoning: string;
};

type PortfolioSnapshot = {
    totalValueUsd: number;
    tokens: Array<{ symbol: string; allocationPercent: number }>;
};

// ─── Volatility map ────────────────────────────────────────────────────────

const TOKEN_VOLATILITY: Record<string, Risk> = {
    BTC: 'low', ETH: 'low', USDC: 'low', USDT: 'low', DAI: 'low',
    ARB: 'medium', SOL: 'medium', MATIC: 'medium', LINK: 'medium',
    DOGE: 'high', SHIB: 'high', PEPE: 'high', FLOKI: 'high',
};

@Injectable()
export class SwapIntelligenceProService {
    private readonly logger = new Logger(SwapIntelligenceProService.name);

    constructor(
        private readonly onchainService: OnchainService,
        private readonly walletService: WalletService,
        private readonly walletIntelligenceService: WalletIntelligenceService,
        @InjectRepository(AgentMemory)
        private readonly agentMemoryRepo: Repository<AgentMemory>,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
    ) { }

    // ─── Main entry ────────────────────────────────────────────────────────

    async getSwapIntelligence(userId: string, mode: Mode) {
        const cacheKey = `swap-intel:${userId}:${mode}`;
        const cached = await this.getCache<any>(cacheKey);
        if (cached) return { ...cached, cache: true };

        const [portfolioData, walletData, signalsData, marketData, memories] = await Promise.allSettled([
            this.walletService.getPortfolioSummary(userId),
            this.walletService.analyzeWalletDetails(userId),
            this.onchainService.getOnchainSignals(),
            this.walletService.getGlobalMarket(),
            this.agentMemoryRepo.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 10 }),
        ]);

        const portfolio = this.extractTokenAllocations(portfolioData, walletData);
        const signals = signalsData.status === 'fulfilled' ? signalsData.value : null;
        const market = marketData.status === 'fulfilled' ? marketData.value : null;
        const recentMemories = memories.status === 'fulfilled' ? memories.value : [];

        const opportunities = this.detectOpportunities(portfolio.tokens, signals, market);

        const suggestions = await Promise.all(
            opportunities.map(async (opp) => {
                const adjustedOpp = this.applyModeAdjustment(opp, mode);
                const [quote, confidence, risk, reasoning] = await Promise.all([
                    this.getEstimatedQuote(adjustedOpp, market),
                    Promise.resolve(this.calculateConfidence(adjustedOpp, portfolio, signals, recentMemories)),
                    Promise.resolve(this.calculateRisk(adjustedOpp, portfolio)),
                    this.generateReasoning(adjustedOpp, portfolio, signals, mode),
                ]);

                return {
                    tokenIn: adjustedOpp.tokenIn,
                    tokenOut: adjustedOpp.tokenOut,
                    percent: adjustedOpp.percent,
                    impact: `${adjustedOpp.percent}% of your ${adjustedOpp.tokenIn} holdings`,
                    confidence,
                    risk,
                    quote,
                    reasoning,
                } as Suggestion;
            }),
        );

        const insight = this.buildInsight(portfolio, signals, mode);

        const result = {
            success: true,
            data: {
                portfolioValue: portfolio.totalValueUsd,
                topAllocations: portfolio.tokens
                    .slice(0, 4)
                    .map((t) => ({ symbol: t.symbol, allocationPercent: t.allocationPercent })),
                mode,
                insight,
                suggestions: suggestions.slice(0, 3),
            },
            cache: false,
        };

        await this.setCache(cacheKey, result, 30);
        return result;
    }

    // ─── Step 1: Extract portfolio from wallet intelligence ───────────────

    private extractTokenAllocations(
        portfolioResult: PromiseSettledResult<any>,
        walletResult: PromiseSettledResult<any>,
    ): { totalValueUsd: number; tokens: Array<{ symbol: string; allocationPercent: number }> } {

        // Use real portfolio if available
        const tokens = portfolioResult.status === 'fulfilled'
            ? (portfolioResult.value?.data?.tokens ?? [])
            : [];

        if (tokens.length > 0) {
            return {
                totalValueUsd: portfolioResult.status === 'fulfilled'
                    ? (portfolioResult.value?.data?.totalValueUsd ?? 0)
                    : 0,
                tokens,
            };
        }

        // Fallback: infer from wallet analysis risk profile
        const wallet = walletResult.status === 'fulfilled' ? walletResult.value : null;
        const risk = wallet?.risk_score ?? 50;
        const behavior = wallet?.behavior_type ?? 'Balanced';

        // Build synthetic allocation based on risk profile
        if (risk >= 70 || behavior === 'Degenerate') {
            return {
                totalValueUsd: 0,
                tokens: [
                    { symbol: 'ETH', allocationPercent: 30 },
                    { symbol: 'SOL', allocationPercent: 40 },
                    { symbol: 'ARB', allocationPercent: 30 },
                ],
            };
        }
        if (risk >= 40 || behavior === 'Swing Trader') {
            return {
                totalValueUsd: 0,
                tokens: [
                    { symbol: 'ETH', allocationPercent: 50 },
                    { symbol: 'SOL', allocationPercent: 30 },
                    { symbol: 'USDC', allocationPercent: 20 },
                ],
            };
        }
        return {
            totalValueUsd: 0,
            tokens: [
                { symbol: 'ETH', allocationPercent: 40 },
                { symbol: 'BTC', allocationPercent: 40 },
                { symbol: 'USDC', allocationPercent: 20 },
            ],
        };
    }

    // ─── Step 2: Opportunity detection ────────────────────────────────────

    private detectOpportunities(
        tokens: Array<{ symbol: string; allocationPercent: number }>,
        signals: any,
        market: any,
    ): Opportunity[] {
        const top3 = tokens.slice(0, 3);
        const opportunities: Opportunity[] = [];

        for (const token of top3) {
            const tokenOut = this.suggestSwapTarget(token.symbol, tokens);
            if (!tokenOut) continue;

            const percent =
                token.allocationPercent >= 40 ? 20
                    : token.allocationPercent >= 20 ? 15
                        : 10;

            opportunities.push({
                tokenIn: token.symbol,
                tokenOut,
                percent,
            });
        }

        if (!opportunities.length) {
            opportunities.push({ tokenIn: 'ETH', tokenOut: 'BTC', percent: 10 });
        }

        return opportunities.slice(0, 3);
    }

    private suggestSwapTarget(
        tokenIn: string,
        tokens: Array<{ symbol: string; allocationPercent: number }>,
    ): string | null {
        const held = new Set(tokens.map((t) => t.symbol));

        const STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FDUSD']);
        const L1S = ['ETH', 'BTC', 'SOL', 'BNB'];
        const L2S = ['ARB', 'OP', 'MATIC', 'LINK', 'AVAX', 'NEAR'];

        if (STABLES.has(tokenIn)) {
            // Stables → rotate into best L1 not already dominant
            return L1S.find((t) => t !== tokenIn) ?? 'ETH';
        }

        if (L1S.includes(tokenIn)) {
            // L1 → diversify into L2 or complementary L1
            const target = [...L2S, ...L1S].find((t) => t !== tokenIn && !held.has(t));
            return target ?? (tokenIn === 'ETH' ? 'BTC' : 'ETH');
        }

        // Alt/meme → rotate to safety
        return held.has('ETH') ? 'BTC' : 'ETH';
    }

    // ─── Step 3: Mode adjustment ───────────────────────────────────────────

    private applyModeAdjustment(opp: Opportunity, mode: Mode): Opportunity {
        let percent = opp.percent;

        if (mode === 'conservative') percent = Math.round(percent * 0.5);
        if (mode === 'aggressive') percent = Math.round(percent * 1.3);

        return { ...opp, percent: Math.min(percent, 50) };
    }

    // ─── Step 4: Estimated quote (price-based, no AlphaRouter needed) ─────

    private async getEstimatedQuote(opp: Opportunity, market: any): Promise<Quote | null> {
        try {
            const tokens: any[] = market?.data?.tokens ?? [];
            const inToken = tokens.find((t) => t.symbol === opp.tokenIn);
            const outToken = tokens.find((t) => t.symbol === opp.tokenOut);

            if (!inToken || !outToken) return null;

            const ratio = inToken.price / outToken.price;
            const estimatedOut = (ratio * opp.percent).toFixed(6);
            const priceImpact = opp.percent > 30 ? '~0.5%' : '~0.1%';

            return {
                amountOut: `${estimatedOut} ${opp.tokenOut}`,
                priceImpact,
                route: `${opp.tokenIn} → ${opp.tokenOut} (Uniswap V3)`,
            };
        } catch {
            return null;
        }
    }

    // ─── Step 5: Confidence engine ─────────────────────────────────────────

    private calculateConfidence(
        opp: Opportunity,
        portfolio: PortfolioSnapshot,
        signals: any,
        memories: AgentMemory[],
    ): number {
        const portfolioScore = this.portfolioScore(opp, portfolio);
        const marketScore = this.marketScore(signals);
        const onchainScore = this.onchainScore(opp, signals);
        const memoryBoost = this.memoryBoost(opp, memories);

        const raw = portfolioScore * 0.3 + marketScore * 0.3 + onchainScore * 0.4 + memoryBoost;
        return Math.round(Math.min(Math.max(raw, 40), 95));
    }

    private portfolioScore(opp: Opportunity, portfolio: PortfolioSnapshot): number {
        const pct = (sym: string) =>
            portfolio.tokens.find((t) => t.symbol === sym)?.allocationPercent ?? 0;

        if (opp.tokenIn === 'ETH' && pct('ETH') >= 40) return 80;
        if (opp.tokenIn === 'USDC' && pct('USDC') >= 10) return 85;
        if (opp.tokenIn === 'SOL' && pct('SOL') >= 10) return 70;
        return 50;
    }

    private marketScore(signals: any): number {
        const score = signals?.data?.sentiment?.score ?? 50;
        if (score >= 60) return 80;
        if (score >= 40) return 60;
        return 40;
    }

    private onchainScore(opp: Opportunity, signals: any): number {
        const flows = signals?.data?.flows ?? {};
        const outTokenFlow = flows[opp.tokenOut];

        if (!outTokenFlow) return 55;

        const netInflow = outTokenFlow.inflow - outTokenFlow.outflow;
        if (netInflow > 0) return 80;
        if (netInflow < 0) return 35;
        return 55;
    }

    private memoryBoost(opp: Opportunity, memories: AgentMemory[]): number {
        const pastTrades = memories.filter(
            (m) => (m.decision as any)?.tokenOut === opp.tokenOut,
        );
        if (pastTrades.length >= 3) return 10;
        if (pastTrades.length >= 1) return 5;
        return 0;
    }

    // ─── Step 6: Risk calculation ──────────────────────────────────────────

    private calculateRisk(opp: Opportunity, portfolio: PortfolioSnapshot): Risk {
        const tokenRisk = TOKEN_VOLATILITY[opp.tokenOut] ?? 'medium';
        const exposureRisk = opp.percent >= 30 ? 'high' : opp.percent >= 15 ? 'medium' : 'low';

        const riskMap: Record<string, Record<string, Risk>> = {
            low: { low: 'low', medium: 'low', high: 'medium' },
            medium: { low: 'low', medium: 'medium', high: 'high' },
            high: { low: 'medium', medium: 'high', high: 'high' },
        };

        return riskMap[tokenRisk]?.[exposureRisk] ?? 'medium';
    }

    // ─── Step 7: AI Reasoning ─────────────────────────────────────────────

    private async generateReasoning(
        opp: Opportunity,
        portfolio: PortfolioSnapshot,
        signals: any,
        mode: Mode,
    ): Promise<string> {
        const apiKey = process.env.OPENAI_API_KEY?.trim();
        const fallback = this.buildReasoningFallback(opp, portfolio, mode);

        if (!apiKey) return fallback;

        const top = portfolio.tokens.slice(0, 3).map((t) => `${t.symbol} ${t.allocationPercent}%`).join(', ');

        const prompt = `You are a crypto swap advisor. In 2-3 sentences, explain why swapping ${opp.percent}% of ${opp.tokenIn} into ${opp.tokenOut} makes sense.
                Context: Portfolio top holdings: ${top}, sentiment=${signals?.data?.sentiment?.label ?? 'Neutral'}, mode=${mode}.
                Mention risk clearly. Be concise.`;

        try {
            const res = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'gpt-4.1-mini', input: prompt, temperature: 0.4 }),
            });

            if (!res.ok) return fallback;

            const data = await res.json();
            const text = data?.output?.[0]?.content?.[0]?.text?.trim();
            return text || fallback;
        } catch {
            return fallback;
        }
    }

    private buildReasoningFallback(opp: Opportunity, portfolio: PortfolioSnapshot, mode: Mode): string {
        const modeLabel = mode === 'conservative' ? 'a careful' : mode === 'aggressive' ? 'an aggressive' : 'a balanced';
        return `Based on your current portfolio allocation, swapping ${opp.percent}% of ${opp.tokenIn} to ${opp.tokenOut} represents ${modeLabel} rebalancing move. This reduces concentration risk and aligns with current market signals. Review carefully before acting.`;
    }

    // ─── Step 8: Insight summary ───────────────────────────────────────────

    private buildInsight(portfolio: PortfolioSnapshot, signals: any, mode: Mode): string {
        const label = signals?.data?.sentiment?.label ?? 'Neutral';
        const top = portfolio.tokens[0];
        const dominantLabel = top ? `${top.symbol}-heavy (${top.allocationPercent}%)` : 'diversified';
        return `Market sentiment is ${label}. Your portfolio is ${dominantLabel}. Running in ${mode} mode.`;
    }

    // ─── Redis helpers ─────────────────────────────────────────────────────

    private async getCache<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        return raw ? JSON.parse(raw) : null;
    }

    private async setCache(key: string, value: unknown, ttl: number): Promise<void> {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    }
}