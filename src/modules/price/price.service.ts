import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'FRAX', 'FDUSD', 'LUSD']);

const COIN_ID_MAP: Record<string, string> = {
    ETH: 'ethereum', WETH: 'weth', BTC: 'bitcoin', WBTC: 'wrapped-bitcoin',
    SOL: 'solana', BNB: 'binancecoin', ARB: 'arbitrum', OP: 'optimism',
    MATIC: 'matic-network', LINK: 'chainlink', AVAX: 'avalanche-2',
    NEAR: 'near', UNI: 'uniswap', AAVE: 'aave', CRV: 'curve-dao-token',
    LDO: 'lido-dao', MKR: 'maker', USDC: 'usd-coin', USDT: 'tether',
    DAI: 'dai', BUSD: 'binance-usd', FRAX: 'frax', DOGE: 'dogecoin',
    SHIB: 'shiba-inu', PEPE: 'pepe', HEX: 'hex',
};

const BINANCE_MAP: Record<string, string> = {
    ETH: 'ETHUSDT', BTC: 'BTCUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT',
    ARB: 'ARBUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', AVAX: 'AVAXUSDT',
    NEAR: 'NEARUSDT', UNI: 'UNIUSDT', AAVE: 'AAVEUSDT', DOGE: 'DOGEUSDT',
    SHIB: 'SHIBUSDT', PEPE: 'PEPEUSDT', WBTC: 'WBTCUSDT',
};

const PRICE_CACHE_KEY = 'prices:global:v1';
const PRICE_TTL = 60; // seconds

@Injectable()
export class PriceService {
    private readonly logger = new Logger(PriceService.name);

    constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

    // ─── Main: get prices for multiple symbols ─────────────────────────────

    async getPrices(symbols: string[]): Promise<Record<string, number>> {
        const unique = [...new Set(symbols.map((s) => s.toUpperCase()))];

        // 1) Stablecoins are always $1 — no API needed
        const out: Record<string, number> = {};
        const toFetch: string[] = [];

        for (const sym of unique) {
            if (STABLES.has(sym)) out[sym] = 1.0;
            else toFetch.push(sym);
        }

        if (!toFetch.length) return out;

        // 2) Check shared Redis cache
        const cached = await this.getCached();
        for (const sym of toFetch) {
            if (cached[sym] !== undefined) out[sym] = cached[sym];
        }

        const missing = toFetch.filter((s) => out[s] === undefined);
        if (!missing.length) return out;

        // 3) Fetch missing from CoinGecko
        const fresh = await this.fetchFromCoinGecko(missing);

        // 4) If rate limited → try Binance
        const fromBinance = Object.keys(fresh).length === 0
            ? await this.fetchFromBinance(missing)
            : {};

        const fetched = { ...fresh, ...fromBinance };

        // 5) Merge into cache and return
        if (Object.keys(fetched).length > 0) {
            await this.updateCache({ ...cached, ...fetched });
        }

        return { ...out, ...fetched };
    }

    async getPrice(symbol: string): Promise<number> {
        const result = await this.getPrices([symbol]);
        return result[symbol.toUpperCase()] ?? 0;
    }

    // ─── CoinGecko fetch ───────────────────────────────────────────────────

    private async fetchFromCoinGecko(symbols: string[]): Promise<Record<string, number>> {
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

            if (res.status === 429) {
                this.logger.warn('[PriceService] CoinGecko rate limit — switching to Binance');
                return {};
            }
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

    // ─── Binance fallback ──────────────────────────────────────────────────

    private async fetchFromBinance(symbols: string[]): Promise<Record<string, number>> {
        const pairs = [...new Set(symbols.map((s) => BINANCE_MAP[s]).filter(Boolean))];
        if (!pairs.length) return {};

        try {
            const encoded = encodeURIComponent(JSON.stringify(pairs));
            const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encoded}`);
            if (!res.ok) return {};

            const json: Array<{ symbol: string; price: string }> = await res.json();
            const out: Record<string, number> = {};
            for (const sym of symbols) {
                const pair = BINANCE_MAP[sym];
                const entry = json.find((t) => t.symbol === pair);
                if (entry) out[sym] = Number(entry.price);
            }
            this.logger.log(`[PriceService] Binance filled ${Object.keys(out).length} prices`);
            return out;
        } catch {
            return {};
        }
    }

    // ─── Shared Redis cache ────────────────────────────────────────────────

    private async getCached(): Promise<Record<string, number>> {
        const raw = await this.redis.get(PRICE_CACHE_KEY);
        return raw ? JSON.parse(raw) : {};
    }

    private async updateCache(prices: Record<string, number>): Promise<void> {
        await this.redis.set(PRICE_CACHE_KEY, JSON.stringify(prices), 'EX', PRICE_TTL);
    }
}