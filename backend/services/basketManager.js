import supabase from '../lib/supabase.js';

// ── Basket configs ────────────────────────────────────────────────────────────
// Each entry maps a basket row in utility.baskets to a token universe in
// utility.tokens (by category) and a selection mode:
//
//   mode: 'top_n'          — take the N highest-ranked tokens; SKIP the basket
//                            if fewer than N are available (legacy behavior).
//   mode: 'all_qualifying' — take every active token in the category (the
//                            tracker's floors already decided who qualifies);
//                            variable count by design. SKIP below minTokens.
//
//   weightMode: 'market_cap' (default) — weight by market cap, 40% cap.
//   weightMode: 'equal'                — every member gets 1/N (thesis baskets,
//                                        and the hook creator baskets reuse as
//                                        'authored' weights later).
//
// Adding a basket = adding one entry here + a tracker config for its category.

const BASKET_CONFIGS = [
    { key: 'suix-5',     category: 'market_cap', mode: 'top_n',          limit: 5  },
    { key: 'suix-10',    category: 'market_cap', mode: 'top_n',          limit: 10 },
    { key: 'suix-meme',  category: 'meme',       mode: 'all_qualifying', minTokens: 3, maxTokens: 10 },
    { key: 'suix-defi',  category: 'defi',       mode: 'all_qualifying', minTokens: 3, maxTokens: 20 },
    { key: 'suix-stack', category: 'stack',      mode: 'all_qualifying', minTokens: 2, maxTokens: 10, weightMode: 'equal' },
];

const MAX_WEIGHT = 0.40; // 40% cap — no single token can exceed this

// ── Weight capping ────────────────────────────────────────────────────────────
// Apply max weight cap and redistribute excess proportionally to remaining
// tokens. Runs iteratively because capping one token may push others over.

function applyWeightCap(weights) {
    let capped = weights.map(w => ({ ...w }));
    let iterations = 0;

    if (capped.length * MAX_WEIGHT < 1.0) {
        console.log(`   ⚠️  ${capped.length} tokens cannot satisfy ${MAX_WEIGHT * 100}% cap — skipping cap`);
        return capped;
    }

    while (iterations < 10) {
        const overLimit = capped.filter(w => w.target_weight > MAX_WEIGHT);
        if (overLimit.length === 0) break;

        let excessTotal = 0;
        overLimit.forEach(w => {
            excessTotal += w.target_weight - MAX_WEIGHT;
            w.target_weight = MAX_WEIGHT;
        });

        const underLimit = capped.filter(w => w.target_weight < MAX_WEIGHT);
        const underTotal = underLimit.reduce((sum, w) => sum + w.target_weight, 0);

        if (underTotal === 0) break;

        underLimit.forEach(w => {
            w.target_weight += excessTotal * (w.target_weight / underTotal);
        });

        iterations++;
    }

    return capped;
}

// ── Weight construction (shared by all modes) ─────────────────────────────────

function buildWeights(tokens, weightMode = 'market_cap') {
    const totalMarketCap = tokens.reduce((sum, t) => sum + parseFloat(t.market_cap_usd || 0), 0);

    let weights = tokens.map(t => {
        const base = weightMode === 'equal'
            ? (1 / tokens.length)
            : (parseFloat(t.market_cap_usd) / totalMarketCap);

        return {
            coin_type:      t.coin_type,
            symbol:         t.symbol,
            name:           t.name,
            rank:           t.rank,
            market_cap_usd: parseFloat(t.market_cap_usd || 0),
            price_usd:      parseFloat(t.price_usd),
            volume_24h_usd:       t.volume_24h_usd != null ? parseFloat(t.volume_24h_usd) : null,
            price_change_24h_pct: t.price_change_24h_pct != null ? parseFloat(t.price_change_24h_pct) : null,
            decimals:       t.decimals,
            coingecko_id:   t.coingecko_id,
            target_weight:  parseFloat(base.toFixed(6))
        };
    });

    weights = applyWeightCap(weights);

    // Normalize floating point drift — fix last token
    const weightSum = weights.reduce((sum, w) => sum + w.target_weight, 0);
    const diff = parseFloat((1.0 - weightSum).toFixed(6));
    if (diff !== 0) {
        weights[weights.length - 1].target_weight =
            parseFloat((weights[weights.length - 1].target_weight + diff).toFixed(6));
    }

    return { weights, totalMarketCap };
}

