import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { Web3Service } from 'src/config/web3.service';
import { User } from 'src/database/entities/user.entity';
import { AgentMemory } from 'src/database/entities/agent-memory.entity';
import { OnchainService } from '../onchain/onchain.service';
import { PriceService } from '../price/price.service';

// ─── Types ─────────────────────────────────────────────────────────────────

type Mode = 'conservative' | 'balanced' | 'aggressive';
type Risk = 'low' | 'medium' | 'high';

type NormalizedToken = {
    symbol: string;
    balance: number;
    decimals: number;
    contractAddress: string | null;
};

type PricedToken = NormalizedToken & {
    priceUsd: number;
    valueUsd: number;
};

type PortfolioToken = {
    symbol: string;
    valueUsd: number;
    allocationPercent: number;
};

type Portfolio = {
    totalValueUsd: number;
    riskLevel: Risk;
    tokens: PortfolioToken[];
};

type Opportunity = { tokenIn: string; tokenOut: string; percent: number };

type Suggestion = {
    tokenIn: string;
    tokenOut: string;
    percent: number;
    impact: string;
    risk: Risk;
    confidence: number;
    reasoning: string;
};

// ─── Constants ─────────────────────────────────────────────────────────────

const COIN_ID_MAP: Record<string, string> = {
    ETH: 'ethereum', WETH: 'weth', BTC: 'bitcoin', WBTC: 'wrapped-bitcoin',
    SOL: 'solana', BNB: 'binancecoin', ARB: 'arbitrum', OP: 'optimism',
    MATIC: 'matic-network', LINK: 'chainlink', AVAX: 'avalanche-2',
    NEAR: 'near', UNI: 'uniswap', AAVE: 'aave', CRV: 'curve-dao-token',
    LDO: 'lido-dao', MKR: 'maker', USDC: 'usd-coin', USDT: 'tether',
    DAI: 'dai', BUSD: 'binance-usd', FRAX: 'frax', DOGE: 'dogecoin',
    SHIB: 'shiba-inu', PEPE: 'pepe', HEX: 'hex',
};

const CORE_ASSETS = ['ETH', 'BTC', 'SOL', 'ARB', 'LINK', 'MATIC', 'AVAX', 'NEAR', 'UNI', 'AAVE'];

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'FDUSD', 'LUSD', 'SUSD']);

