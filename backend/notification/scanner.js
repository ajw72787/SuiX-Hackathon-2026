/**
 * SuiX Notification Service — Scanner (v2 — shared analysis)
 *
 * REFACTOR: this scanner no longer owns any drift/balance/weight logic.
 * It calls analyzeWallet() from services/executionEngine.js — the exact same
 * function the dashboard and rebalancer use — so the notifier can never
 * disagree with what the user sees in the main utility.
 *
 * What was removed (and why it was wrong):
 *   - fetchWalletBalances: hardcoded 1e9 decimals (broke USDC and any
 *     non-9-decimal token)
 *   - uninvestedUsd: flagged SUI above the gas reserve as idle cash even
 *     when SUI is a basket token → false RED alerts
 *   - calculateDrift / fetchBasketWeights / fetchTokenPrices: no coin-type
 *     normalization, separate threshold (5% vs the engine's 4%)
 *
 * What this file still owns:
 *   - The watch list loop, RPC throttling, scan_runs bookkeeping
 *   - drift_events persistence
 *   - Mapping the engine's analysis into the notifier's ctx shape
 *
 * Status mapping (engine → notifier):
 *   'green'  → GREEN   'yellow' → YELLOW   'red' → RED
 *
 * Units note: the engine reports drift as FRACTIONS (0.04 = 4%). The
 * notifier's message builder expects PERCENT. Conversion happens here, in
 * one place (toPercent).
 */

import "dotenv/config";
import { analyzeWallet } from "../services/executionEngine.js";
import { getWatchList } from "./registry.js";
import { maybeNotify } from "./notifier.js";

const CONFIG = {
  WALLET_SCAN_DELAY_MS: Number(process.env.WALLET_SCAN_DELAY_MS ?? 500),
};

const STATUS = { GREEN: "GREEN", YELLOW: "YELLOW", RED: "RED" };

const ENGINE_STATUS_MAP = {
  green: STATUS.GREEN,
  yellow: STATUS.YELLOW,
  red: STATUS.RED,
};

const toPercent = (fraction) => +(fraction * 100).toFixed(4);

/**
 * Run one full scan over all watched wallets.
 * @param {boolean} isBaseline — if true, record status but suppress sends
 *        (used on the first scan after a restart to avoid false re-notifies).
 */
export async function scanAllWallets(sui, supabase, { isBaseline = false } = {}) {
  const runStart = Date.now();
  console.log(`[scanner] Starting scan${isBaseline ? " (baseline — no sends)" : ""}...`);

  const { data: run, error: runErr } = await supabase
    .from("scan_runs")
    .insert({ status: "running", source: "notification" })
    .select("id")
    .single();

  if (runErr) throw new Error(`Failed to create scan run: ${runErr.message}`);
  const runId = run.id;

  let walletsScanned = 0;
  let alertsSent = 0;
  const errors = [];

  try {
    const wallets = await getWatchList(supabase);
    console.log(`[scanner] ${wallets.length} wallets on watch list`);

    for (const wallet of wallets) {
      try {
        const result = await processWallet(sui, supabase, wallet, runId, isBaseline);
        walletsScanned++;
        if (result.alertSent) alertsSent++;
      } catch (err) {
        console.error(`[scanner] Error on ${wallet.wallet_address}:`, err.message);
        errors.push({ wallet: wallet.wallet_address, error: err.message });
      }

      // Throttle RPC so we don't hammer the fullnode
      if (CONFIG.WALLET_SCAN_DELAY_MS > 0) {
        await sleep(CONFIG.WALLET_SCAN_DELAY_MS);
      }
    }
  } finally {
    await supabase
      .from("scan_runs")
      .update({
        status: errors.length === 0 ? "completed" : "completed_with_errors",
        completed_at: new Date().toISOString(),
        wallets_scanned: walletsScanned,
        alerts_sent: alertsSent,
        rebalances_triggered: 0, // this service never rebalances
        errors: errors.length > 0 ? errors : null,
        duration_ms: Date.now() - runStart,
      })
      .eq("id", runId);

    console.log(
      `[scanner] Done — ${walletsScanned} scanned, ${alertsSent} alerts, ` +
      `${errors.length} errors — ${Date.now() - runStart}ms`
    );
  }

  return { walletsScanned, alertsSent, errors };
}

async function processWallet(sui, supabase, wallet, runId, isBaseline) {
  const { wallet_address } = wallet;

  // Basket the user chose for notifications, carried on the utility.telegram row.
  const basketId = wallet.basket_id || "suix-5";

  // ── THE refactor: one shared analysis path ──────────────────────────────
  // analyzeWallet uses its own SuiClient + the main supabase client
  // (lib/supabase.js), i.e. the same RPC, same baskets table, same prices,
  // same thresholds, same gas-reserve handling as the dashboard.
  const wa = await analyzeWallet(wallet_address, basketId);

  const status = ENGINE_STATUS_MAP[wa.status] ?? STATUS.RED;
  const maxDrift = toPercent(wa.maxDrift);
  const driftMap = buildDriftMap(wa.analysis);
  const reason = buildReason(wa);

  const ctxBase = {
    wallet,
    basketId,
    status,
    driftMap,
    maxDrift,
    reason,
    runId,
    isBaseline,
  };

  // GREEN → let the notifier detect "recovered" and reset dedup state
  if (status === STATUS.GREEN) {
    await maybeNotify(sui, supabase, ctxBase);
    return { alertSent: false };
  }

  // Persist a drift_event row for yellow/red
  const { data: evt, error: evtErr } = await supabase
    .from("drift_events")
    .insert({
      scan_run_id: runId,
      wallet_address,
      basket_id: basketId,
      state: status === STATUS.RED ? "3" : "2", // map to existing enum
      max_drift_pct: maxDrift,
      drift_snapshot: { driftMap, status, reason },
      alert_sent: false,
      rebalance_triggered: false,
    })
    .select("id")
    .single();

  if (evtErr) {
    console.error(`[scanner] drift_event insert failed for ${wallet_address}:`, evtErr.message);
  }

  const result = await maybeNotify(sui, supabase, {
    ...ctxBase,
    driftEventId: evt?.id ?? null,
  });

  return { alertSent: result.alertSent };
}

// ─── Mapping helpers (presentation only — no analysis logic here) ─────────

/**
 * Engine analysis[] → { coinType: signedDriftPct } for the Telegram message.
 * Signed: positive = overweight, negative = underweight, in PERCENT.
 */
function buildDriftMap(analysis) {
  const driftMap = {};
  for (const a of analysis ?? []) {
    driftMap[a.coin_type] = toPercent(a.current_weight - a.target_weight);
  }
  return driftMap;
}

/**
 * Human reason string, derived from the same flags the engine used to set
 * status — so the message always matches what the dashboard would show.
 */
function buildReason(wa) {
  if (wa.status === "green") return "Balanced";

  if (wa.totalUsdValue === 0) return "Portfolio is empty";

  if (wa.hasStale && wa.staleHoldings?.length) {
    const names = wa.staleHoldings.map((h) => h.symbol).slice(0, 3).join(", ");
    return `Token(s) no longer in index: ${names}`;
  }

  if (wa.uninvested?.hasAny) {
    return `Uninvested USDC detected (~$${wa.uninvested.usdc.toFixed(2)})`;
  }

  const missing = (wa.analysis ?? []).find(
    (a) => a.current_weight === 0 && a.target_weight > 0.01
  );
  if (missing) return `Token missing from index: ${missing.symbol}`;

  return `Drift ${toPercent(wa.maxDrift).toFixed(2)}% exceeds tolerance`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { STATUS };
