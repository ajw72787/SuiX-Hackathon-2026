import "dotenv/config";
import ws from "ws";
import { createClient } from "@supabase/supabase-js";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { executeAutomatedRebalance, analyzeAutomationWallet } from "./automationEngine.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://wsbzxyqepahheeutuprz.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const SCANNER_INTERVAL_HOURS = parseInt(process.env.SCANNER_INTERVAL_HOURS || "12", 10);
const SCANNER_START_HOUR     = parseInt(process.env.SCANNER_START_HOUR     || "8",  10);
const SCANNER_START_MINUTE   = parseInt(process.env.SCANNER_START_MINUTE   || "0",  10);

const SUI_RPC_URL = process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const PACKAGE_ID = process.env.PACKAGE_ID;
const CONFIG_ID = process.env.CONFIG_ID;

const SEAL_KEY_SERVERS = (process.env.SEAL_KEY_SERVERS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  db: { schema: "utility" },
  realtime: { transport: ws },
});

const botPrivateKey = process.env.BOT_PRIVATE_KEY ?? process.env.BACKEND_SECRET_KEY;
const botKeypair = Ed25519Keypair.fromSecretKey(botPrivateKey.trim());

async function rpcCall(method, params = []) {
  const res = await fetch(SUI_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const json = await res.json();

  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message}`);
  }

  return json.result;
}

async function main() {
  console.log(`[suix] Starting run at ${new Date().toISOString()}`);
  await syncChainEvents();
  await scanAllWallets();
  console.log("[suix] Run complete");
}

async function syncChainEvents() {
  console.log("[events] Syncing chain events...");

  const { data: processed } = await supabase
    .from("chain_events")
    .select("tx_digest");

  const seenDigests = new Set((processed ?? []).map((r) => r.tx_digest).filter(Boolean));

  const { data: cursorRow } = await supabase
    .from("scanner_cursor")
    .select("value")
    .eq("key", "chain_events_cursor")
    .maybeSingle();

  let cursor = cursorRow?.value?.nextCursor ?? null;
  let totalProcessed = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await rpcCall("suix_queryEvents", [
      {
        MoveModule: {
          package: PACKAGE_ID,
          module: "policy",
        },
      },
      cursor,
      50,
      false,
    ]);

    for (const event of result.data ?? []) {
      const digest = event.id?.txDigest;
      if (digest && seenDigests.has(digest)) continue;

      await processChainEvent(event);

      if (digest) seenDigests.add(digest);
      totalProcessed++;
    }

    hasMore = !!result.hasNextPage;
    cursor = result.nextCursor ?? cursor;

    if (!hasMore && cursor) {
      await supabase
        .from("scanner_cursor")
        .upsert(
          {
            key: "chain_events_cursor",
            value: { nextCursor: cursor },
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" }
        );
    }
  }

  console.log(`[events] Synced ${totalProcessed} new events`);
}

async function processChainEvent(event) {
  const eventType = event.type?.split("::").pop();
  const fields = event.parsedJson ?? {};

  await supabase.from("chain_events").insert({
    event_type: eventType,
    wallet_address: fields.owner ?? fields.wallet_address ?? "",
    policy_id: fields.policy_id ?? null,
    credential_id: fields.automation_credential_id ?? fields.credential_id ?? null,
    raw_event: fields,
    tx_digest: event.id?.txDigest ?? null,
    checkpoint: event.checkpoint ? Number(event.checkpoint) : null,
  });

  switch (eventType) {
    case "PolicyActivated":
      await handlePolicyActivated(fields);
      break;
    case "AutomationCancelled":
      await handleAutomationCancelled(fields);
      break;
    case "LastRebalanceUpdated":
      await handleLastRebalanceUpdated(fields);
      break;
    case "PolicyDeactivated":
      await handlePolicyDeactivated(fields);
      break;
    case "PolicyReactivated":
      await handlePolicyReactivated(fields);
      break;
    default:
      break;
  }
}

async function handlePolicyActivated(fields) {
  const { data: existing } = await supabase.from('wallets').select('basket_id').eq('wallet_address', fields.owner).maybeSingle();
  const { error } = await supabase
    .from("wallets")
    .upsert(
      {
        wallet_address: fields.owner,
        policy_id: fields.policy_id,
        credential_id: fields.automation_credential_id ?? null,
        state: "3",
        basket_id: existing?.basket_id ?? "suix-5",
      },
      { onConflict: "wallet_address" }
    );

  if (error) {
    console.error("[events] PolicyActivated upsert failed:", error.message);
  } else {
    console.log(`[events] Registered wallet ${fields.owner} as State 3`);
  }
}

async function handleAutomationCancelled(fields) {
  const wallet_address = fields.owner;

  const { error } = await supabase
    .from("wallets")
    .delete()
    .eq("wallet_address", wallet_address);

  if (error) {
    console.error("[events] AutomationCancelled delete failed:", error.message);
  } else {
    console.log(`[events] Removed wallet ${wallet_address}`);
  }
}

async function handlePolicyDeactivated(fields) {
  const { error } = await supabase
    .from("wallets")
    .update({ paused: true })
    .eq("wallet_address", fields.owner);

  if (error) {
    console.error("[events] PolicyDeactivated update failed:", error.message);
  } else {
    console.log(`[events] Paused wallet ${fields.owner}`);
  }
}

async function handlePolicyReactivated(fields) {
  const { error } = await supabase
    .from("wallets")
    .update({ paused: false })
    .eq("wallet_address", fields.owner);

  if (error) {
    console.error("[events] PolicyReactivated update failed:", error.message);
  } else {
    console.log(`[events] Reactivated wallet ${fields.owner}`);
  }
}

async function handleLastRebalanceUpdated(fields) {
  const wallet_address = fields.owner ?? fields.wallet_address;
  const timestamp = fields.timestamp;

  const { error } = await supabase
    .from("wallets")
    .update({ last_rebalance: new Date(Number(timestamp)).toISOString() })
    .eq("wallet_address", wallet_address);

  if (error) {
    console.error("[events] LastRebalanceUpdated failed:", error.message);
  }
}

async function scanAllWallets() {
  const runStart = Date.now();
  console.log("[scanner] Starting wallet scan...");

  const { data: run, error: runErr } = await supabase
    .from("scan_runs")
    .insert({ status: "running" })
    .select("id")
    .single();

  if (runErr) throw new Error(`Failed to create scan run: ${runErr.message}`);

  const runId = run.id;

  let walletsScanned = 0;
  let alertsSent = 0;
  let rebalancesTriggered = 0;
  const errors = [];

  try {
    const { data: wallets, error: fetchErr } = await supabase
      .from("wallets")
      .select("wallet_address, policy_id, credential_id, state, basket_id, telegram_handle, last_rebalance, drift_bps, freq_secs, paused");

    if (fetchErr) throw fetchErr;

    console.log(`[scanner] ${wallets.length} wallets registered`);

    for (const wallet of wallets) {
      try {
        const result = await processWallet(wallet, runId);
        walletsScanned++;

        if (result.alertSent) alertsSent++;
        if (result.rebalanced) rebalancesTriggered++;
      } catch (err) {
        console.error(`[scanner] Error processing ${wallet.wallet_address}:`, err.message);
        errors.push({ wallet: wallet.wallet_address, error: err.message });
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
        rebalances_triggered: rebalancesTriggered,
        errors: errors.length > 0 ? errors : null,
        duration_ms: Date.now() - runStart,
      })
      .eq("id", runId);

    console.log(
      `[scanner] Scan complete — ${walletsScanned} wallets, ` +
        `${alertsSent} alerts, ${rebalancesTriggered} rebalances, ` +
        `${errors.length} errors — ${Date.now() - runStart}ms`
    );
  }
}

async function processWallet(wallet, runId) {
  const { wallet_address, state, basket_id, credential_id, telegram_handle } = wallet;

  if (wallet.paused) {
    console.log(`[scanner] skipping paused wallet ${wallet.wallet_address}`);
    return { alertSent: false, rebalanced: false };
  }

  const analysis = await analyzeAutomationWallet(wallet_address, basket_id);
  const maxDrift = analysis.maxDrift * 100;

  console.log("[scanner] analyzeWallet result:", {
    wallet_address,
    state,
    stateType: typeof state,
    basket_id,
    hasCredential: !!credential_id,
    status: analysis.status,
    maxDrift,
    totalUsdValue: analysis.totalUsdValue,
    analysisRows: analysis.analysis?.length,
    uninvested: analysis.uninvested,
    staleCount: analysis.staleHoldings?.length ?? 0,
  });

  const driftMap = Object.fromEntries(
    analysis.analysis.map((t) => [
      t.symbol,
      +(((t.current_weight - t.target_weight) * 100)).toFixed(4),
    ])
  );

  const walletDriftBps = Number(wallet.drift_bps) || 400;
  const driftExceedsThreshold = (analysis.maxDrift * 10000) >= walletDriftBps || String(analysis.status).toLowerCase() === "red";

  let driftEventId = null;

  if (driftExceedsThreshold) {
    const { data: evt, error: driftErr } = await supabase
      .from("drift_events")
      .insert({
        scan_run_id: runId,
        wallet_address,
        basket_id,
        state,
        max_drift_pct: maxDrift,
        drift_snapshot: driftMap,
        alert_sent: false,
        rebalance_triggered: false,
      })
      .select("id")
      .single();

    if (driftErr) {
      console.error("[scanner] drift_events insert failed:", driftErr.message);
    }

    driftEventId = evt?.id;
  }

  let alertSent = false;
  let rebalanced = false;

  if (!driftExceedsThreshold) {
    return { alertSent, rebalanced };
  }

  if ((String(state).trim() === "2" || String(state).trim() === "3") && telegram_handle) {
    alertSent = await sendTelegramAlert(telegram_handle, wallet_address, driftMap, maxDrift);

    if (driftEventId) {
      await supabase
        .from("drift_events")
        .update({ alert_sent: alertSent })
        .eq("id", driftEventId);
    }
  }

  console.log("[scanner] state3 gate:", {
    state,
    stateString: String(state).trim(),
    credential_id,
    hasCredential: !!credential_id,
    passes: String(state).trim() === "3" && !!credential_id,
  });

  if (String(state).trim() === "3" && credential_id) {
    const freqSecs = Number(wallet.freq_secs) || 43200;
    const lastMs = wallet.last_rebalance ? new Date(wallet.last_rebalance).getTime() : 0;
    if (Date.now() - lastMs < freqSecs * 1000) {
      const hoursRemaining = ((freqSecs * 1000 - (Date.now() - lastMs)) / 3600000).toFixed(2);
      console.log(`[scanner] skipping rebalance for ${wallet_address} — ${hoursRemaining}h until next eligible`);
      return { alertSent, rebalanced };
    }

    console.log("[scanner] attempting automated rebalance...");

    const rebalanceResult = await executeAutomatedRebalance(wallet, {
      botKeypair,
      packageId: PACKAGE_ID,
      configId: CONFIG_ID,
      sealKeyServers: SEAL_KEY_SERVERS,
    });

    console.log("[scanner] rebalance result:", rebalanceResult);

    rebalanced = rebalanceResult.success && !rebalanceResult.skipped;

    if (driftEventId) {
      await supabase
        .from("drift_events")
        .update({
          rebalance_triggered: true,
          rebalance_tx_hash: rebalanceResult.txHash ?? null,
          rebalance_status: rebalanceResult.success ? "success" : "failed",
          rebalance_error: rebalanceResult.error ?? null,
        })
        .eq("id", driftEventId);
    }

    await supabase.from("rebalance_history").insert({
      wallet_address,
      basket_id,
      trigger_source: "automation",
      drift_snapshot: driftMap,
      trades: rebalanceResult.trades ?? null,
      tx_hash: rebalanceResult.txHash ?? null,
      status: rebalanceResult.success ? "success" : "failed",
      error: rebalanceResult.error ?? null,
    });

    if (rebalanceResult.success && !rebalanceResult.skipped) {
      await supabase
        .from("wallets")
        .update({ last_rebalance: new Date().toISOString() })
        .eq("wallet_address", wallet_address);
    }
  }

  return { alertSent, rebalanced };
}

async function sendTelegramAlert(telegramHandle, walletAddress, driftMap, maxDrift) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[scanner] TELEGRAM_BOT_TOKEN not set — skipping alert");
    return false;
  }

  const shortWallet = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;

  const driftLines = Object.entries(driftMap)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
    .map(([token, drift]) =>
      `  ${drift > 0 ? "▲" : "▼"} ${token}: ${drift > 0 ? "+" : ""}${drift.toFixed(2)}%`
    )
    .join("\n");

  const message =
    `🔔 *SuiX Drift Alert*\n\n` +
    `Wallet: \`${shortWallet}\`\n` +
    `Max drift: *${maxDrift.toFixed(2)}%*\n\n` +
    `Token drift:\n${driftLines}\n\n` +
    `👉 Open SuiX to rebalance`;

  console.log(`[scanner] Telegram alert → ${telegramHandle}`);
  console.log(message);

  return true;
}

function msUntilNextRun() {
  const now  = new Date();
  const next = new Date();
  next.setHours(SCANNER_START_HOUR, SCANNER_START_MINUTE, 0, 0);
  // Advance by the interval until we find a future time
  while (next <= now) {
    next.setTime(next.getTime() + SCANNER_INTERVAL_HOURS * 60 * 60 * 1000);
  }
  return next.getTime() - now.getTime();
}

export { main };

if (process.argv[2] === "--run-now") {
  // Single manual run
  main().catch(console.error);
} else {
  const delayMs = msUntilNextRun();
  const nextRun = new Date(Date.now() + delayMs);
  console.log(`[suix] Scheduler started — first run at ${nextRun.toLocaleString()} (in ${(delayMs / 3600000).toFixed(1)}h), then every ${SCANNER_INTERVAL_HOURS}h`);
  setTimeout(() => {
    main().catch(console.error);
    setInterval(() => {
      main().catch(console.error);
    }, SCANNER_INTERVAL_HOURS * 60 * 60 * 1000);
  }, delayMs);
}
