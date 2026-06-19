import 'dotenv/config';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import supabase from '../lib/supabase.js';
import { getCoinMetadata } from '../lib/suiClient.js';

// ── CoinGecko setup ───────────────────────────────────────────────────────────

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

const cgHeaders = COINGECKO_API_KEY
    ? { 'x-cg-demo-api-key': COINGECKO_API_KEY }
    : {};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Exclusion filters ─────────────────────────────────────────────────────────
// BASE_EXCLUSIONS apply to every category: stables, LSTs, wrapped/bridged.
// MAJOR_EXCLUSIONS additionally ban BTC/ETH-named assets — correct for the
// market_cap universe, but deliberately NOT applied to meme (meme tokens
// legitimately riff on "btc"/"eth" in names and a substring ban misfires).

const BASE_EXCLUSIONS = [
    'usdc', 'usdt', 'dai', 'busd', 'tusd', 'fdusd', 'ausd', 'usdy',
    'buck', 'usde', 'edollar',
    'hasui', 'vsui', 'afsui',
    'wrapped', 'bridged', 'wormhole', 'portal', 'celer',
];

const MAJOR_EXCLUSIONS = [
    'bitcoin', 'wbtc', 'tbtc', 'lbtc', 'sbtc', 'cbbtc', 'btc',
    'ethereum', 'weth', 'eth', 'steth', 'reth', 'cbeth',
    'binance', 'polygon', 'avalanche', 'solana',
];

const DYNAMIC_FILTERS = {
    namePatterns: [
        /\bliquid staking derivative/i,
        /\bliquid staking token/i,
        /\brepresent(?:s|ing)?\s+staked/i,
        /\bstaked\s+\w+\s+token/i,
        /\bstable\s*coin/i,
        /\busd[-\s]pegged\b/i,
        /\bpegged\s+to\s+(?:usd|dollar)/i,
        /\be[-\s]?dollar/i,
        /\bsui\s+dollar/i
    ]
};

// ── Per-category tracker configs ──────────────────────────────────────────────
// A config sources its candidate universe one of three ways:
//   source: 'category' — single CoinGecko category slug (e.g. sui-meme).
//   source: 'platform' — enumerate every token on a chain via coins/list, then
//                        pull market data by ids; pair with categoryTags to admit
//                        only the right sector (DeFi has no 'sui-defi' slug).
//   source: 'explicit' — a hand-curated JSON list of coin-type addresses (the
//                        address is the identity; CoinGecko is enrichment only).
//                        No floors, no tag filter — the curator IS the filter.
//                        Reused later for Seal-sealed creator baskets.

