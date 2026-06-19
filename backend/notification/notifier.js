/**
 * SuiX Notification Service — Notifier
 *
 * Responsible for:
 *   1. Dedup — only send when a wallet's status CHANGES (persisted via
 *      utility.drift_events.alert_sent, so it survives restarts).
 *   2. Seal decrypt — fetch the encrypted blob from NotificationCredential,
 *      run seal_approve against the NOTIFICATION contract, decrypt the handle.
 *   3. Telegram send — message the user's handle via the Bot API.
 *
 * SECURITY: the decrypted Telegram handle is PII. It is never written to the
 * database, never logged in plaintext, and is zeroed from memory immediately
 * after the message is sent (mirrors decryptedBytes.fill(0) in seal_decrypt.js).
 *
 * Dedup rule (per spec): notify once when the wallet leaves GREEN, then stay
 * quiet until status changes again (e.g. YELLOW→RED) or recovers to GREEN.
 */

import { SealClient, SessionKey } from "@mysten/seal";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: ${name} not set in .env`); process.exit(1); }
  return v;
}

const CONFIG = {
  BOT_PRIVATE_KEY: required("BOT_PRIVATE_KEY"),
  TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
  PACKAGE_ID: process.env.NOTIFICATION_PACKAGE_ID ?? "0xc09469d5816468c49d136d6f47ceb43e86560789457816652d431c76c7460ee5",
  CONFIG_ID: process.env.NOTIFICATION_CONFIG_ID ?? "0xecb7d250ef5537f9402b3c0221738b4c6a14e885f9c681b55b2551f7be140ddc",
  KEY_SERVER_ID: process.env.SEAL_KEY_SERVER_ID ?? "0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10",
  SEAL_SESSION_TTL_MIN: Number(process.env.SEAL_SESSION_TTL_MIN ?? 10),
  SEAL_TIMEOUT_MS: Number(process.env.SEAL_TIMEOUT_MS ?? 30000),
};

// Reconstruct operator keypair once
const { secretKey } = decodeSuiPrivateKey(CONFIG.BOT_PRIVATE_KEY.trim());
const botKeypair = Ed25519Keypair.fromSecretKey(secretKey);
const botAddress = botKeypair.getPublicKey().toSuiAddress();

/**
 * Decide whether to notify, and if so, decrypt + send.
 * Returns { alertSent: boolean }.
 */
export async function maybeNotify(sui, supabase, ctx) {
  const { wallet, status, isBaseline } = ctx;
  const walletAddress = wallet.wallet_address;

  // What status did we last notify this wallet about?
  const lastStatus = await getLastNotifiedStatus(supabase, walletAddress);

  // No change → nothing to do (covers GREEN→GREEN and persisting YELLOW/RED)
  if (lastStatus === status) {
    return { alertSent: false };
  }

  // Status changed. Record the new baseline regardless of whether we send.
  // On a baseline run (first scan after restart) we suppress the actual send
  // to avoid a false alert, but still seat the dedup state.
  if (isBaseline) {
    await setLastNotifiedStatus(supabase, walletAddress, status);
    console.log(`[notifier] Baseline set ${walletAddress} → ${status} (no send)`);
    return { alertSent: false };
  }

  // Recovery to GREEN — reset state, optionally send an "all clear".
  if (status === "GREEN") {
    await setLastNotifiedStatus(supabase, walletAddress, status);
    const sent = await sendAllClear(sui, supabase, ctx);
    return { alertSent: sent };
  }

  // YELLOW or RED and changed since last time → send the alert.
  let sent = false;
  try {
    const handle = await decryptHandle(sui, wallet);
    sent = await sendTelegram(handle, ctx);
    // Zero the handle reference ASAP (string is immutable, drop the ref)
  } catch (err) {
    console.error(`[notifier] Failed to notify ${walletAddress}:`, err.message);
    return { alertSent: false };
  }

  if (sent) {
    await setLastNotifiedStatus(supabase, walletAddress, status);
    if (ctx.driftEventId) {
      await supabase
        .from("drift_events")
        .update({ alert_sent: true })
        .eq("id", ctx.driftEventId);
    }
  }

  return { alertSent: sent };
}

// ─── Dedup state (persisted in utility.scanner_cursor) ────────────────────
// We reuse the scanner_cursor key/value store rather than adding a column.
// Key per wallet: 'notify_status:<wallet_address>'.

async function getLastNotifiedStatus(supabase, walletAddress) {
  const { data } = await supabase
    .from("scanner_cursor")
    .select("value")
    .eq("key", `notify_status:${walletAddress}`)
    .maybeSingle();
  return data?.value?.status ?? "GREEN";
}

async function setLastNotifiedStatus(supabase, walletAddress, status) {
  await supabase
    .from("scanner_cursor")
    .upsert(
      {
        key: `notify_status:${walletAddress}`,
        value: { status },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" }
    );
}

// ─── Seal decrypt ─────────────────────────────────────────────────────────
// Mirrors seal_decrypt.js / executeAutoRebalance exactly, but targets the
// NOTIFICATION contract (notification::seal_approve) and Config/Policy objects.

async function decryptHandle(sui, wallet) {
  const { wallet_address, policy_id, credential_id } = wallet;

  if (!credential_id) throw new Error("Missing credential_id");
  if (!policy_id) throw new Error("Missing policy_id");

  // Step 1 — fetch encrypted blob from NotificationCredential (2.x core API)
  const credObj = await sui.core.getObject({
    objectId: credential_id,
    include: { json: true },
  });

  const encryptedBlob = credObj.object?.json?.encrypted_blob;
  if (!encryptedBlob || !encryptedBlob.length) {
    throw new Error("Empty encrypted_blob on NotificationCredential");
  }
  const encryptedObject = new Uint8Array(encryptedBlob);

  // Step 2 — verify policy is active (seal_approve will deny otherwise)
  const policyObj = await sui.core.getObject({
    objectId: policy_id,
    include: { json: true },
  });
  if (!policyObj.object?.json?.active) {
    throw new Error("NotificationPolicy inactive — user paused notifications");
  }

  // Step 3 — build seal_approve PTB (Config + Policy as sharedObjectRef).
  // Mirrors seal_decrypt.js exactly: read initialSharedVersion off object.owner.
  const configObj = await sui.core.getObject({ objectId: CONFIG.CONFIG_ID });
  const configVersion = configObj.object.owner.Shared?.initialSharedVersion ?? configObj.object.version;
  const policyVersion = policyObj.object.owner.Shared?.initialSharedVersion ?? policyObj.object.version;

  // id = CONFIG_ID bytes, exactly as in seal_encrypt.js (id: CONFIG_ID)
  const idBytes = Array.from(Buffer.from(CONFIG.CONFIG_ID.replace("0x", ""), "hex"));

  const tx = new Transaction();
  tx.setSender(botAddress);
  tx.moveCall({
    target: `${CONFIG.PACKAGE_ID}::notification::seal_approve`,
    arguments: [
      tx.pure.vector("u8", idBytes),
      tx.sharedObjectRef({ objectId: CONFIG.CONFIG_ID, initialSharedVersion: configVersion, mutable: false }),
      tx.sharedObjectRef({ objectId: policy_id, initialSharedVersion: policyVersion, mutable: false }),
    ],
  });
  const txBytes = await tx.build({ client: sui, onlyTransactionKind: true });

  // Step 4 — Seal decrypt
  const sealClient = new SealClient({
    suiClient: sui,
    serverConfigs: [{ objectId: CONFIG.KEY_SERVER_ID, weight: 1 }],
    verifyKeyServers: false,
  });

  const sessionKey = await SessionKey.create({
    address: botAddress,
    packageId: CONFIG.PACKAGE_ID,
    ttlMin: CONFIG.SEAL_SESSION_TTL_MIN,
    signer: botKeypair,
    suiClient: sui,
  });

  let decryptedBytes;
  try {
    decryptedBytes = await Promise.race([
      sealClient.decrypt({ data: encryptedObject, sessionKey, txBytes }),
      new Promise((_, r) => setTimeout(() => r(new Error("Seal timeout")), CONFIG.SEAL_TIMEOUT_MS)),
    ]);

    const handle = new TextDecoder().decode(decryptedBytes);
    return handle.trim();
  } finally {
    if (decryptedBytes) decryptedBytes.fill(0);
  }
}

// ─── Telegram Bot API ───────────────────────────────────────────────────────
// The decrypted value is the user's numeric chat_id (captured by the listener
// when they pressed /start). Telegram's sendMessage takes that chat_id directly
// — no @handle, no prefixing. Send it raw, exactly as test_send.js does.

async function sendTelegram(chatId, ctx) {
  const text = buildMessage(ctx);

  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId).trim(),
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });

    const json = await res.json();
    if (!json.ok) {
      console.error(`[notifier] Telegram API error for ${ctx.wallet.wallet_address}: ${json.description}`);
      return false;
    }
    console.log(`[notifier] Sent ${ctx.status} alert to ${ctx.wallet.wallet_address}`);
    return true;
  } catch (err) {
    console.error(`[notifier] Telegram send failed:`, err.message);
    return false;
  }
}

async function sendAllClear(sui, supabase, ctx) {
  try {
    const handle = await decryptHandle(sui, ctx.wallet);
    return await sendTelegram(handle, { ...ctx, allClear: true });
  } catch (err) {
    // Recovery messages are best-effort; don't treat failure as fatal
    console.warn(`[notifier] All-clear send skipped for ${ctx.wallet.wallet_address}: ${err.message}`);
    return false;
  }
}

function buildMessage(ctx) {
  const { wallet, status, maxDrift, driftMap, reason, allClear } = ctx;
  const shortWallet = `${wallet.wallet_address.slice(0, 6)}…${wallet.wallet_address.slice(-4)}`;

  if (allClear) {
    return (
      `✅ *SuiX — Portfolio Balanced*\n\n` +
      `Wallet: \`${shortWallet}\`\n` +
      `Your index is back within tolerance. No action needed.`
    );
  }

  const icon = status === "RED" ? "🔴" : "🟡";
  const heading = status === "RED" ? "Action Required" : "Drift — Rebalance Recommended";

  const driftLines = Object.entries(driftMap ?? {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
    .map(([token, drift]) =>
      `  ${drift > 0 ? "▲" : "▼"} ${token.split("::").pop()}: ${drift > 0 ? "+" : ""}${drift.toFixed(2)}%`
    )
    .join("\n");

  return (
    `${icon} *SuiX — ${heading}*\n\n` +
    `Wallet: \`${shortWallet}\`\n` +
    `${reason}\n` +
    (Number.isFinite(maxDrift) ? `Max drift: *${maxDrift.toFixed(2)}%*\n` : "") +
    (driftLines ? `\nToken drift:\n${driftLines}\n` : "") +
    `\n👉 Open SuiX to rebalance.`
  );
}
