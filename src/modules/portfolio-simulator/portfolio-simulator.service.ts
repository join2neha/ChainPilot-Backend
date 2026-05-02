import {
    BadRequestException,
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import Redis from 'ioredis';

type Horizon = '3m' | '6m' | '1y' | '3y';

type Allocation = {
    ETH: number;
    BTC: number;
    STABLES: number;
    ALTS: number;
};

type SimulateInput = {
    capital: number;
    riskTolerance: number;
    horizon: Horizon;
};

type SimulateResponse = {
    success: true;
    data: {
        allocation: Allocation;
        projection: {
            expectedReturnPercent: number;
            expectedProfitUsd: number;
            maxDrawdownPercent: number;
        };
        meta: {
            horizon: Horizon;
            horizonMultiplier: number;
            baseExpectedReturnAnnual: number;
            adjustedExpectedReturnForHorizon: number;
            isAiAdjusted: boolean;
        };
    };
    cache?: boolean;
};

@Injectable()
export class PortfolioSimulatorService {
    private readonly logger = new Logger(PortfolioSimulatorService.name);

    private static readonly CACHE_TTL_SECONDS = 60;

    private static readonly RETURNS: Allocation = {
        ETH: 0.35,
        BTC: 0.25,
        STABLES: 0.05,
        ALTS: 0.6,
    };

    private static readonly VOLATILITY: Allocation = {
        ETH: 0.6,
        BTC: 0.5,
        STABLES: 0.05,
        ALTS: 0.9,
    };

    private static readonly HORIZON_MULTIPLIER: Record<Horizon, number> = {
        '3m': 0.25,
        '6m': 0.5,
        '1y': 1,
        '3y': 2.5,
    };

    constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) { }

    async simulate(input: SimulateInput): Promise<SimulateResponse> {
        if (!Number.isFinite(input.capital) || input.capital <= 0) {
            throw new BadRequestException('capital must be > 0');
        }

        const risk = this.clampInt(input.riskTolerance, 0, 100);
        const horizon = input.horizon;

        const cacheKey = this.buildCacheKey({ capital: input.capital, riskTolerance: risk, horizon });
        const cached = await this.get<SimulateResponse>(cacheKey);
        if (cached) return { ...cached, cache: true };

        try {
            const baseAllocation = this.getAllocation(risk);
            const { allocation, isAiAdjusted } = await this.getAiOptimizedAllocation(
                baseAllocation,
                risk,
            );

            this.assertAllocationValid(allocation);

            const baseExpectedReturnAnnual = this.calculateExpectedReturn(allocation);
            const baseDrawdownAnnual = this.calculateDrawdown(allocation);

            const horizonMultiplier = PortfolioSimulatorService.HORIZON_MULTIPLIER[horizon];

            // Horizon scaling applies to both return and risk proxy for this MVP simulator
            const adjustedExpectedReturnForHorizon = baseExpectedReturnAnnual * horizonMultiplier;
            const adjustedDrawdownForHorizon = baseDrawdownAnnual * horizonMultiplier;

            const expectedProfitUsd = input.capital * adjustedExpectedReturnForHorizon;

            const result: SimulateResponse = {
                success: true,
                data: {
                    allocation,
                    projection: {
                        expectedReturnPercent: this.round2(adjustedExpectedReturnForHorizon * 100),
                        expectedProfitUsd: this.round2(expectedProfitUsd),
                        maxDrawdownPercent: this.round2(adjustedDrawdownForHorizon * 100),
                    },
                    meta: {
                        horizon,
                        horizonMultiplier,
                        baseExpectedReturnAnnual: this.round4(baseExpectedReturnAnnual),
                        adjustedExpectedReturnForHorizon: this.round4(adjustedExpectedReturnForHorizon),
                        isAiAdjusted,
                    },
                },
                cache: false,
            };

            await this.set(cacheKey, result, PortfolioSimulatorService.CACHE_TTL_SECONDS);
            return result;
        } catch (error) {
            this.handleServiceError(error, 'Portfolio simulate');
        }
    }

    // -----------------------------
    // Step 1 — Allocation engine
    // -----------------------------
    getAllocation(riskTolerance: number): Allocation {
        const r = this.clampInt(riskTolerance, 0, 100);

        if (r <= 30) {
            return { ETH: 30, BTC: 30, STABLES: 40, ALTS: 0 };
        }

        if (r <= 60) {
            return { ETH: 40, BTC: 30, STABLES: 20, ALTS: 10 };
        }

        return { ETH: 35, BTC: 20, STABLES: 10, ALTS: 35 };
    }

    // -----------------------------
    // Step 2 — Expected return
    // -----------------------------
    calculateExpectedReturn(allocation: Allocation): number {
        const R = PortfolioSimulatorService.RETURNS;
        const raw =
            (allocation.ETH / 100) * R.ETH +
            (allocation.BTC / 100) * R.BTC +
            (allocation.STABLES / 100) * R.STABLES +
            (allocation.ALTS / 100) * R.ALTS;

        return raw;
    }

    // -----------------------------
    // Step 3 — Drawdown proxy
    // -----------------------------
    calculateDrawdown(allocation: Allocation): number {
        const V = PortfolioSimulatorService.VOLATILITY;
        const portfolioVol =
            (allocation.ETH / 100) * V.ETH +
            (allocation.BTC / 100) * V.BTC +
            (allocation.STABLES / 100) * V.STABLES +
            (allocation.ALTS / 100) * V.ALTS;

        // negative drawdown proxy
        return portfolioVol * -0.5;
    }

    // -----------------------------
    // Step 7 — AI optimization layer (optional)
    // -----------------------------
    private async getAiOptimizedAllocation(
        baseAllocation: Allocation,
        riskTolerance: number,
    ): Promise<{ allocation: Allocation; isAiAdjusted: boolean }> {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            return { allocation: baseAllocation, isAiAdjusted: false };
        }

        const prompt = [
            'You are a portfolio construction assistant for a crypto simulator.',
            'Given a base allocation (percentages) and risk tolerance, return a SLIGHTLY adjusted allocation.',
            'Hard constraints:',
            '- Only these buckets exist: ETH, BTC, STABLES, ALTS',
            '- All values are non-negative numbers',
            '- Total must equal exactly 100',
            '- Do not invent tokens',
            '- Keep changes small (typically <= 5 percentage points per bucket vs base unless risk is extreme)',
            'Return STRICT JSON only (no markdown):',
            '{"ETH":number,"BTC":number,"STABLES":number,"ALTS":number}',
            '',
            `riskTolerance=${riskTolerance}`,
            `baseAllocation=${JSON.stringify(baseAllocation)}`,
        ].join('\n');

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
                    temperature: 0.2,
                }),
            });

            if (!response.ok) {
                this.logger.warn(`OpenAI allocation adjust failed: HTTP ${response.status}`);
                return { allocation: baseAllocation, isAiAdjusted: false };
            }

            const data = (await response.json()) as { output_text?: string };
            const parsed = this.tryParseAllocationJson(data.output_text ?? '');
            if (!parsed) return { allocation: baseAllocation, isAiAdjusted: false };

            const normalized = this.normalizeAllocation(parsed);
            if (!normalized) return { allocation: baseAllocation, isAiAdjusted: false };

            return { allocation: normalized, isAiAdjusted: true };
        } catch (e) {
            this.logger.warn('OpenAI allocation adjust threw; using base allocation');
            return { allocation: baseAllocation, isAiAdjusted: false };
        }
    }

    private tryParseAllocationJson(text: string): Partial<Allocation> | null {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) return null;

        try {
            return JSON.parse(text.slice(start, end + 1));
        } catch {
            return null;
        }
    }

    private normalizeAllocation(input: Partial<Allocation>): Allocation | null {
        const keys: Array<keyof Allocation> = ['ETH', 'BTC', 'STABLES', 'ALTS'];

        const nums = keys.map((k) => {
            const v = Number((input as any)[k]);
            if (!Number.isFinite(v) || v < 0) return null;
            return v;
        });

        if (nums.some((n) => n === null)) return null;

        const sum = (nums as number[]).reduce((a, b) => a + b, 0);
        if (sum <= 0) return null;

        // rescale to exactly 100 with 2 decimals, fix rounding drift
        const scaled = (nums as number[]).map((n) => (n / sum) * 100);
        const rounded = scaled.map((n) => Number(n.toFixed(2)));

        let drift = 100 - rounded.reduce((a, b) => a + b, 0);
        // fix drift on largest bucket
        const idx = rounded.indexOf(Math.max(...rounded));
        rounded[idx] = Number((rounded[idx] + drift).toFixed(2));

        const out: Allocation = {
            ETH: rounded[0],
            BTC: rounded[1],
            STABLES: rounded[2],
            ALTS: rounded[3],
        };

        const finalSum = out.ETH + out.BTC + out.STABLES + out.ALTS;
        if (Math.abs(finalSum - 100) > 0.05) return null;

        return out;
    }

    private assertAllocationValid(a: Allocation) {
        const sum = a.ETH + a.BTC + a.STABLES + a.ALTS;
        if (Math.abs(sum - 100) > 0.05) {
            throw new InternalServerErrorException('Invalid allocation sum');
        }
        if ([a.ETH, a.BTC, a.STABLES, a.ALTS].some((v) => v < 0 || !Number.isFinite(v))) {
            throw new InternalServerErrorException('Invalid allocation values');
        }
    }

    // -----------------------------
    // Redis
    // -----------------------------
    private buildCacheKey(input: SimulateInput): string {
        return `portfolio:simulate:${input.horizon}:${input.riskTolerance}:${input.capital}`;
    }

    private async set(key: string, value: unknown, ttlSeconds: number) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }

    private async get<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
    }

    // -----------------------------
    // Utils
    // -----------------------------
    private clampInt(n: number, min: number, max: number): number {
        const x = Math.round(n);
        return Math.max(min, Math.min(max, x));
    }

    private round2(n: number): number {
        return Number(n.toFixed(2));
    }

    private round4(n: number): number {
        return Number(n.toFixed(4));
    }

    private handleServiceError(error: unknown, context: string): never {
        if (error instanceof HttpException) throw error;
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`${context} failed: ${message}`, error instanceof Error ? error.stack : undefined);
        throw new InternalServerErrorException(`${context} failed`);
    }
}