import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { Web3Service } from '../../config/web3.service';
import { AssetTransfersCategory } from '../../common/constants/constants';
import { SortingOrder } from 'alchemy-sdk';

type Impact = 'high' | 'medium';

type WhaleMovement = {
    wallet: string;
    label: string;
    action: string;
    timeAgo: string;
    impact: Impact;
};

type MarketSentiment = {
    score: number;
    label: string;
    socialBuzz: number;
    fundingRates: number;
};

type WhaleRow = {
    wallet: string;
    token: string;
    balance: number;
    changePercent: number;
};

type TokenFlow = { inflow: number; outflow: number };

type TokenFlows = Record<'ETH' | 'BTC' | 'SOL' | 'ARB', TokenFlow>;

type OnchainSignalsResponse = {
    success: true;
    data: {
        movements: WhaleMovement[];
        sentiment: MarketSentiment;
        whales: WhaleRow[];
        flows: TokenFlows;
        interpretation?: string;
    };
    cache?: boolean;
};

@Injectable()
export class OnchainService {
    private readonly logger = new Logger(OnchainService.name);

    private static readonly CACHE_KEY = 'onchain:signals';
    private static readonly CACHE_TTL_SECONDS = 90;

    // MVP thresholds (tune later)
    private static readonly LARGE_USD_THRESHOLD = 50_000;
    private static readonly MOVEMENTS_LIMIT = 5;
    private static readonly WHALES_LIMIT = 4;

    // Known exchange hot wallets (extend as needed)
    private readonly exchangeAddresses = new Set<string>([
        '0x28c6c06298d514db089934071355e5743bf21d60'.toLowerCase(), // Binance 14 (example)
        '0x21a31ee1afc51d94c2efccaa2092ad1028285549'.toLowerCase(), // Binance 20 (example)
        '0xdfd5293d8e347dfe59e90efd55bf0a47122dbb0f'.toLowerCase(), // Binance 21 (example)
        '0x56eddb7aa87536c09ccc2793473599fd21a8b0f6'.toLowerCase(), // Binance 22 (example)
        '0x9696f59e4d72e237be84ffd425dcad154bf96976'.toLowerCase(), // Binance 23 (example)
        '0x47ac0fb4f2d84898e4d9e7b4dab02c933d299694'.toLowerCase(), // Binance 8 (example)
    ]);

    constructor(
        private readonly web3Service: Web3Service,
        @Inject('REDIS_CLIENT') private readonly redis: Redis,
    ) { }

    async getOnchainSignals(): Promise<OnchainSignalsResponse> {
        const cached = await this.get<OnchainSignalsResponse>(OnchainService.CACHE_KEY);
        if (cached) return { ...cached, cache: true };

        const [movements, sentiment, whales, flows] = await Promise.all([
            this.getWhaleMovements().catch(() => [] as WhaleMovement[]),
            this.getMarketSentiment().catch(() => this.fallbackSentiment()),
            this.getWhaleTracking().catch(() => [] as WhaleRow[]),
            this.getTokenFlows().catch(() => this.emptyFlows()),
        ]);

        const interpretation = this.buildInterpretation({ sentiment, flows, movements });

        const result: OnchainSignalsResponse = {
            success: true,
            data: {
                movements,
                sentiment,
                whales,
                flows,
                interpretation,
            },
            cache: false,
        };

        await this.set(OnchainService.CACHE_KEY, result, OnchainService.CACHE_TTL_SECONDS);
        return result;
    }

