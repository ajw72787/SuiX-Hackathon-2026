import 'dotenv/config';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { AggregatorClient, Env } from '@cetusprotocol/aggregator-sdk';
import BN from 'bn.js';
import supabase from '../lib/supabase.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SUI_TYPE  = '0x2::sui::SUI';
const USDC_TYPE = process.env.USDC_COIN_TYPE ||
    '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

const GAS_RESERVE_MIST = 100_000_000n;  // 0.1 SUI always ring-fenced for gas
const DRIFT_THRESHOLD  = 0.04;          // 4% drift triggers yellow status
const MIN_TRADE_USD    = parseFloat(process.env.MIN_TRADE_USD) || 0.05; // min USD per swap (env-tunable)
const MIN_HOLDING_USD  = 0.01;          // ignore dust holdings under $0.01

// For SUI-less baskets: SUI above this buffer is treated as INVESTABLE funds.
// Must be >= gas budget (500M MIST) so the wallet can always post the next tx.
const SUI_DEPLOY_BUFFER_MIST = 500_000_000n; // 0.5 SUI kept as gas float

// Hysteresis for the red "uninvested funds" flag — avoids flapping red over
// leftover gas change. Uninvested value must exceed max($1, 1% of portfolio).
const UNINVESTED_MIN_USD = 1.0;
const UNINVESTED_MIN_PCT = 0.01;

// Slippage: Cetus SDK takes a decimal (0.01 = 1%), not bps.
const SLIPPAGE_BPS     = parseInt(process.env.SLIPPAGE_BPS) || 350;
const SLIPPAGE_DECIMAL = SLIPPAGE_BPS / 10_000;

// Fee: Cetus overlay fee replaces 7K partnerCommissionBps.
// FEE_BPS=50 -> overlayFeeRate 0.005 (0.50%), paid to FEE_WALLET, once per
// swap call regardless of hops/pools underneath.
const FEE_BPS          = parseInt(process.env.FEE_BPS) || 50;
const OVERLAY_FEE_RATE = FEE_BPS / 10_000;
const FEE_WALLET       = process.env.FEE_WALLET_ADDRESS;