// ── Composition change detection (for history snapshots) ─────────────────────

function compositionChanged(oldWeights, newWeights) {
    const oldSet = new Set((oldWeights || []).map(w => w.coin_type));
    const newSet = new Set(newWeights.map(w => w.coin_type));
    if (oldSet.size !== newSet.size) return true;
    for (const ct of newSet) if (!oldSet.has(ct)) return true;
    return false;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function runBasketManager() {
    console.log('\n' + '─'.repeat(50));
    console.log('🧺 [BasketManager] Building basket weights...');
    console.log('─'.repeat(50));

    const categories = [...new Set(BASKET_CONFIGS.map(b => b.category))];

    const { data: allTokens, error } = await supabase
        .from('tokens')
        .select('*')
        .in('category', categories)
        .eq('is_active', true)
        .order('rank', { ascending: true });

    if (error) throw new Error(`[BasketManager] Failed to read tokens — ${error.message}`);

    const byCategory = {};
    for (const cat of categories) {
        byCategory[cat] = (allTokens || []).filter(t => t.category === cat);
        console.log(`   📊 ${cat}: ${byCategory[cat].length} active tokens`);
    }

    const { data: basketRows, error: basketErr } = await supabase
        .from('baskets')
        .select('basket_key, weights, is_active')
        .in('basket_key', BASKET_CONFIGS.map(b => b.key));

    if (basketErr) throw new Error(`[BasketManager] Failed to read baskets — ${basketErr.message}`);
    const basketByKey = Object.fromEntries((basketRows || []).map(b => [b.basket_key, b]));

    const now = new Date().toISOString();
    let basketsUpdated = 0;

    for (const config of BASKET_CONFIGS) {
        const row = basketByKey[config.key];
        if (!row) {
            console.log(`   ⚠️  ${config.key}: no basket row in DB — skipping`);
            continue;
        }
        if (!row.is_active) {
            console.log(`   ⏭️  ${config.key}: inactive — skipping`);
            continue;
        }

        const pool = byCategory[config.category] || [];
        let tokens;

        if (config.mode === 'top_n') {
            tokens = pool.slice(0, config.limit);
            if (tokens.length < config.limit) {
                console.log(`   ⚠️  ${config.key}: Only ${tokens.length}/${config.limit} available — skipping`);
                continue;
            }
        } else { // all_qualifying
            tokens = config.maxTokens ? pool.slice(0, config.maxTokens) : pool;
            if (tokens.length < (config.minTokens ?? 3)) {
                console.log(`   ⚠️  ${config.key}: Only ${tokens.length} qualifying (min ${config.minTokens ?? 3}) — skipping, keeping previous weights`);
                continue;
            }
        }

        const { weights, totalMarketCap } = buildWeights(tokens, config.weightMode);

        const finalSum = weights.reduce((sum, w) => sum + w.target_weight, 0);
        console.log(`   🧮 ${config.key}: ${weights.length} tokens (${config.weightMode || 'market_cap'}), weight sum = ${finalSum.toFixed(6)}`);

        const { error: updateError } = await supabase
            .from('baskets')
            .update({ weights, token_count: tokens.length, last_updated: now })
            .eq('basket_key', config.key);

        if (updateError) {
            console.log(`   ❌ ${config.key}: ${updateError.message}`);
            continue;
        }

        console.log(`   ✅ ${config.key}: weights written`);
        basketsUpdated++;

        if (compositionChanged(row.weights, weights)) {
            const { error: histError } = await supabase
                .from('basket_history')
                .insert({
                    basket_key:       config.key,
                    weights,
                    total_market_cap: totalMarketCap,
                    snapshot_at:      now,
                });
            if (histError) {
                console.log(`   ⚠️  ${config.key}: history snapshot failed — ${histError.message}`);
            } else {
                console.log(`   📸 ${config.key}: composition changed — snapshot written`);
            }
        }
    }

    console.log(`✅ [BasketManager] ${basketsUpdated}/${BASKET_CONFIGS.length} baskets updated`);
    return basketsUpdated;
}