const SPAM_PATTERNS = [
    'visit', 'http', 'claim', 'reward', '.com', '.io', '.net',
    'yt-', 'pt-', 'sy-', 'farming', 'airdrop', '#', 'lp', 'pool',
];

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class SwapIntelligenceProService {
    private readonly logger = new Logger(SwapIntelligenceProService.name);

    constructor(
        private readonly web3Service: Web3Service,
        private readonly onchainService: OnchainService,
        @InjectRepository(User) private readonly userRepo: Repository<User>,
        @InjectRepository(AgentMemory) private readonly agentMemoryRepo: Repository<AgentMemory>,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
        private readonly priceService: PriceService,
    ) {}

    // ─── Main entry ────────────────────────────────────────────────────────

    async getSwapIntelligence(userId: string, mode: Mode) {
        const cacheKey = `swap-intel-v2:${userId}:${mode}`;
        const cached = await this.getCache<any>(cacheKey);
        if (cached) return { ...cached, cache: true };

        const user = await this.userRepo.findOne({ where: { id: userId } });
        if (!user) throw new NotFoundException('User not found');

        const address = user.walletAddress.toLowerCase();

        const [tokensResult, signalsResult, memoriesResult] = await Promise.allSettled([
            this.fetchAndNormalizeTokens(address),
            this.onchainService.getOnchainSignals(),
            this.agentMemoryRepo.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 10 }),
        ]);

        const normalizedTokens = tokensResult.status === 'fulfilled' ? tokensResult.value : [];
        const signals         = signalsResult.status === 'fulfilled' ? signalsResult.value : null;
        const memories        = memoriesResult.status === 'fulfilled' ? memoriesResult.value : [];

        const pricedTokens = await this.priceTokens(normalizedTokens);
        const portfolio    = this.buildPortfolio(pricedTokens);
        const opportunities = this.detectOpportunities(portfolio);

        const suggestions = await Promise.all(
            opportunities.map((opp) =>
                this.buildSuggestion(this.applyModeAdjustment(opp, mode), portfolio, signals, memories, mode),
            ),
        );

        const result = {
            success: true,
            data: {
                portfolio: {
                    totalValueUsd: portfolio.totalValueUsd,
                    riskLevel: portfolio.riskLevel,
                    topAllocations: portfolio.tokens.slice(0, 5),
                },
                mode,
                insight: this.buildInsight(portfolio, signals),
                suggestions: suggestions.slice(0, 3),
            },
            cache: false,
        };

        await this.setCache(cacheKey, result, 60);
        return result;
    }

    // ─── Step 1: Fetch + normalize from Alchemy ────────────────────────────

    private async fetchAndNormalizeTokens(address: string): Promise<NormalizedToken[]> {
        const alchemy = this.web3Service.alchemy;
        const result: NormalizedToken[] = [];

        const balances = await alchemy.core.getTokenBalances(address);
        const nonZero = balances.tokenBalances.filter(
            (t) => t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x',
        );

        const metadataResults = await Promise.allSettled(
            nonZero.map((t) => alchemy.core.getTokenMetadata(t.contractAddress)),
        );

        for (let i = 0; i < nonZero.length; i++) {
            const t = nonZero[i];
            const meta = metadataResults[i];
            if (meta.status !== 'fulfilled') continue;

            const symbol = (meta.value.symbol ?? '').trim();
            if (!symbol || this.isSpam(symbol)) continue;

            const decimals = meta.value.decimals ?? 18;
            const balance = Number(BigInt(t.tokenBalance ?? '0x0')) / Math.pow(10, decimals);
            if (balance <= 0) continue;

            result.push({ symbol: symbol.toUpperCase(), balance, decimals, contractAddress: t.contractAddress });
        }

        // Native ETH
        const ethWei = await alchemy.core.getBalance(address);
        const ethBalance = Number(ethWei) / 1e18;
        if (ethBalance > 0.0001) {
            result.push({ symbol: 'ETH', balance: ethBalance, decimals: 18, contractAddress: null });
        }

        this.logger.log(`[SwapIntel] ${result.length} clean tokens for ${address}`);
        return result;
    }

    private isSpam(symbol: string): boolean {
        const lower = symbol.toLowerCase();
        return SPAM_PATTERNS.some((p) => lower.includes(p));
    }

    // ─── Step 2: Price tokens ──────────────────────────────────────────────

    private async priceTokens(tokens: NormalizedToken[]): Promise<PricedToken[]> {
        const symbols = [...new Set(tokens.map((t) => t.symbol))];
        const priceMap = await this.priceService.getPrices(symbols);
        return tokens.map((t) => ({
            ...t,
            priceUsd: priceMap[t.symbol] ?? 0,
            valueUsd: (priceMap[t.symbol] ?? 0) * t.balance,
        }));
    }

    private async fetchCoinGeckoPrices(symbols: string[]): Promise<Record<string, number>> {
        const baseUrl = process.env.COINGECKO_BASE_URL;
        const apiKey  = process.env.COINGECKO_API_KEY;
        if (!baseUrl || !apiKey) return {};

        const coinIds = [...new Set(symbols.map((s) => COIN_ID_MAP[s]).filter(Boolean))];
        if (!coinIds.length) return {};

        try {
            const res = await fetch(
                `${baseUrl}/simple/price?ids=${coinIds.join(',')}&vs_currencies=usd`,
                { headers: { 'x_cg_demo_api_key': apiKey } },
            );
            if (!res.ok) return {};

            const json = await res.json();
            const out: Record<string, number> = {};
            for (const sym of symbols) {
                const id = COIN_ID_MAP[sym];
                if (id && json?.[id]?.usd) out[sym] = json[id].usd;
            }
            return out;
        } catch {
            return {};
        }
    }

    // ─── Step 3: Build portfolio ───────────────────────────────────────────

    private buildPortfolio(tokens: PricedToken[]): Portfolio {
        const meaningful = tokens.filter((t) => t.valueUsd >= 1);
        const totalValueUsd = meaningful.reduce((s, t) => s + t.valueUsd, 0);

        const portfolioTokens: PortfolioToken[] = meaningful
            .map((t) => ({
                symbol: t.symbol,
                valueUsd: Number(t.valueUsd.toFixed(2)),
                allocationPercent: totalValueUsd > 0
                    ? Number(((t.valueUsd / totalValueUsd) * 100).toFixed(2))
                    : 0,
            }))
            .sort((a, b) => b.allocationPercent - a.allocationPercent);

        const stableAlloc = portfolioTokens
            .filter((t) => STABLES.has(t.symbol))
            .reduce((s, t) => s + t.allocationPercent, 0);

        const riskLevel: Risk = stableAlloc > 50 ? 'low' : stableAlloc < 10 ? 'high' : 'medium';

        return { totalValueUsd: Number(totalValueUsd.toFixed(2)), riskLevel, tokens: portfolioTokens };
    }

    // ─── Step 4: Detect opportunities ─────────────────────────────────────

    private detectOpportunities(portfolio: Portfolio): Opportunity[] {
        const tokens = portfolio.tokens;
        if (!tokens.length) return [];

        const held = new Set(tokens.map((t) => t.symbol));
        const seen = new Set<string>();
        const opportunities: Opportunity[] = [];

        for (const tokenIn of tokens.slice(0, 3)) {
            const tokenOut = this.pickSwapTarget(tokenIn.symbol, held);
            if (!tokenOut) continue;

            const key = `${tokenIn.symbol}-${tokenOut}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const percent =
                tokenIn.allocationPercent >= 50 ? 20
                : tokenIn.allocationPercent >= 30 ? 15
                : 10;

            opportunities.push({ tokenIn: tokenIn.symbol, tokenOut, percent });
        }

        return opportunities.slice(0, 3);
    }

    private pickSwapTarget(tokenIn: string, held: Set<string>): string | null {
        if (STABLES.has(tokenIn)) {
            return CORE_ASSETS.find((a) => !held.has(a)) ?? 'ETH';
        }
        const unowned = CORE_ASSETS.find((a) => a !== tokenIn && !held.has(a));
        if (unowned) return unowned;
        return CORE_ASSETS.find((a) => a !== tokenIn) ?? null;
    }

    // ─── Step 5: Mode adjustment ───────────────────────────────────────────

    private applyModeAdjustment(opp: Opportunity, mode: Mode): Opportunity {
        const m = mode === 'conservative' ? 0.5 : mode === 'aggressive' ? 1.3 : 1;
        return { ...opp, percent: Math.min(Math.round(opp.percent * m), 50) };
    }

    // ─── Step 6: Build suggestion ──────────────────────────────────────────

    private async buildSuggestion(
        opp: Opportunity,
        portfolio: Portfolio,
        signals: any,
        memories: AgentMemory[],
        mode: Mode,
    ): Promise<Suggestion> {
        const [risk, confidence, reasoning] = await Promise.all([
            Promise.resolve(this.calculateRisk(opp)),
            Promise.resolve(this.calculateConfidence(opp, portfolio, signals, memories)),
            this.generateReasoning(opp, portfolio, signals, mode),
        ]);

        return {
            tokenIn: opp.tokenIn,
            tokenOut: opp.tokenOut,
            percent: opp.percent,
            impact: `${opp.percent}% of your ${opp.tokenIn} holdings`,
            risk,
            confidence,
            reasoning,
        };
    }

    // ─── Step 7: Risk ──────────────────────────────────────────────────────

    private calculateRisk(opp: Opportunity): Risk {
        if (STABLES.has(opp.tokenOut)) return 'low';
        const sizeRisk: Risk = opp.percent >= 30 ? 'high' : opp.percent >= 15 ? 'medium' : 'low';
        if (CORE_ASSETS.includes(opp.tokenOut)) return sizeRisk === 'high' ? 'medium' : sizeRisk;
        return 'high';
    }

    // ─── Step 8: Confidence ────────────────────────────────────────────────

    private calculateConfidence(
        opp: Opportunity,
        portfolio: Portfolio,
        signals: any,
        memories: AgentMemory[],
    ): number {
        const tokenIn = portfolio.tokens.find((t) => t.symbol === opp.tokenIn);
        const imbalance = tokenIn ? Math.min((tokenIn.allocationPercent / 40) * 80, 90) : 50;
        const sentiment = signals?.data?.sentiment?.score ?? 50;
        const market    = sentiment >= 60 ? 80 : sentiment >= 40 ? 60 : 40;
        const flow      = signals?.data?.flows?.ETH;
        const onchain   = flow ? (flow.inflow > flow.outflow ? 80 : 40) : 55;
        const past      = memories.filter((m) => (m.decision as any)?.tokenOut === opp.tokenOut).length;
        const boost     = past >= 3 ? 10 : past >= 1 ? 5 : 0;

        const raw = imbalance * 0.3 + market * 0.3 + onchain * 0.4 + boost;
        return Math.round(Math.min(Math.max(raw, 55), 95));
    }

    // ─── Step 9: Insight ───────────────────────────────────────────────────

    private buildInsight(portfolio: Portfolio, signals: any): string {
        const top       = portfolio.tokens[0];
        const sentiment = signals?.data?.sentiment?.label ?? 'Neutral';

        if (!top) return `Market sentiment is ${sentiment}. No priceable holdings found — consider adding ETH or BTC.`;

        if (top.allocationPercent >= 40) {
            return `You are overexposed to ${top.symbol} (${top.allocationPercent}%). Consider diversifying to reduce concentration risk.`;
        }

        const stableAlloc = portfolio.tokens
            .filter((t) => STABLES.has(t.symbol))
            .reduce((s, t) => s + t.allocationPercent, 0);

        if (stableAlloc >= 50) {
            return `You have high stablecoin allocation (${stableAlloc.toFixed(0)}%). Consider deploying some capital into growth assets.`;
        }

        return `Your portfolio is moderately diversified. Market sentiment is ${sentiment}.`;
    }

    // ─── Step 10: Reasoning ────────────────────────────────────────────────

    private async generateReasoning(opp: Opportunity, portfolio: Portfolio, signals: any, mode: Mode): Promise<string> {
        const apiKey = process.env.OPENAI_API_KEY?.trim();
        const fallback = this.buildFallback(opp, mode);
        if (!apiKey) return fallback;

        const top = portfolio.tokens.slice(0, 3).map((t) => `${t.symbol} ${t.allocationPercent}%`).join(', ');
        const prompt = `You are a crypto swap advisor. In 2-3 sentences, explain why swapping ${opp.percent}% of ${opp.tokenIn} into ${opp.tokenOut} makes sense. Context: top holdings: ${top}, sentiment=${signals?.data?.sentiment?.label ?? 'Neutral'}, mode=${mode}. Mention risk. Be concise.`;

        try {
            const res = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'gpt-4.1-mini', input: prompt, temperature: 0.4 }),
            });
            if (!res.ok) return fallback;
            const data = await res.json();
            return data?.output?.[0]?.content?.[0]?.text?.trim() || fallback;
        } catch {
            return fallback;
        }
    }

    private buildFallback(opp: Opportunity, mode: Mode): string {
        const m = mode === 'conservative' ? 'a careful' : mode === 'aggressive' ? 'an aggressive' : 'a balanced';
        const isCore = CORE_ASSETS.includes(opp.tokenOut);
        return `Swapping ${opp.percent}% of ${opp.tokenIn} into ${opp.tokenOut} is ${m} rebalancing move that reduces concentration risk.${isCore ? ` ${opp.tokenOut} offers strong liquidity and market depth.` : ''} Review carefully before acting.`;
    }

    // ─── Redis ─────────────────────────────────────────────────────────────

    private async getCache<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        return raw ? JSON.parse(raw) : null;
    }

    private async setCache(key: string, value: unknown, ttl: number): Promise<void> {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
    }
}