    // -----------------------------
    // Step 1: Smart money movements
    // -----------------------------
    private async getWhaleMovements(): Promise<WhaleMovement[]> {
        const alchemy = this.web3Service.alchemy;

        // Pull recent large activity (global chain view)
        const res = await alchemy.core.getAssetTransfers({
            fromBlock: '0x0',
            category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
            withMetadata: true,
            excludeZeroValue: true,
            maxCount: 100,
            order: SortingOrder.DESCENDING,
        });

        const transfers = res.transfers ?? [];
        if (!transfers.length) return [];

        const priceMap = await this.getUsdPrices(['ETH', 'BTC', 'WBTC', 'USDC', 'USDT', 'DAI']);

        const scored = transfers
            .map((t: any) => {
                const ts = t?.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : 0;
                if (!ts) return null;

                const token = String(t?.asset ?? 'ETH').toUpperCase();
                const from = String(t?.from ?? '').toLowerCase();
                const to = String(t?.to ?? '').toLowerCase();

                const usd = this.estimateTransferUsd(t, token, priceMap);
                if (!usd || usd < OnchainService.LARGE_USD_THRESHOLD) return null;

                const exchangeTo = this.exchangeAddresses.has(to);
                const exchangeFrom = this.exchangeAddresses.has(from);

                let label = 'Large on-chain transfer';
                let action = `${token} moved on-chain`;

                if (exchangeTo) {
                    label = 'CEX deposit';
                    action = `Deposited ${token} to exchange`;
                } else if (exchangeFrom) {
                    label = 'CEX withdrawal';
                    action = `Withdrew ${token} from exchange`;
                } else if (token === 'ETH' || token === 'WBTC' || token === 'BTC') {
                    label = 'Large native move';
                    action = `Large ${token} transfer`;
                }

                const wallet = exchangeFrom ? from : exchangeTo ? to : from || to;

                return {
                    wallet,
                    label,
                    action,
                    timeAgo: this.timeAgo(ts),
                    impact: usd >= 250_000 ? ('high' as const) : ('medium' as const),
                    _ts: ts,
                    _usd: usd,
                };
            })
            .filter(Boolean) as Array<WhaleMovement & { _ts: number; _usd: number }>;

        scored.sort((a, b) => b._ts - a._ts);

        return scored.slice(0, OnchainService.MOVEMENTS_LIMIT).map(({ _ts, _usd, ...rest }) => rest);
    }

    private estimateTransferUsd(
        t: any,
        token: string,
        priceMap: Record<string, number>,
    ): number | null {
        // EXTERNAL ETH transfers often have numeric `value`
        const rawValue = Number(t?.value ?? 0);

        if (token === 'ETH') {
            const ethUsd = priceMap.ETH ?? 0;
            if (!ethUsd || !rawValue) return null;
            return rawValue * ethUsd;
        }

        // ERC20: `value` is usually token amount (not wei-normalized in Alchemy transfers)
        // MVP: treat as human-ish amount * spot (works for many tokens; refine later with decimals)
        const px =
            token === 'WBTC' || token === 'BTC'
                ? priceMap.WBTC || priceMap.BTC
                : priceMap[token];

        if (!px || !rawValue) return null;
        return rawValue * px;
    }

    // -----------------------------
    // Step 2: Sentiment
    // -----------------------------
    private async getMarketSentiment(): Promise<MarketSentiment> {
        const url =
            process.env.FEAR_GREED_URL ?? 'https://api.alternative.me/fng/?limit=1';

        const res = await fetch(url);
        if (!res.ok) return this.fallbackSentiment();

        const json: any = await res.json();
        const item = json?.data?.[0];
        const score = Number(item?.value);
        if (!Number.isFinite(score)) return this.fallbackSentiment();

        const label = String(item?.value_classification ?? 'Neutral');

        return {
            score: Math.round(score),
            label,
            socialBuzz: this.randInt(60, 80),
            fundingRates: this.randInt(40, 70),
        };
    }

    private fallbackSentiment(): MarketSentiment {
        return {
            score: 50,
            label: 'Neutral',
            socialBuzz: 70,
            fundingRates: 55,
        };
    }

    // -----------------------------
    // Step 3: Whale tracking (MVP)
    // -----------------------------
    private async getWhaleTracking(): Promise<WhaleRow[]> {
        const alchemy = this.web3Service.alchemy;

        const res = await alchemy.core.getAssetTransfers({
            fromBlock: '0x0',
            category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
            withMetadata: true,
            excludeZeroValue: true,
            maxCount: 100,
            order: SortingOrder.DESCENDING,
        });

        const transfers = res.transfers ?? [];
        if (!transfers.length) return [];

        const priceMap = await this.getUsdPrices(['ETH', 'BTC', 'WBTC', 'USDC', 'USDT', 'DAI', 'ARB', 'SOL']);

        const incomingByWallet = new Map<string, { usd: number; token: string }>();

        for (const t of transfers) {
            const to = String(t?.to ?? '').toLowerCase();
            if (!to || this.exchangeAddresses.has(to)) continue;

            const token = String(t?.asset ?? 'ETH').toUpperCase();
            const usd = this.estimateTransferUsd(t, token, priceMap);
            if (!usd) continue;

            const prev = incomingByWallet.get(to);
            if (!prev || usd > prev.usd) {
                incomingByWallet.set(to, { usd, token });
            }
        }

        const rows: WhaleRow[] = Array.from(incomingByWallet.entries())
            .sort((a, b) => b[1].usd - a[1].usd)
            .slice(0, OnchainService.WHALES_LIMIT)
            .map(([wallet, v]) => ({
                wallet,
                token: v.token,
                balance: Number(v.usd.toFixed(0)),
                changePercent: this.randInt(1, 12), // MVP placeholder until you store snapshots
            }));

        return rows;
    }

