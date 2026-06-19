/**
 * SuiX Notification Service — Entry Point (Orchestrator)
 *
 * Standalone service. Does NOT depend on the rebalancer/scanner.
 *
 * Boot sequence (continuous mode):
 *   1. Start the Telegram listener (getUpdates loop) — captures chat_ids into
 *      utility.telegram_linking. Fails fast if the bot token is bad.
 *   2. syncChainEvents() — reconcile utility.telegram from the notification
 *      contract's on-chain events.
 *   3. First scan runs as a BASELINE (records status, suppresses sends) so a
 *      restart can't false-fire alerts for wallets already drifting.
 *   4. Loop forever: every POLL_INTERVAL_MS → syncChainEvents() then scan.
 *      (The listener keeps polling in the background throughout.)
 *
 * Run:
 *   node index.js              → listener + continuous scan loop
 *   node index.js --run-now    → single scan then exit (no listener; for testing)
 *   node index.js --baseline   → single baseline scan then exit (no listener)
 */

import ws from "ws";
import { createClient } from "@supabase/supabase-js";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import "dotenv/config";
import { syncChainEvents } from "./registry.js";
import { scanAllWallets } from "./scanner.js";
import { startListener } from "./listener.js";

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: ${name} not set in .env`); process.exit(1); }
  return v;
}

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL ?? "https://wsbzxyqepahheeutuprz.supabase.co",
  SUPABASE_SERVICE_KEY: required("SUPABASE_SERVICE_KEY"),
  SCAN_INTERVAL_HOURS: Number(process.env.SCAN_INTERVAL_HOURS ?? 12),
  SCAN_START_HOUR: process.env.SCAN_START_HOUR !== undefined ? Number(process.env.SCAN_START_HOUR) : null,
  SCAN_START_MINUTE: Number(process.env.SCAN_START_MINUTE ?? 0),
};

const intervalMs = CONFIG.SCAN_INTERVAL_HOURS * 3600000;

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  db: { schema: "utility" },
  realtime: { transport: ws },
});

const sui = new SuiJsonRpcClient({
  url: process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl("mainnet"),
  network: "mainnet",
});

function msUntilNextAlignedRun() {
  if (CONFIG.SCAN_START_HOUR === null) return intervalMs;
  const now = new Date();
  let next = new Date(now);
  next.setHours(CONFIG.SCAN_START_HOUR, CONFIG.SCAN_START_MINUTE, 0, 0);
  while (next <= now) next = new Date(next.getTime() + intervalMs);
  return next - now;
}

function scheduleNext() {
  const delay = msUntilNextAlignedRun();
  const nextRun = new Date(Date.now() + delay);
  const minutesUntil = Math.round(delay / 60000);
  console.log(`[suix-notify] Next scan at ${nextRun.toLocaleString()} (~${minutesUntil}m from now)`);
  setTimeout(async () => {
    await runOnce().catch((err) => console.error("[suix-notify] Loop error:", err.message));
    scheduleNext();
  }, delay);
}

let firstRun = true;

async function runOnce({ forceBaseline = false, forceLive = false } = {}) {
  const ts = new Date().toISOString();
  console.log(`\n[suix-notify] ===== Run start ${ts} =====`);

  try {
    await syncChainEvents(sui, supabase);
  } catch (err) {
    console.error("[suix-notify] Event sync failed (continuing to scan):", err.message);
  }

  // forceLive wins: run a real, send-enabled scan even on a one-off invocation.
  const isBaseline = forceLive ? false : (forceBaseline || firstRun);
  try {
    await scanAllWallets(sui, supabase, { isBaseline });
  } catch (err) {
    console.error("[suix-notify] Scan failed:", err.message);
  }

  firstRun = false;
  console.log(`[suix-notify] ===== Run complete =====\n`);
}

async function loop() {
  // 1. Listener first — user-facing + fails fast on a bad token.
  //    Runs the getUpdates poll in the background for the life of the process.
  try {
    await startListener(supabase);
  } catch (err) {
    console.error("[suix-notify] Listener failed to start:", err.message);
    process.exit(1); // bad bot token → don't run half-alive
  }

  // 2. Registry sync + baseline scan (seats dedup state without firing on restart)
  await runOnce({ forceBaseline: true });

  // 3. Recurring scan loop
  const alignedLabel = CONFIG.SCAN_START_HOUR !== null
    ? ` aligned to ${String(CONFIG.SCAN_START_HOUR).padStart(2, "0")}:${String(CONFIG.SCAN_START_MINUTE).padStart(2, "0")}`
    : "";
  console.log(`[suix-notify] Polling every ${CONFIG.SCAN_INTERVAL_HOURS}h${alignedLabel}`);
  scheduleNext();
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === "--run-now") {
  // Single normal run (will be a baseline because firstRun is true)
  runOnce().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (arg === "--baseline") {
  runOnce({ forceBaseline: true }).then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (arg === "--scan-now") {
  // Single LIVE run — sends enabled (no baseline suppression). For testing a
  // real drift alert on demand. Will notify any wallet whose status changed
  // since the last recorded notify_status.
  console.log("[suix-notify] --scan-now: live scan, sends ENABLED");
  runOnce({ forceLive: true }).then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  loop().catch((err) => {
    console.error("[suix-notify] Fatal:", err);
    process.exit(1);
  });
}