// Optional comma-separated backup Pyth price-feed URLs.
const PYTH_URLS = (process.env.PYTH_URLS || '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);

// ── Sui Client + Cetus Aggregator Init ────────────────────────────────────────

const suiClient = new SuiClient({
    url: process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443'
});

const cetusClient = new AggregatorClient({
    client: suiClient,
    env:    Env.Mainnet,
    ...(process.env.CETUS_ENDPOINT ? { endpoint: process.env.CETUS_ENDPOINT } : {}),
    ...(process.env.CETUS_API_KEY  ? { apiKey:   process.env.CETUS_API_KEY }  : {}),
    ...(PYTH_URLS.length           ? { pythUrls: PYTH_URLS }                  : {}),
    overlayFeeRate:     OVERLAY_FEE_RATE,
    overlayFeeReceiver: FEE_WALLET,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSuiType(coinType) {
    return coinType === SUI_TYPE ||
           coinType === '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
}

function isUsdcType(coinType) {
    return coinType?.toLowerCase() === USDC_TYPE.toLowerCase();
}

function normalizeSuiType(coinType) {
    if (!coinType) return coinType;
    if (isSuiType(coinType)) return SUI_TYPE;
    const parts = coinType.split('::');
    if (parts.length >= 3) {
        const addr = parts[0];
        if (addr.startsWith('0x')) {
            const hex = addr.slice(2);
            if (hex.length < 64) {
                parts[0] = '0x' + hex.padStart(64, '0');
            }
        }
    }
    return parts.join('::');
}

// ── Cetus quote + swap wrappers ───────────────────────────────────────────────
// v2 response shape uses `routes`, v3 uses flattened `paths` — both accepted.

async function getRoute(fromCoinType, toCoinType, amountIn) {
    let router;
    try {
        router = await cetusClient.findRouters({
            from:       fromCoinType,
            target:     toCoinType,
            amount:     new BN(amountIn.toString()),
            byAmountIn: true,
        });
    } catch (err) {
        console.log(`   ⚠️  findRouters threw (${fromCoinType.split('::').pop()} → ${toCoinType.split('::').pop()}): ${err.message}`);
        return null;
    }

    if (!router) return null;
    if (router.error || router.insufficientLiquidity) {
        console.log(`   ⚠️  router error: ${router.error?.msg || router.error || 'insufficient liquidity'}`);
        return null;
    }

    const hasRoute = (router.routes?.length || router.paths?.length) &&
                     router.amountOut && new BN(router.amountOut.toString()).gtn(0);

    return hasRoute ? router : null;
}

async function injectSwap({ router, txb, coinIn }) {
    const coinOut = await cetusClient.routerSwap({
        router,
        txb,
        inputCoin: coinIn,
        slippage:  SLIPPAGE_DECIMAL,
    });
    return coinOut;
}

// ── SUI price fallback (for SUI-less baskets) ─────────────────────────────────
// When SUI is not a basket member, we still need its price to value deployable
// SUI. We quote 1 SUI → USDC via Cetus (liquidity-aware, no DB schema
// dependency) and cache for 60s so dashboard polling stays cheap.

let suiPriceCache = { price: 0, ts: 0 };
const SUI_PRICE_TTL_MS = 60_000;

async function getSuiPriceUsd() {
    const now = Date.now();
    if (suiPriceCache.price > 0 && (now - suiPriceCache.ts) < SUI_PRICE_TTL_MS) {
        return suiPriceCache.price;
    }
    const router = await getRoute(SUI_TYPE, USDC_TYPE, 1_000_000_000n); // 1 SUI
    if (!router) return suiPriceCache.price || 0; // stale cache better than 0 if we have one
    const price = Number(new BN(router.amountOut.toString()).toString()) / 1e6;
    suiPriceCache = { price, ts: now };
    return price;
}

// ── Stale token valuation (execute path only) ─────────────────────────────────
// Quotes each stale token → USDC to get a real, liquidity-aware USD value.
// Tokens with no route are marked noRoute and will be skipped (not traded,
// and they do NOT brick the rebalance).

async function valueStaleHoldings(staleHoldings) {
    for (const stale of staleHoldings) {
        const rawBal = typeof stale.rawBalance === 'bigint'
            ? stale.rawBalance
            : BigInt(stale.rawBalanceStr || '0');
        if (rawBal === 0n) { stale.noRoute = true; continue; }

        const router = await getRoute(stale.coinType, USDC_TYPE, rawBal);
        if (!router) {
            stale.noRoute  = true;
            stale.usdValue = 0;
            console.log(`   ⚠️  Stale ${stale.symbol}: no route — will be left in wallet`);
            continue;
        }
        stale.noRoute  = false;
        stale.usdValue = Number(new BN(router.amountOut.toString()).toString()) / 1e6;
        console.log(`   💲 Stale ${stale.symbol}: ~$${stale.usdValue.toFixed(2)} (Cetus quote)`);
    }
    return staleHoldings;
}

// ── Step 1: Read wallet balances ──────────────────────────────────────────────

async function getWalletBalances(walletAddress) {
    const allBalances = await suiClient.getAllBalances({ owner: walletAddress });
    const balances = {};
    for (const b of allBalances) {
        const coinType = normalizeSuiType(b.coinType);
        balances[coinType] = {
            coinType,
            totalBalance: BigInt(b.totalBalance),
        };
    }
    return balances;
}

// ── Step 2: Load target basket from Supabase ──────────────────────────────────

async function getBasketWeights(basketKey) {
    const { data, error } = await supabase
        .from('baskets')
        .select('basket_key, name, weights, token_count, last_updated')
        .eq('basket_key', basketKey)
        .eq('is_active', true)
        .single();

    if (error) throw new Error(`Failed to load basket ${basketKey}: ${error.message}`);
    if (!data?.weights?.length) throw new Error(`Basket ${basketKey} has no weights yet`);

    return data;
}

// ── Step 3: Analyze wallet ────────────────────────────────────────────────────
//
// opts.quoteStale (default false):
//   false — dashboard mode. Fast. Stale tokens are listed but unvalued.
//   true  — execute mode. Each stale token is quoted → USDC via Cetus for a
//           real USD value, so deficits and totals reflect the whole wallet.

async function analyzeWallet(walletAddress, basketKey, opts = {}) {
    const { quoteStale = false } = opts;

    const [rawBalances, basket] = await Promise.all([
        getWalletBalances(walletAddress),
        getBasketWeights(basketKey)
    ]);

    const targetWeights = basket.weights;
    const tokenMap = {};
    for (const t of targetWeights) {
        tokenMap[normalizeSuiType(t.coin_type)] = t;
    }

    const suiInBasket = !!tokenMap[SUI_TYPE];

    let totalUsdValue = 0;
    const holdings    = [];
    const staleHoldings = [];
    let usdcBalance   = 0n;
    let deployableSuiUsd = 0;
    let rawSuiTotal   = 0n;

    for (const [coinType, balance] of Object.entries(rawBalances)) {
        if (balance.totalBalance === 0n) continue;

        const normalizedType = normalizeSuiType(coinType);

        if (isSuiType(normalizedType)) {
            rawSuiTotal = balance.totalBalance;
            if (suiInBasket) {
                // SUI is a basket member — surplus shows up as overweight drift
                const availableSui = balance.totalBalance > GAS_RESERVE_MIST
                    ? balance.totalBalance - GAS_RESERVE_MIST
                    : 0n;
                if (availableSui === 0n) continue;

                const t        = tokenMap[normalizedType];
                const decimals = t?.decimals || 9;
                const priceUsd = t?.price_usd || 0;
                const humanAmt = Number(availableSui) / Math.pow(10, decimals);
                const usdValue = humanAmt * priceUsd;

                if (usdValue > 0) totalUsdValue += usdValue;

                holdings.push({
                    coinType:      normalizedType,
                    symbol:        t?.symbol || 'SUI',
                    humanAmt,
                    usdValue,
                    decimals,
                    priceUsd,
                    rawBalance:    availableSui,
                    rawBalanceStr: availableSui.toString(),
                    inBasket:      true,
                });
            } else {
                // SUI-less basket — SUI above the deploy buffer is INVESTABLE
                const deployableSui = balance.totalBalance > SUI_DEPLOY_BUFFER_MIST
                    ? balance.totalBalance - SUI_DEPLOY_BUFFER_MIST
                    : 0n;
                if (deployableSui === 0n) continue;

                const priceUsd = await getSuiPriceUsd();
                const humanAmt = Number(deployableSui) / 1e9;
                const usdValue = humanAmt * priceUsd;

                totalUsdValue    += usdValue;
                deployableSuiUsd += usdValue;

                holdings.push({
                    coinType:        normalizedType,
                    symbol:          'SUI',
                    humanAmt,
                    usdValue,
                    decimals:        9,
                    priceUsd,
                    rawBalance:      deployableSui,
                    rawBalanceStr:   deployableSui.toString(),
                    inBasket:        false,
                    isDeployableSui: true,
                });
            }
            continue;
        }

        if (isUsdcType(normalizedType)) {
            usdcBalance = balance.totalBalance;
            if (usdcBalance === 0n) continue;
            const humanAmt = Number(usdcBalance) / 1e6;
            const usdValue = humanAmt;
            totalUsdValue += usdValue;
            holdings.push({
                coinType:      normalizedType,
                symbol:        'USDC',
                humanAmt,
                usdValue,
                decimals:      6,
                priceUsd:      1.0,
                rawBalance:    usdcBalance,
                rawBalanceStr: usdcBalance.toString(),
                inBasket:      false,
                isUsdc:        true,
            });
            continue;
        }

        if (tokenMap[normalizedType]) {
            const t        = tokenMap[normalizedType];
            const humanAmt = Number(balance.totalBalance) / Math.pow(10, t.decimals);
            const usdValue = humanAmt * t.price_usd;
            totalUsdValue += usdValue;
            holdings.push({
                coinType:      normalizedType,
                symbol:        t.symbol,
                humanAmt,
                usdValue,
                decimals:      t.decimals,
                priceUsd:      t.price_usd,
                rawBalance:    balance.totalBalance,
                rawBalanceStr: balance.totalBalance.toString(),
                inBasket:      true,
            });
        } else {
            staleHoldings.push({
                coinType:      normalizedType,
                symbol:        normalizedType.split('::').pop() || 'UNKNOWN',
                humanAmt:      Number(balance.totalBalance) / 1e9,
                usdValue:      0,
                decimals:      9,
                priceUsd:      0,
                rawBalance:    balance.totalBalance,
                rawBalanceStr: balance.totalBalance.toString(),
                isStale:       true,
            });
        }
    }

    // Filter dust-level stale holdings first, then (execute mode) value them
    const MIN_STALE_UNITS = 10_000n;
    const meaningfulStale = staleHoldings.filter(h => {
        const bal = typeof h.rawBalance === 'bigint' ? h.rawBalance : BigInt(h.rawBalanceStr || '0');
        return bal >= MIN_STALE_UNITS;
    });

    if (quoteStale && meaningfulStale.length) {
        await valueStaleHoldings(meaningfulStale);
        for (const s of meaningfulStale) {
            if (!s.noRoute && s.usdValue > 0) totalUsdValue += s.usdValue;
        }
    }

    const analysis = targetWeights.map(target => {
        const normalizedCoinType = normalizeSuiType(target.coin_type);
        const holding       = holdings.find(h => h.coinType === normalizedCoinType && !h.isUsdc && !h.isDeployableSui);
        const currentValue  = holding?.usdValue || 0;
        const currentWeight = totalUsdValue > 0 ? currentValue / totalUsdValue : 0;
        const drift         = Math.abs(currentWeight - target.target_weight);
        return {
            coin_type:      normalizedCoinType,
            symbol:         target.symbol,
            decimals:       target.decimals,
            price_usd:      target.price_usd,
            target_weight:  target.target_weight,
            current_weight: currentWeight,
            current_value:  currentValue,
            drift,
            needs_buy:      currentWeight < target.target_weight,
        };
    });

    const maxDrift  = analysis.length > 0 ? Math.max(...analysis.map(a => a.drift)) : 0;
    const hasStale  = meaningfulStale.length > 0;

    const USDC_DUST_THRESHOLD = BigInt(Math.floor(MIN_HOLDING_USD * 1e6));
    const hasUsdc = usdcBalance > USDC_DUST_THRESHOLD;

    // Uninvested SUI (SUI-less baskets) with hysteresis to avoid red-flapping
    const uninvestedFloor   = Math.max(UNINVESTED_MIN_USD, totalUsdValue * UNINVESTED_MIN_PCT);
    const hasUninvestedSui  = deployableSuiUsd > uninvestedFloor;

    const hasMissingToken = analysis.some(a => a.current_weight === 0 && a.target_weight > 0.01);
    let status = 'green';
    if (hasStale || hasUsdc || hasUninvestedSui || totalUsdValue === 0 || hasMissingToken) status = 'red';
    else if (maxDrift > DRIFT_THRESHOLD) status = 'yellow';

    return {
        walletAddress,
        basketKey,
        basketName:     basket.name,
        totalUsdValue,
        holdings,
        staleHoldings:  meaningfulStale,
        analysis,
        uninvested: {
            usdc:   Number(usdcBalance) / 1e6,
            sui:    suiInBasket ? 0 : deployableSuiUsd > 0 ? deployableSuiUsd : 0,
            hasAny: hasUsdc || hasUninvestedSui,
        },
        hasStale,
        status,
        maxDrift,
        gasSui:         Number(rawSuiTotal) / 1e9,
        lastBasketUpdate: basket.last_updated,
    };
}

// ── Step 4: Generate trades ───────────────────────────────────────────────────
//
// TRUE WALLET-AS-PORTFOLIO MODEL:
//
// Phase 1 — Stale exits, greedy deficit-aware routing. Each stale token routes
//   to whichever basket token has the LARGEST REMAINING DEFICIT at that moment.
//   Stale tokens marked noRoute (no Cetus liquidity) are skipped — they stay in
//   the wallet and are reported, they never brick the rebalance.
//
// Phase 2 — Cash deploy. USDC and deployable SUI (SUI-less baskets) fan out
//   proportionally across underweight tokens.
//
// Phase 3 — Overweight → underweight direct swaps.
//
// Missing-token exemption: a basket token the wallet holds NONE of is always
// included as underweight, even if its deficit is under MIN_TRADE_USD —
// otherwise tiny portfolios get stuck on permanent red with a Rebalance
// button that can't fix it.

function generateTrades(walletAnalysis) {
    const { analysis, totalUsdValue, staleHoldings = [], holdings = [] } = walletAnalysis;
    const trades  = [];
    const skipped = [];

    if (totalUsdValue === 0) {
        console.log('   ⚠️  Portfolio is empty — nothing to rebalance');
        return trades;
    }

    // ── Phase 1: Stale exits — greedy deficit-aware routing ──────────────────

    const staleTargets = analysis
        .map(t => ({
            ...t,
            deficitUsd: Math.max(0, (t.target_weight * totalUsdValue) - t.current_value),
        }))
        .filter(t => t.deficitUsd > 0);

    for (const stale of staleHoldings) {
        if (stale.noRoute) {
            console.log(`   ⏭️  Stale: ${stale.symbol} skipped — no liquidity route`);
            skipped.push(stale.symbol);
            continue;
        }

        const rawBal = typeof stale.rawBalance === 'bigint'
            ? stale.rawBalance
            : BigInt(stale.rawBalanceStr || '0');
        if (rawBal === 0n) continue;

        staleTargets.sort((a, b) => b.deficitUsd - a.deficitUsd);

        const target = staleTargets[0];
        if (!target) {
            console.log(`   🗑️  Stale: ${stale.symbol} → USDC (no underweight target)`);
            trades.push({
                action:         'swap',
                from_coin_type: stale.coinType,
                from_symbol:    stale.symbol,
                from_units:     rawBal.toString(),
                from_decimals:  stale.decimals,
                to_coin_type:   USDC_TYPE,
                to_symbol:      'USDC',
                usd_amount:     stale.usdValue || 0,
                is_stale:       true,
            });
            continue;
        }

        console.log(`   🔄 Stale: ${stale.symbol} → ${target.symbol} (direct swap)`);
        trades.push({
            action:         'swap',
            from_coin_type: stale.coinType,
            from_symbol:    stale.symbol,
            from_units:     rawBal.toString(),
            from_decimals:  stale.decimals,
            to_coin_type:   target.coin_type,
            to_symbol:      target.symbol,
            usd_amount:     stale.usdValue || 0,
            is_stale:       true,
        });

        // With quote-based valuation, usdValue is real — deficit math is exact.
        // Placeholder fraction only remains for unvalued (dashboard-mode) calls.
        const estimatedValue = stale.usdValue > 0
            ? stale.usdValue
            : totalUsdValue * target.target_weight * 0.1;
        target.deficitUsd = Math.max(0, target.deficitUsd - estimatedValue);
    }

    if (skipped.length) {
        console.log(`   ℹ️  ${skipped.length} stale token(s) left in wallet (no route): ${skipped.join(', ')}`);
    }

    // ── Phase 2: Cash deploy — USDC, then deployable SUI ─────────────────────

    const usdcHolding   = holdings.find(h => h.isUsdc);
    const usdcAvailable = usdcHolding?.usdValue || 0;
    const suiHolding    = holdings.find(h => h.isDeployableSui);
    const suiAvailable  = suiHolding?.usdValue || 0;

    const overweight  = [];
    const underweight = [];

    for (const token of analysis) {
        const targetUsd = token.target_weight * totalUsdValue;
        const diff      = targetUsd - token.current_value;

        // Missing-token exemption: always buy into a token we hold none of
        const isMissing = token.current_value === 0 && token.target_weight > 0.01;

        if (!isMissing && Math.abs(diff) < MIN_TRADE_USD) continue;

        if (diff < 0) {
            const excessUnits = BigInt(Math.floor(
                Math.abs(diff) / token.price_usd * Math.pow(10, token.decimals)
            ));
            overweight.push({ ...token, excessUsd: Math.abs(diff), excessUnits });
        } else if (diff > 0) {
            underweight.push({ ...token, deficitUsd: diff, isMissing });
        }
    }

    // Missing tokens jump the queue: completing the index beats polishing drift.
    // Stable sort keeps weight order within each group.
    underweight.sort((a, b) => (b.isMissing ? 1 : 0) - (a.isMissing ? 1 : 0));

    function deployCash({ label, available, fromCoinType, fromSymbol, fromDecimals, priceUsd }) {
        if (available < MIN_TRADE_USD) return;
        const totalDeficit = underweight.reduce((sum, t) => sum + t.deficitUsd, 0);
        if (totalDeficit <= 0) return;

        const toDeploy = Math.min(available, totalDeficit);

        for (const token of underweight) {
            if (token.deficitUsd <= 0) continue;
            const fraction  = token.deficitUsd / totalDeficit;
            const deployUsd = toDeploy * fraction;
            if (deployUsd < MIN_TRADE_USD && !token.isMissing) continue;
            if (deployUsd <= 0) continue;

            const units = BigInt(Math.floor(deployUsd / priceUsd * Math.pow(10, fromDecimals)));
            if (units === 0n) continue;

            console.log(`   💰 ${label} → ${token.symbol}: $${deployUsd.toFixed(2)}`);
            trades.push({
                action:         'swap',
                from_coin_type: fromCoinType,
                from_symbol:    fromSymbol,
                from_units:     units.toString(),
                from_decimals:  fromDecimals,
                to_coin_type:   token.coin_type,
                to_symbol:      token.symbol,
                usd_amount:     deployUsd,
                is_stale:       false,
            });

            token.deficitUsd -= deployUsd;
        }
    }

    deployCash({
        label: 'USDC', available: usdcAvailable,
        fromCoinType: USDC_TYPE, fromSymbol: 'USDC',
        fromDecimals: 6, priceUsd: 1.0,
    });

    if (suiHolding) {
        deployCash({
            label: 'SUI', available: suiAvailable,
            fromCoinType: SUI_TYPE, fromSymbol: 'SUI',
            fromDecimals: 9, priceUsd: suiHolding.priceUsd,
        });
    }

    // ── Phase 3: Overweight → underweight direct swaps ───────────────────────

    for (const source of overweight) {
        let remainingExcessUsd = source.excessUsd;

        for (const target of underweight) {
            if (target.deficitUsd < MIN_TRADE_USD && !target.isMissing) continue;
            if (target.deficitUsd <= 0) continue;
            if (remainingExcessUsd <= 0) break;
            // Crumb-sized excess may still finish filling a MISSING token,
            // but is not worth spending on ordinary drift correction.
            if (remainingExcessUsd < MIN_TRADE_USD && !target.isMissing) continue;

            const swapUsd   = Math.min(remainingExcessUsd, target.deficitUsd);
            const sellUnits = BigInt(Math.floor(
                swapUsd / source.price_usd * Math.pow(10, source.decimals)
            ));

            if (sellUnits === 0n) continue;

            console.log(`   🔄 ${source.symbol} → ${target.symbol}: $${swapUsd.toFixed(2)}`);
            trades.push({
                action:         'swap',
                from_coin_type: source.coin_type,
                from_symbol:    source.symbol,
                from_units:     sellUnits.toString(),
                from_decimals:  source.decimals,
                to_coin_type:   target.coin_type,
                to_symbol:      target.symbol,
                usd_amount:     swapUsd,
                is_stale:       false,
            });

            remainingExcessUsd -= swapUsd;
            target.deficitUsd  -= swapUsd;
        }

        if (remainingExcessUsd >= MIN_TRADE_USD) {
            console.log(`   ℹ️  ${source.symbol} has $${remainingExcessUsd.toFixed(2)} excess with no underweight targets — leaving in place`);
        }
    }

    // Sort: stale exits first, then sells, then buys
    return trades.sort((a, b) => {
        if (a.is_stale && !b.is_stale) return -1;
        if (!a.is_stale && b.is_stale) return 1;
        const aIsSell = a.from_coin_type !== USDC_TYPE;
        const bIsSell = b.from_coin_type !== USDC_TYPE;
        if (aIsSell && !bIsSell) return -1;
        if (!aIsSell && bIsSell) return 1;
        return 0;
    });
}

// ── Step 5: Build unsigned rebalance PTB ─────────────────────────────────────
//
// Gas budget: 500_000_000 MIST (0.5 SUI ceiling) — budget is a ceiling, not a
// charge. NOTE: SUI_DEPLOY_BUFFER_MIST must stay >= this budget so the gas
// coin can always cover budget validation on the next transaction.
//
// Stale trades whose route disappears between quote and build are skipped
// (logged), never thrown — one dead token must not brick the rebalance.

async function buildRebalanceTransaction(walletAddress, trades) {
    if (!FEE_WALLET) throw new Error('FEE_WALLET_ADDRESS not set in .env');
    if (!trades.length) throw new Error('No trades to execute');

    const validTrades = trades.filter(t => t.is_stale || BigInt(t.from_units) >= 10_000n);
    if (!validTrades.length) throw new Error('All trades are dust — portfolio is balanced');

    const txb = new Transaction();
    txb.setSender(walletAddress);

    console.log(`\n🔨 [ExecutionEngine] Building PTB via Cetus — ${validTrades.length} swap(s)...`);

    // Pre-fetch coin objects for all source tokens
    const coinCache = {};
    const sourceTypes = [...new Set(validTrades.map(t => t.from_coin_type))];
    await Promise.all(sourceTypes.map(async (coinType) => {
        if (isSuiType(coinType)) return;
        let coins = await suiClient.getCoins({ owner: walletAddress, coinType });
        if (!coins.data?.length) {
            const parts = coinType.split('::');
            if (parts.length >= 3 && parts[0].startsWith('0x')) {
                const shortAddr = '0x' + parts[0].slice(2).replace(/^0+/, '');
                const shortType = [shortAddr, ...parts.slice(1)].join('::');
                coins = await suiClient.getCoins({ owner: walletAddress, coinType: shortType });
            }
        }
        coinCache[coinType] = coins.data || [];
    }));

    // Merge multiple coin objects of same type upfront
    const merged = new Set();
    for (const coinType of sourceTypes) {
        if (isSuiType(coinType)) continue;
        const coins = coinCache[coinType] || [];
        if (coins.length > 1 && !merged.has(coinType)) {
            txb.mergeCoins(
                txb.object(coins[0].coinObjectId),
                coins.slice(1).map(c => txb.object(c.coinObjectId))
            );
            merged.add(coinType);
        }
    }

    let executedSwaps = 0;

    for (const trade of validTrades) {
        const { from_coin_type, from_symbol, from_units, to_coin_type, to_symbol, usd_amount } = trade;

        const fromUnits = BigInt(from_units);

        const MIN_TRADE_UNITS = 10_000n;
        if (!trade.is_stale && fromUnits < MIN_TRADE_UNITS) {
            console.log(`   ⏭️  ${from_symbol} → ${to_symbol}: skipping dust (${fromUnits} units)`);
            continue;
        }

        // Route FIRST — so a routeless stale token is skipped before we split
        // coins for it (avoids unused coin values in the PTB).
        const router = await getRoute(from_coin_type, to_coin_type, fromUnits);
        if (!router) {
            if (trade.is_stale) {
                console.log(`   ⏭️  ${from_symbol} → ${to_symbol}: no route — leaving ${from_symbol} in wallet`);
                continue;
            }
            throw new Error(`No Cetus route for ${from_symbol} → ${to_symbol}`);
        }

        console.log(`   🔄 ${from_symbol} → ${to_symbol}: ~$${(usd_amount || 0).toFixed(2)} (route out: ${router.amountOut?.toString?.() || 'n/a'})`);

        let coinIn;
        if (isSuiType(from_coin_type)) {
            [coinIn] = txb.splitCoins(txb.gas, [txb.pure.u64(fromUnits)]);
        } else {
            const coins = coinCache[from_coin_type] || [];
            if (!coins.length) {
                if (trade.is_stale) {
                    console.log(`   ⏭️  ${from_symbol}: no coin objects found — skipping`);
                    continue;
                }
                throw new Error(`No ${from_symbol} coins found in wallet`);
            }

            if (trade.is_stale && coins.length === 1) {
                coinIn = txb.object(coins[0].coinObjectId);
            } else {
                if (!merged.has(from_coin_type) && coins.length > 1) {
                    txb.mergeCoins(
                        txb.object(coins[0].coinObjectId),
                        coins.slice(1).map(c => txb.object(c.coinObjectId))
                    );
                    merged.add(from_coin_type);
                }
                [coinIn] = txb.splitCoins(txb.object(coins[0].coinObjectId), [txb.pure.u64(fromUnits)]);
            }
        }

        const coinOut = await injectSwap({ router, txb, coinIn });

        if (coinOut) {
            txb.transferObjects([coinOut], walletAddress);
        }
        executedSwaps++;
    }

    if (executedSwaps === 0) throw new Error('No executable swaps — all trades skipped (no routes)');

    txb.setGasBudget(100_000_000); // 0.1 SUI ceiling
    const bytes = await txb.build({ client: suiClient });
    console.log(`   ✅ PTB built — ${executedSwaps} swap(s), ${bytes.length} bytes, ready for user signature`);

    return Buffer.from(bytes).toString('base64');
}

// ── Step 6: Build unsigned redeem PTB ────────────────────────────────────────

async function buildRedeemTransaction(walletAddress, basketKey, redeemPct, redeemTo = 'usdc') {
    if (redeemPct <= 0 || redeemPct > 100) throw new Error('redeemPct must be 1–100');
    if (!FEE_WALLET) throw new Error('FEE_WALLET_ADDRESS not set in .env');

    const walletAnalysis = await analyzeWallet(walletAddress, basketKey, { quoteStale: true });
    const txb = new Transaction();
    txb.setSender(walletAddress);

    const coinTypeOut = redeemTo === 'sui' ? SUI_TYPE : USDC_TYPE;
    const fraction    = redeemPct / 100;

    console.log(`\n🔨 [ExecutionEngine] Building redeem PTB via Cetus — ${redeemPct}% to ${redeemTo.toUpperCase()}...`);

    let executedSwaps = 0;

    for (const holding of walletAnalysis.holdings) {
        if (holding.isUsdc && redeemTo === 'usdc') continue;
        if (isSuiType(holding.coinType) && redeemTo === 'sui') continue;
        if (holding.coinType === coinTypeOut) continue;

        const sellUnits = BigInt(Math.floor(
            holding.humanAmt * fraction * Math.pow(10, holding.decimals)
        ));
        if (sellUnits === 0n) continue;

        const coinTypeIn = holding.coinType;

        const tokenCoins = await suiClient.getCoins({ owner: walletAddress, coinType: coinTypeIn });
        if (!tokenCoins.data?.length) continue;

        const router = await getRoute(coinTypeIn, coinTypeOut, sellUnits);
        if (!router) {
            console.log(`   ⏭️  ${holding.symbol}: no route — skipping in redeem`);
            continue;
        }

        let coinIn;
        if (isSuiType(coinTypeIn)) {
            [coinIn] = txb.splitCoins(txb.gas, [txb.pure.u64(sellUnits)]);
        } else {
            const primaryId = tokenCoins.data[0].coinObjectId;
            if (tokenCoins.data.length > 1) {
                txb.mergeCoins(
                    txb.object(primaryId),
                    tokenCoins.data.slice(1).map(c => txb.object(c.coinObjectId))
                );
            }
            [coinIn] = txb.splitCoins(txb.object(primaryId), [txb.pure.u64(sellUnits)]);
        }

        console.log(`   🔄 SELL ${holding.symbol}: ${(holding.humanAmt * fraction).toFixed(4)} → ${redeemTo.toUpperCase()}`);

        const coinOut = await injectSwap({ router, txb, coinIn });

        if (coinOut) {
            txb.transferObjects([coinOut], walletAddress);
        }
        executedSwaps++;
    }

    if (executedSwaps === 0) throw new Error('Nothing to redeem — no sellable holdings with routes');

    txb.setGasBudget(100_000_000);
    const bytes = await txb.build({ client: suiClient });
    console.log(`   ✅ Redeem PTB built — ${executedSwaps} swap(s), ${bytes.length} bytes, ready for user signature`);

    return Buffer.from(bytes).toString('base64');
}

// ── Step 7: Preview (dry-run) an unsigned PTB ────────────────────────────────

async function previewTransaction(base64Tx) {
    const txBytes = Buffer.from(base64Tx, 'base64');

    const result = await suiClient.dryRunTransactionBlock({
        transactionBlock: txBytes,
    });

    const status   = result.effects?.status?.status || 'unknown';
    const gasUsed  = result.effects?.gasUsed;
    const gasTotal = gasUsed
        ? (BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate))
        : null;

    console.log(`\n🔎 [Preview] Dry-run status: ${status}`);
    if (status !== 'success') {
        console.log(`   ❌ Error: ${result.effects?.status?.error || 'unknown'}`);
    }
    if (gasTotal !== null) {
        console.log(`   ⛽ Estimated gas: ${Number(gasTotal) / 1e9} SUI`);
    }
    for (const change of result.balanceChanges || []) {
        const sym = change.coinType.split('::').pop();
        console.log(`   💱 ${sym}: ${change.amount}`);
    }

    return {
        success:        status === 'success',
        status,
        error:          result.effects?.status?.error || null,
        gasUsedMist:    gasTotal?.toString() || null,
        balanceChanges: result.balanceChanges || [],
    };
}

// ── Exports ───────────────────────────────────────────────────────────────────

export {
    analyzeWallet,
    generateTrades,
    buildRebalanceTransaction,
    buildRedeemTransaction,
    previewTransaction,
    getSuiPriceUsd,
    isSuiType,
    isUsdcType,
    USDC_TYPE,
    SUI_TYPE,
    GAS_RESERVE_MIST,
    SUI_DEPLOY_BUFFER_MIST,
};