const envNum = (name, fallback) => {
    const v = parseFloat(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
};

// CoinGecko detail `categories` tags that qualify a token as DeFi (parent tag
// reproduces the decentralized-finance-defi category page exactly).
const DEFI_CATEGORY_TAGS = [
    'Decentralized Finance (DeFi)',
];

const TRACKER_CONFIGS = [
    {
        dbCategory:   'market_cap',
        source:       'category',
        cgCategory:   'sui-ecosystem',
        minVolume24h: envNum('MIN_VOLUME_24H', 50_000),          // live .env: 250k
        minMarketCap: envNum('MIN_MARKET_CAP', 0),
        minTokens:    10,
        bufferSize:   15,
        exclusions:   [...BASE_EXCLUSIONS, ...MAJOR_EXCLUSIONS],
        routeCheck:   false,
    },
    {
        dbCategory:   'meme',
        source:       'category',
        cgCategory:   'sui-meme',
        minVolume24h: envNum('MIN_VOLUME_24H_MEME', 25_000),
        minMarketCap: envNum('MIN_MARKET_CAP_MEME', 1_000_000),
        minTokens:    3,
        bufferSize:   10,
        exclusions:   BASE_EXCLUSIONS,
        routeCheck:   true,
    },
    {
        dbCategory:   'defi',
        source:       'platform',
        platformId:   'sui',
        categoryTags: DEFI_CATEGORY_TAGS,
        minVolume24h: envNum('MIN_VOLUME_24H_DEFI', 15_000),
        minMarketCap: envNum('MIN_MARKET_CAP_DEFI', 500_000),
        minTokens:    3,
        bufferSize:   20,
        exclusions:   BASE_EXCLUSIONS,
        routeCheck:   true,
        allowMultichain: true,   // protocol tokens may be cross-chain listed; keep them if they have a Sui address
    },
    {
        dbCategory:   'stack',
        source:       'explicit',
        addressFile:  'config/suix-stack.json', // resolved relative to ../ from this module
        minVolume24h: 0,         // curated — no floors
        minMarketCap: 0,
        minTokens:    2,
        bufferSize:   20,
        exclusions:   [],        // curated — trust the list
        routeCheck:   true,      // still gate tradeability
        allowMultichain: true,   // curated — don't drop on a multichain listing
    },
];

// ── Optional Cetus route check (admission criterion) ──────────────────────────

let _routeChecker = null;

async function canRouteToUsdc(coinType, decimals) {
    if (!_routeChecker) {
        const [{ SuiClient }, { AggregatorClient, Env }, BN] = await Promise.all([
            import('@mysten/sui/client'),
            import('@cetusprotocol/aggregator-sdk'),
            import('bn.js').then(m => m.default || m),
        ]);
        const suiClient = new SuiClient({
            url: process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443'
        });
        const cetus = new AggregatorClient({ client: suiClient, env: Env.Mainnet });
        const USDC_TYPE = process.env.USDC_COIN_TYPE ||
            '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
        _routeChecker = { cetus, BN, USDC_TYPE };
    }
    const { cetus, BN, USDC_TYPE } = _routeChecker;
    try {
        const amount = new BN(10).pow(new BN(decimals ?? 9));
        const router = await cetus.findRouters({
            from: coinType, target: USDC_TYPE, amount, byAmountIn: true,
        });
        if (!router || router.error || router.insufficientLiquidity) return false;
        return !!((router.routes?.length || router.paths?.length) &&
                  router.amountOut && new BN(router.amountOut.toString()).gtn(0));
    } catch {
        return false;
    }
}

// ── Filters ───────────────────────────────────────────────────────────────────

function shouldExcludeToken(token, exclusions, detailedInfo = null) {
    const name = token.name.toLowerCase();
    const symbol = token.symbol.toLowerCase();

    for (const keyword of exclusions) {
        if (name.includes(keyword) || symbol.includes(keyword)) {
            return { exclude: true, reason: `keyword '${keyword}'` };
        }
    }

    if (detailedInfo) {
        const combinedText = `${(detailedInfo.name || '').toLowerCase()} ${(detailedInfo.description?.en || '').toLowerCase()}`;
        for (const pattern of DYNAMIC_FILTERS.namePatterns) {
            if (pattern.test(combinedText)) {
                return { exclude: true, reason: `pattern match '${pattern}'` };
            }
        }
    }

    return { exclude: false };
}

// Shared cheap pre-filter (mcap / vol floors + keyword exclusions).
function preFilterMarkets(all, config) {
    return all.filter(t => {
        const mc  = t.market_cap || 0;
        const vol = t.total_volume || 0;
        if (mc < config.minMarketCap) {
            console.log(`   ⛔ ${t.symbol.toUpperCase()}: mcap $${mc.toLocaleString()} < $${config.minMarketCap.toLocaleString()}`);
            return false;
        }
        if (vol < config.minVolume24h) {
            console.log(`   ⛔ ${t.symbol.toUpperCase()}: vol $${vol.toLocaleString()} < $${config.minVolume24h.toLocaleString()}`);
            return false;
        }
        const kw = shouldExcludeToken(t, config.exclusions);
        if (kw.exclude) {
            console.log(`   ⛔ ${t.symbol.toUpperCase()}: ${kw.reason}`);
            return false;
        }
        return true;
    });
}

// ── Step 1a: Category-sourced candidates ──────────────────────────────────────

async function fetchCategoryCandidates(config) {
    console.log(`📊 [TokenTracker:${config.dbCategory}] Step 1: Fetching '${config.cgCategory}' from CoinGecko...`);

    const response = await axios.get(`${COINGECKO_BASE_URL}/coins/markets`, {
        headers: cgHeaders,
        params: {
            vs_currency: 'usd',
            category: config.cgCategory,
            order: 'market_cap_desc',
            per_page: config.perPage ?? 50,
            page: 1,
            sparkline: false
        }
    });

    const all = response.data;
    console.log(`   ✅ ${all.length} tokens in category`);

    const candidates = preFilterMarkets(all, config);
    console.log(`   ✅ ${candidates.length} candidates after pre-filter (mcap/vol/keywords)`);
    return candidates;
}

// ── Step 1b: Platform-sourced candidates ──────────────────────────────────────

let _coinsListCache = null;

async function fetchPlatformCoinIds(platformId) {
    if (!_coinsListCache) {
        const response = await axios.get(`${COINGECKO_BASE_URL}/coins/list`, {
            headers: cgHeaders,
            params: { include_platform: true },
        });
        _coinsListCache = response.data;
    }
    return _coinsListCache.filter(c => {
        const p = c.platforms || {};
        return (p[platformId] && p[platformId] !== '') || p[`${platformId}-network`];
    });
}

async function fetchPlatformCandidates(config) {
    const pid = config.platformId;
    console.log(`📊 [TokenTracker:${config.dbCategory}] Step 1: Enumerating '${pid}' platform tokens...`);

    const platformCoins = await fetchPlatformCoinIds(pid);
    console.log(`   ✅ ${platformCoins.length} ${pid}-platform coins in CoinGecko list`);

    const ids = platformCoins.map(c => c.id);
    const all = [];

    for (let i = 0; i < ids.length; i += 250) {
        const chunk = ids.slice(i, i + 250);
        await sleep(1500);
        const response = await axios.get(`${COINGECKO_BASE_URL}/coins/markets`, {
            headers: cgHeaders,
            params: {
                vs_currency: 'usd',
                ids: chunk.join(','),
                order: 'market_cap_desc',
                per_page: 250,
                page: 1,
                sparkline: false,
            },
        });
        all.push(...response.data);
    }

    all.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
    console.log(`   ✅ ${all.length} ${pid}-platform tokens with market data`);

    const candidates = preFilterMarkets(all, config);
    console.log(`   ✅ ${candidates.length} candidates after pre-filter (mcap/vol/keywords) — sector tag check happens in Step 2`);
    return candidates;
}

// ── Step 1c: Explicit (curated address list) candidates ───────────────────────
// The JSON file is the source of truth. Each entry carries the Sui coin-type
// address (identity) and an optional coingecko_id (price/mcap enrichment for
// display + market-cap weighting; not required). Candidates come back already
// in "verified" shape — sui_address is known — so Step 2 is skipped. Order is
// preserved from the file so rank reflects the curator's layer ordering.

async function fetchExplicitCandidates(config) {
    console.log(`📊 [TokenTracker:${config.dbCategory}] Step 1: Reading curated list '${config.addressFile}'...`);

    const fileUrl = new URL(`../${config.addressFile}`, import.meta.url);
    const entries = JSON.parse(readFileSync(fileUrl, 'utf8'));
    console.log(`   ✅ ${entries.length} tokens in curated list`);

    // Optional CoinGecko enrichment (one call) for entries that carry a coingecko_id.
    const ids = entries.map(e => e.coingecko_id).filter(Boolean);
    const mkt = {};
    if (ids.length) {
        try {
            const response = await axios.get(`${COINGECKO_BASE_URL}/coins/markets`, {
                headers: cgHeaders,
                params: { vs_currency: 'usd', ids: ids.join(','), per_page: 250, page: 1, sparkline: false },
            });
            for (const m of response.data) mkt[m.id] = m;
            console.log(`   ✅ enriched ${response.data.length}/${ids.length} from CoinGecko`);
        } catch (err) {
            console.log(`   ⚠️  CoinGecko enrichment failed (${err.message}) — proceeding with addresses only`);
        }
    }

    return entries.map(e => {
        const m = e.coingecko_id ? mkt[e.coingecko_id] : null;
        return {
            sui_address:      e.address,
            coingecko_id:     e.coingecko_id ?? null,
            symbol:           (m?.symbol || e.symbol || e.coingecko_id || 'TOKEN').toUpperCase(),
            name:             m?.name || e.label || e.symbol || e.coingecko_id,
            market_cap:       m?.market_cap ?? null,
            current_price:    m?.current_price ?? null,
            volume_24h:       m?.total_volume ?? null,
            price_change_24h: m?.price_change_percentage_24h ?? null,
        };
    });
}

function fetchCandidates(config) {
    if (config.source === 'explicit') return fetchExplicitCandidates(config);
    if (config.source === 'platform') return fetchPlatformCandidates(config);
    return fetchCategoryCandidates(config);
}

// ── Step 2: Detail fetch survivors — Sui address, bridged check, patterns, tags ─

async function verifyCandidates(candidates, config) {
    console.log(`🔄 [TokenTracker:${config.dbCategory}] Step 2: Detail verification...`);

    const results = [];
    const emptyErrors = [];

    for (let i = 0; i < candidates.length; i++) {
        const token = candidates[i];
        const symbol = token.symbol.toUpperCase();

        if (results.length >= config.bufferSize) {
            console.log(`   ✅ Buffer of ${config.bufferSize} reached — stopping`);
            break;
        }

        console.log(`   🔎 [${i + 1}/${candidates.length}] ${symbol}...`);

        try {
            await sleep(1500);

            const response = await axios.get(`${COINGECKO_BASE_URL}/coins/${token.id}`, {
                headers: cgHeaders,
                params: { localization: false, tickers: false, market_data: true, community_data: false, developer_data: false }
            });

            const detail = response.data;

            const filterResult = shouldExcludeToken(token, config.exclusions, detail);
            if (filterResult.exclude) {
                console.log(`   ⛔ ${symbol}: ${filterResult.reason}`);
                continue;
            }

            const volume24h = detail.market_data?.total_volume?.usd || 0;
            if (volume24h < config.minVolume24h) {
                console.log(`   ⛔ ${symbol}: Low volume ($${volume24h.toLocaleString()})`);
                continue;
            }

            const priceChange24h = detail.market_data?.price_change_percentage_24h ?? null;

            const platforms = detail.platforms || {};
            const suiAddress = platforms.sui || platforms['sui-network'];
            const hasOtherChain = platforms.ethereum || platforms['binance-smart-chain'] ||
                                  platforms.solana || platforms.polygon || platforms.avalanche;

            if (!suiAddress) {
                console.log(`   ⚠️  ${symbol}: No SUI address`);
                continue;
            }
            if (hasOtherChain && !config.allowMultichain) {
                console.log(`   ⛔ ${symbol}: Bridged token`);
                continue;
            }

            if (config.categoryTags) {
                const tags = detail.categories || [];
                const matched = tags.some(t => config.categoryTags.includes(t));
                if (!matched) {
                    console.log(`   ⛔ ${symbol}: not tagged ${config.dbCategory} (${tags.filter(Boolean).slice(0, 4).join(', ') || 'no tags'})`);
                    continue;
                }
                console.log(`   🏷️  ${symbol}: ${config.dbCategory}-tagged`);
            }

            console.log(`   ✅ ${symbol}: vol $${volume24h.toLocaleString()} | ${suiAddress.substring(0, 30)}...`);
            results.push({ ...token, coingecko_id: token.id, sui_address: suiAddress, volume_24h: volume24h, price_change_24h: priceChange24h });

        } catch (error) {
            if (error.response?.status === 429) {
                console.log(`   ⏳ ${symbol}: Rate limited — waiting 5s`);
                await sleep(5000);
                i--;
            } else {
                const msg = error.message?.trim() || '';
                if (!msg) {
                    console.log(`   ❌ ${symbol}: [EMPTY ERROR]`);
                    emptyErrors.push(symbol);
                } else {
                    console.log(`   ❌ ${symbol}: ${msg}`);
                }
            }
        }
    }

    console.log(`   ✅ ${results.length} tokens verified`);
    return { results, emptyErrors };
}

// ── Step 3: Decimals via Sui RPC + optional Cetus route admission check ───────

async function enrichWithDecimals(tokens, config) {
    console.log(`🔬 [TokenTracker:${config.dbCategory}] Step 3: RPC decimals${config.routeCheck ? ' + route check' : ''}...`);

    const enriched = [];

    for (const token of tokens) {
        const symbol = (token.symbol || token.coingecko_id || 'TOKEN').toString().toUpperCase();

        try {
            await sleep(200);
            const metadata = await getCoinMetadata(token.sui_address);

            if (!metadata || metadata.decimals === undefined) {
                console.log(`   ⚠️  ${symbol}: No RPC metadata — skipping`);
                continue;
            }

            if (config.routeCheck) {
                const routable = await canRouteToUsdc(token.sui_address, metadata.decimals);
                if (!routable) {
                    console.log(`   ⛔ ${symbol}: No Cetus route to USDC — NOT admitted`);
                    continue;
                }
                console.log(`   🛣️  ${symbol}: Cetus route OK`);
            }

            enriched.push({
                rank:         enriched.length + 1,
                symbol,
                name:         token.name || metadata.name || symbol,
                market_cap:   token.market_cap,
                price_usd:    token.current_price,
                coin_type:    token.sui_address,
                coingecko_id: token.coingecko_id,
                decimals:     metadata.decimals,
                volume_24h:   token.volume_24h,
                price_change_24h: token.price_change_24h ?? null,
            });
            console.log(`   ✅ ${symbol}: ${metadata.decimals} decimals`);
        } catch (error) {
            console.log(`   ❌ ${symbol}: RPC error — ${error.message}`);
        }
    }

    console.log(`   ✅ ${enriched.length} tokens admitted`);
    return enriched;
}

// ── Step 4: Upsert + category-scoped deactivation ─────────────────────────────

async function writeToSupabase(tokens, config) {
    console.log(`💾 [TokenTracker:${config.dbCategory}] Step 4: Upserting to utility.tokens...`);

    const now = new Date().toISOString();
    const currentCoinTypes = tokens.map(t => t.coin_type);
    let count = 0;

    for (const token of tokens) {
        const { error } = await supabase
            .from('tokens')
            .upsert({
                coin_type:      token.coin_type,
                symbol:         token.symbol,
                name:           token.name,
                price_usd:      token.price_usd,
                market_cap_usd: token.market_cap,
                volume_24h_usd: token.volume_24h,
                price_change_24h_pct: token.price_change_24h ?? null,
                decimals:       token.decimals,
                category:       config.dbCategory,
                rank:           token.rank,
                is_active:      true,
                coingecko_id:   token.coingecko_id,
                last_updated:   now
            }, { onConflict: 'coin_type,category' });

        if (error) {
            console.log(`   ❌ ${token.symbol}: ${error.message}`);
        } else {
            console.log(`   ✅ ${token.symbol} (rank ${token.rank})`);
            count++;
        }
    }

    const { error: deactivateError } = await supabase
        .from('tokens')
        .update({ is_active: false, last_updated: now })
        .eq('category', config.dbCategory)
        .eq('is_active', true)
        .not('coin_type', 'in', `(${currentCoinTypes.map(ct => `"${ct}"`).join(',')})`);

    if (deactivateError) {
        console.log(`   ⚠️  Deactivation error: ${deactivateError.message}`);
    } else {
        console.log(`   ✅ Dropped ${config.dbCategory} tokens deactivated`);
    }

    console.log(`   ✅ ${count}/${tokens.length} tokens written`);
    return count;
}

// ── Per-category pipeline ─────────────────────────────────────────────────────

async function runCategory(config) {
    const sourceLabel =
        config.source === 'platform' ? `${config.platformId} platform`
      : config.source === 'explicit' ? `curated: ${config.addressFile}`
      : config.cgCategory;

    console.log('\n' + '─'.repeat(50));
    console.log(`🚀 [TokenTracker] Category: ${config.dbCategory} (${sourceLabel})`);
    console.log(`   floors: mcap ≥ $${config.minMarketCap.toLocaleString()}, vol ≥ $${config.minVolume24h.toLocaleString()}, min ${config.minTokens} tokens`);
    console.log('─'.repeat(50));

    const candidates = await fetchCandidates(config);

    // Explicit (curated) lists are already verified — the address IS the identity,
    // and there are no floors or sector tags to apply. Skip Step 2 for them.
    let verified, emptyErrors = [];
    if (config.source === 'explicit') {
        verified = candidates;
        console.log(`🔄 [TokenTracker:${config.dbCategory}] Step 2: skipped (curated list — ${verified.length} tokens)`);
    } else {
        ({ results: verified, emptyErrors } = await verifyCandidates(candidates, config));
    }

    const tokens = await enrichWithDecimals(verified, config);

    if (emptyErrors.length > 0) {
        throw new Error(`[${config.dbCategory}] Quality check failed — empty errors for: ${emptyErrors.join(', ')}`);
    }
    if (tokens.length < config.minTokens) {
        throw new Error(`[${config.dbCategory}] Quality check failed — only ${tokens.length}/${config.minTokens} tokens found`);
    }

    console.log(`\n🏆 ${config.dbCategory}: ${tokens.length} tokens admitted:`);
    tokens.forEach(t => {
        console.log(`   ${String(t.rank).padStart(2)}. ${t.symbol.padEnd(8)} MC: $${(t.market_cap ?? 0).toLocaleString()} | Vol: $${(t.volume_24h ?? 0).toLocaleString()}`);
    });

    const tokensUpdated = await writeToSupabase(tokens, config);
    return { category: config.dbCategory, tokens, tokensUpdated };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runTokenTracker() {
    const runs = [];
    const failures = [];

    for (const config of TRACKER_CONFIGS) {
        try {
            runs.push(await runCategory(config));
        } catch (err) {
            console.log(`❌ [TokenTracker] ${config.dbCategory} failed: ${err.message}`);
            failures.push({ category: config.dbCategory, error: err.message });
        }
    }

    const tokensUpdated = runs.reduce((sum, r) => sum + r.tokensUpdated, 0);
    const tokens = runs.flatMap(r => r.tokens);

    console.log(`\n${failures.length ? '⚠️' : '✅'} [TokenTracker] ${runs.length}/${TRACKER_CONFIGS.length} categories OK — ${tokensUpdated} tokens written`);

    if (failures.length === TRACKER_CONFIGS.length) {
        throw new Error(`All categories failed: ${failures.map(f => `${f.category}: ${f.error}`).join(' | ')}`);
    }

    return { tokens, tokensUpdated, runs, failures };
}
