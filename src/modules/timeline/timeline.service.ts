import {
    HttpException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';

import { User } from '../../database/entities/user.entity';
import { Web3Service } from '../../config/web3.service';
import { AssetTransfersCategory } from '../../common/constants/constants';

import { WalletIntelligenceService } from '../wallet-intelligence/wallet-intelligence.service';
import { WalletRecommendationsService } from '../wallet-recommendations/wallet-recommendations.service';
import { OnchainService } from '../onchain/onchain.service';

import { TimelineEvent, TimelineEventType } from './timeline.types';
import { PriceService } from '../price/price.service';

@Injectable()
export class TimelineService {
    private readonly logger = new Logger(TimelineService.name);

    private static readonly CACHE_TTL_SECONDS = 45;
    private static readonly MAX_EVENTS = 25;

    constructor(
        @InjectRepository(User) private readonly userRepo: Repository<User>,
        private readonly web3: Web3Service,
        private readonly walletIntelligence: WalletIntelligenceService,
        private readonly walletRecommendations: WalletRecommendationsService,
        private readonly onchain: OnchainService,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
        private readonly priceService: PriceService,
    ) { }

    /**
     * Polling model:
     * - Full timeline is cached in Redis (short TTL)
     * - `since` returns ONLY incremental slice and MUST NOT be served from the full cache directly
     *   (we still may *build* from cached full snapshot to save RPC)
     */
    async getTimeline(userId: string) {
        try {
            const cacheKey = `timeline:full:${userId}`;
            const cached = await this.get<any>(cacheKey);
            if (cached) {
                return { ...cached, cache: true };
            }

            const user = await this.userRepo.findOne({ where: { id: userId } });
            if (!user) throw new NotFoundException('User not found');

            const walletAddress = user.walletAddress.toLowerCase();

            const [trades, ai, rebalance, alerts, sentiment] = await Promise.allSettled([
                this.getTradeEvents(walletAddress),
                this.getAiEvents(userId),
                this.getRebalanceEvents(userId),
                this.getAlertEvents(userId),
                this.getSentimentEvents(),
            ]);

            const events: TimelineEvent[] = [];

            if (trades.status === 'fulfilled') events.push(...trades.value);
            if (ai.status === 'fulfilled') events.push(...ai.value);
            if (rebalance.status === 'fulfilled') events.push(...rebalance.value);
            if (alerts.status === 'fulfilled') events.push(...alerts.value);
            if (sentiment.status === 'fulfilled') events.push(...sentiment.value);

            const deduped = this.dedupeEvents(events);

            const sorted = deduped.sort((a, b) => b.timestamp - a.timestamp);
            const limited = sorted.slice(0, 25);

            const narrative = this.generateNarrative(limited);

            const result = {
                success: true,
                data: {
                    events: limited,
                    narrative,
                },
                cache: false,
                generatedAt: new Date().toISOString(),
            };

            // cache full snapshot only (no incremental mode)
            await this.set(cacheKey, result, 45); // pick 30–60s as you prefer

            return result;
        } catch (error) {
            this.handleServiceError(error, 'Timeline');
        }
    }

    // -----------------------------
    // Build full timeline (expensive)
    // -----------------------------
    private async buildFullTimelineEvents(
        walletAddress: string,
        userId: string,
    ): Promise<TimelineEvent[]> {
        const [trades, ai, rebalance, alerts, sentiment] = await Promise.allSettled([
            this.getTradeEvents(walletAddress),
            this.getAiEvents(userId),
            this.getRebalanceEvents(userId),
            this.getAlertEvents(userId),
            this.getSentimentEvents(),
        ]);

        const events: TimelineEvent[] = [];

        if (trades.status === 'fulfilled') events.push(...trades.value);
        if (ai.status === 'fulfilled') events.push(...ai.value);
        if (rebalance.status === 'fulfilled') events.push(...rebalance.value);
        if (alerts.status === 'fulfilled') events.push(...alerts.value);
        if (sentiment.status === 'fulfilled') events.push(...sentiment.value);

        const deduped = this.dedupeEvents(events);
        return deduped.sort((a, b) => b.timestamp - a.timestamp);
    }

    // -----------------------------
    // Sources
    // -----------------------------
    private async getTradeEvents(address: string): Promise<TimelineEvent[]> {
        const alchemy = this.web3.alchemy;

        const [incoming, outgoing] = await Promise.all([
            alchemy.core.getAssetTransfers({
                fromBlock: '0x0',
                toAddress: address,
                category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
                withMetadata: true,
                excludeZeroValue: true,
                maxCount: 40,
            }),
            alchemy.core.getAssetTransfers({
                fromBlock: '0x0',
                fromAddress: address,
                category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
                withMetadata: true,
                excludeZeroValue: true,
                maxCount: 40,
            }),
        ]);

        const transfers = [...(incoming.transfers ?? []), ...(outgoing.transfers ?? [])];
        if (!transfers.length) return [];

        const symbols = new Set<string>();
        for (const t of transfers) {
            const sym = String(t?.asset ?? 'ETH').toUpperCase();
            symbols.add(sym === 'ETH' ? 'ETH' : sym);
        }

        const priceMap = await this.priceService.getPrices([...symbols]);

        const events: TimelineEvent[] = [];

        for (const t of transfers) {
            const iso = t?.metadata?.blockTimestamp;
            if (!iso) continue;

            const ts = new Date(iso).getTime();
            if (!Number.isFinite(ts) || ts <= 0) continue;

            const token = String(t?.asset ?? 'ETH').toUpperCase();
            const amount = Number(t?.value ?? 0);
            if (!Number.isFinite(amount) || amount <= 0) continue;

            const to = String(t?.to ?? '').toLowerCase();
            const from = String(t?.from ?? '').toLowerCase();

            const direction: 'IN' | 'OUT' = to === address ? 'IN' : 'OUT';

            const px = token === 'ETH' ? priceMap.ETH : priceMap[token] ?? 0;
            const usd = px > 0 ? amount * px : null;

            const txHash = String(t?.hash ?? '').trim();
            if (!txHash) continue;

            const title = this.formatTradeTitle({ direction, token, amount, usd });
            const subtitle = this.inferVenueSubtitle(t);

            events.push(
                this.normalizeEvent({
                    id: this.makeDeterministicId({
                        type: 'TRADE',
                        txHash,
                        timestamp: ts,
                        extra: `${token}:${direction}`,
                    }),
                    type: 'TRADE',
                    title,
                    subtitle,
                    timestamp: ts,
                    metadata: {
                        txHash,
                        from,
                        to,
                        category: t?.category,
                        asset: token,
                        amount,
                        usd,
                    },
                }),
            );
        }

        return events;
    }

    private async getAiEvents(userId: string): Promise<TimelineEvent[]> {
        const res: any = await this.walletRecommendations.getRecommendations(userId);
        const recs = res?.data?.recommendations;
        if (!Array.isArray(recs) || !recs.length) return [];

        // Stable anchor: start of current UTC hour (reduces “random motion” while polling)
        const hourAnchor = this.utcHourStartMs(Date.now());

        return recs.slice(0, 6).map((r: any, idx: number) => {
            const title = String(r?.title ?? 'AI recommendation');
            const confidence = Math.round(Number(r?.confidence ?? 0));
            const action = String(r?.action ?? '');
            const priority = String(r?.priority ?? '');

            // deterministic timestamp within hour bucket
            const ts = hourAnchor - idx * 60_000;

            const key = `${title}|${action}|${priority}|${confidence}`;

            return this.normalizeEvent({
                id: this.makeDeterministicId({ type: 'AI_SIGNAL', timestamp: ts, extra: key }),
                type: 'AI_SIGNAL',
                title,
                subtitle: `Signal · Confidence ${confidence}%`,
                timestamp: ts,
                metadata: { priority, action, description: r?.description },
            });
        });
    }

    private async getRebalanceEvents(userId: string): Promise<TimelineEvent[]> {
        const intel: any = await this.walletIntelligence.getWalletIntelligence(userId);
        const stables = Number(intel?.data?.riskExposure?.Stables ?? 0);

        if (!Number.isFinite(stables) || stables < 25) return [];

        const dayAnchor = this.utcDayStartMs(Date.now());
        const ts = dayAnchor - 3_600_000; // 1h before day start (stable per UTC day)

        return [
            this.normalizeEvent({
                id: this.makeDeterministicId({
                    type: 'REBALANCE',
                    timestamp: ts,
                    extra: `stables=${Math.round(stables)}`,
                }),
                type: 'REBALANCE',
                title: `Defensive sleeve elevated (Stables ~${Math.round(stables)}%)`,
                subtitle: 'Strategy · Quarterly',
                timestamp: ts,
                metadata: { stables },
            }),
        ];
    }

    private async getAlertEvents(userId: string): Promise<TimelineEvent[]> {
        const intel: any = await this.walletIntelligence.getWalletIntelligence(userId);
        const memes = Number(intel?.data?.riskExposure?.Memes ?? 0);
        const stables = Number(intel?.data?.riskExposure?.Stables ?? 0);

        const events: TimelineEvent[] = [];

        const dayAnchor = this.utcDayStartMs(Date.now());

        if (Number.isFinite(memes) && memes > 12) {
            const ts = dayAnchor - 2_400_000;
            events.push(
                this.normalizeEvent({
                    id: this.makeDeterministicId({
                        type: 'ALERT',
                        timestamp: ts,
                        extra: `memes=${Math.round(memes)}`,
                    }),
                    type: 'ALERT',
                    title: `Meme exposure elevated (~${Math.round(memes)}%) — review risk`,
                    subtitle: 'Alert · Threshold',
                    timestamp: ts,
                    metadata: { memes },
                }),
            );
        }

        if (Number.isFinite(stables) && stables < 8) {
            const ts = dayAnchor - 2_700_000;
            events.push(
                this.normalizeEvent({
                    id: this.makeDeterministicId({
                        type: 'ALERT',
                        timestamp: ts,
                        extra: `stableslow=${Math.round(stables)}`,
                    }),
                    type: 'ALERT',
                    title: `Stable allocation low (~${Math.round(stables)}%) — liquidity risk`,
                    subtitle: 'Alert · Threshold',
                    timestamp: ts,
                    metadata: { stables },
                }),
            );
        }

        return events;
    }

    private async getSentimentEvents(): Promise<TimelineEvent[]> {
        const sig: any = await this.onchain.getOnchainSignals();
        const s = sig?.data?.sentiment;

        const score = Number(s?.score);
        const label = String(s?.label ?? 'Neutral');
        if (!Number.isFinite(score)) return [];

        // One event per UTC day (stable for polling)
        const ts = this.utcDayStartMs(Date.now()) - 1_800_000;

        return [
            this.normalizeEvent({
                id: this.makeDeterministicId({
                    type: 'SENTIMENT',
                    timestamp: ts,
                    extra: `fng=${Math.round(score)}:${label}`,
                }),
                type: 'SENTIMENT',
                title: `Fear & Greed: ${label} (${Math.round(score)})`,
                subtitle: 'Sentiment · Daily',
                timestamp: ts,
                metadata: { score, label, socialBuzz: s?.socialBuzz, fundingRates: s?.fundingRates },
            }),
        ];
    }

    // -----------------------------
    // Deterministic IDs + dedupe
    // -----------------------------
    private makeDeterministicId(input: {
        type: TimelineEventType;
        txHash?: string;
        timestamp: number;
        extra?: string;
    }): string {
        if (input.txHash) return `${input.type}-${input.txHash}`;
        const extra = input.extra ? `-${this.hashString(input.extra)}` : '';
        return `${input.type}-${input.timestamp}${extra}`;
    }

    private dedupeKey(e: TimelineEvent): string {
        const txHash = typeof e.metadata?.txHash === 'string' ? e.metadata.txHash : '';
        if (txHash) return `${e.type}|tx:${txHash}`;
        return `${e.type}|ts:${e.timestamp}|id:${e.id}`;
    }

    private dedupeEvents(events: TimelineEvent[]): TimelineEvent[] {
        const map = new Map<string, TimelineEvent>();
        for (const e of events) {
            const k = this.dedupeKey(e);
            if (!map.has(k)) map.set(k, e);
        }
        return [...map.values()];
    }

    private normalizeEvent(input: {
        id: string;
        type: TimelineEventType;
        title: string;
        subtitle: string;
        timestamp: number;
        metadata?: Record<string, any>;
    }): TimelineEvent {
        return {
            id: input.id,
            type: input.type,
            title: input.title.trim(),
            subtitle: input.subtitle.trim(),
            timestamp: input.timestamp,
            metadata: input.metadata,
        };
    }

    private generateNarrative(events: TimelineEvent[]): string {
        const types = new Set(events.map((e) => e.type));
        if (!events.length) return 'No timeline events yet.';

        if (types.has('TRADE') && types.has('AI_SIGNAL') && types.has('SENTIMENT')) {
            return 'Recent on-chain activity is showing alongside AI signals and broader sentiment — useful context before taking action.';
        }
        if (types.has('AI_SIGNAL') && types.has('SENTIMENT')) {
            return 'AI guidance and sentiment are both present — review sizing and risk before deploying more capital.';
        }
        if (types.has('TRADE')) {
            return 'Wallet activity is updating; pair transfers with alerts and AI signals to interpret intent (accumulation vs distribution).';
        }
        return 'Timeline is active; keep polling for incremental updates as new events arrive.';
    }

    // -----------------------------
    // Pricing + utils
    // -----------------------------
    private formatTradeTitle(input: {
        direction: 'IN' | 'OUT';
        token: string;
        amount: number;
        usd: number | null;
    }): string {
        const verb = input.direction === 'IN' ? 'Bought' : 'Sold';
        const amt = Number(input.amount.toFixed(6));

        if (input.usd && input.usd > 0) {
            const usd = Math.round(input.usd);
            return `${verb} ${amt} ${input.token} @ $${usd.toLocaleString('en-US')}`;
        }

        return `${verb} ${amt} ${input.token}`;
    }

    private inferVenueSubtitle(t: any): string {
        const cat = String(t?.category ?? '').toLowerCase();
        if (cat.includes('erc20')) return 'Spot · On-chain transfer';
        return 'Spot · Native transfer';
    }

    private async getUsdPrices(symbols: string[]): Promise<Record<string, number>> {
        const baseUrl = process.env.COINGECKO_BASE_URL;
        const apiKey = process.env.COINGECKO_API_KEY;
        if (!baseUrl || !apiKey) return {};

        const map: Record<string, string> = {
            ETH: 'ethereum',
            BTC: 'bitcoin',
            WBTC: 'wrapped-bitcoin',
            SOL: 'solana',
            ARB: 'arbitrum',
            USDC: 'usd-coin',
            USDT: 'tether',
            DAI: 'dai',
        };

        const ids = [...new Set(symbols.map((s) => map[s.toUpperCase()]).filter(Boolean))].join(',');
        if (!ids) return {};

        try {
            const res = await fetch(`${baseUrl}/simple/price?ids=${ids}&vs_currencies=usd`, {
                headers: { 'x_cg_demo_api_key': apiKey },
            });
            if (!res.ok) return {};

            const json = await res.json();
            const out: Record<string, number> = {};

            for (const sym of symbols) {
                const id = map[sym.toUpperCase()];
                if (id && json?.[id]?.usd) out[sym.toUpperCase()] = json[id].usd;
            }

            return out;
        } catch {
            return {};
        }
    }

    private utcHourStartMs(ts: number): number {
        const d = new Date(ts);
        d.setUTCMinutes(0, 0, 0);
        return d.getTime();
    }

    private utcDayStartMs(ts: number): number {
        const d = new Date(ts);
        d.setUTCHours(0, 0, 0, 0);
        return d.getTime();
    }

    /**
     * Tiny stable hash for deterministic IDs when txHash is missing.
     * (Not cryptographic security — just stable dedupe helper.)
     */
    private hashString(s: string): string {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16);
    }

    private async set(key: string, value: unknown, ttl: number) {
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

type CachedSnapshot = {
    events: TimelineEvent[];
    generatedAt: string;
};