    // -----------------------------
    // Step 4: Token flows (24h-ish)
    // -----------------------------
    private async getTokenFlows(): Promise<TokenFlows> {
        const alchemy = this.web3Service.alchemy;

        const latestBlockHex = await alchemy.core.getBlockNumber();
        const latest = Number(latestBlockHex);

        // ~24h on Ethereum mainnet (~7200 blocks)
        const fromBlock = Math.max(latest - 7200, 0);
        const fromBlockHex = '0x' + fromBlock.toString(16);

        const res = await alchemy.core.getAssetTransfers({
            fromBlock: fromBlockHex,
            category: [AssetTransfersCategory.EXTERNAL, AssetTransfersCategory.ERC20],
            withMetadata: true,
            excludeZeroValue: true,
            maxCount: 1000,
        });

        const transfers = res.transfers ?? [];
        if (!transfers.length) return this.emptyFlows();

        const flows = this.emptyFlows();
        const priceMap = await this.getUsdPrices(['ETH', 'BTC', 'WBTC', 'SOL', 'ARB']);

        for (const t of transfers) {
            const token = this.normalizeTokenKey(String(t?.asset ?? 'ETH').toUpperCase());
            if (!token) continue;

            const usd = this.estimateTransferUsd(t, String(t?.asset ?? 'ETH').toUpperCase(), priceMap);
            if (!usd) continue;

            const from = String(t?.from ?? '').toLowerCase();
            const to = String(t?.to ?? '').toLowerCase();

            // naive in/out classification: if exchange involved, treat as flow pressure
            const isIn = !this.exchangeAddresses.has(to) && this.exchangeAddresses.has(from);
            const isOut = this.exchangeAddresses.has(to) && !this.exchangeAddresses.has(from);

            if (isIn) flows[token].inflow += usd;
            else if (isOut) flows[token].outflow += usd;
            else {
                // fallback split: treat as neutral pressure (optional)
                flows[token].inflow += usd * 0.5;
                flows[token].outflow += usd * 0.5;
            }
        }

        // round
        (Object.keys(flows) as Array<keyof TokenFlows>).forEach((k) => {
            flows[k].inflow = Number(flows[k].inflow.toFixed(0));
            flows[k].outflow = Number(flows[k].outflow.toFixed(0));
        });

        return flows;
    }

    private normalizeTokenKey(symbol: string): keyof TokenFlows | null {
        if (symbol === 'ETH') return 'ETH';
        if (symbol === 'WBTC' || symbol === 'BTC') return 'BTC';
        if (symbol === 'SOL') return 'SOL';
        if (symbol === 'ARB') return 'ARB';
        return null;
    }

    private emptyFlows(): TokenFlows {
        return {
            ETH: { inflow: 0, outflow: 0 },
            BTC: { inflow: 0, outflow: 0 },
            SOL: { inflow: 0, outflow: 0 },
            ARB: { inflow: 0, outflow: 0 },
        };
    }

    // -----------------------------
    // Bonus interpretation (heuristic, no external AI required)
    // -----------------------------
    private buildInterpretation(input: {
        sentiment: MarketSentiment;
        flows: TokenFlows;
        movements: WhaleMovement[];
    }): string {
        const ethNet = input.flows.ETH.inflow - input.flows.ETH.outflow;
        const score = input.sentiment.score;

        const bias =
            score >= 60 ? 'risk-on sentiment' : score <= 40 ? 'risk-off sentiment' : 'neutral sentiment';

        const ethBias = ethNet > 0 ? 'ETH flows skew toward accumulation' : 'ETH flows skew toward distribution';

        const cexBias =
            input.movements.some((m) => m.label === 'CEX withdrawal')
                ? 'notable exchange withdrawals detected'
                : input.movements.some((m) => m.label === 'CEX deposit')
                    ? 'notable exchange deposits detected'
                    : 'mixed exchange-related activity';

        return `Market shows ${bias}. ${ethBias}, with ${cexBias}.`;
    }

    // -----------------------------
    // Pricing helper (reuse your CoinGecko pattern)
    // -----------------------------
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

    // -----------------------------
    // Utils
    // -----------------------------
    private timeAgo(tsMs: number): string {
        const sec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
        if (sec < 60) return `${sec}s ago`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const d = Math.floor(hr / 24);
        return `${d}d ago`;
    }

    private randInt(min: number, max: number): number {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    private async set(key: string, value: unknown, ttlSeconds: number) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }

    private async get<T>(key: string): Promise<T | null> {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
    }
}