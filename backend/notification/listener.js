/**
 * SuiX Notification Service — Telegram Listener (module)
 *
 * The getUpdates loop, living INSIDE the notification service process and
 * started by index.js. Outbound-only: it polls api.telegram.org for /start
 * messages and writes the captured chat_id into utility.telegram_linking.
 * Needs no public URL and no tunnel.
 *
 * Reads TELEGRAM_BOT_TOKEN and LINK_TTL_MIN from .env (via dotenv), and uses
 * and the Supabase client passed in from index.js — no second client, no second
 * .env.
 *
 * The three HTTP endpoints (link-start/status/complete) do NOT live here — they
 * live in the backend at api/telegram.js. This module only captures chat_ids and
 * sweeps expired rows.
 */

import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: ${name} not set in .env`); process.exit(1); }
  return v;
}

const CONFIG = {
  TELEGRAM_BOT_TOKEN: required("TELEGRAM_BOT_TOKEN"),
  LINK_TTL_MIN: Number(process.env.LINK_TTL_MIN ?? 15),
  LINK_SWEEP_INTERVAL_MS: Number(process.env.LINK_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000),
};

const TG_API = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}`;

let offset = 0;
let polling = false;

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function tg(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

async function sendMessage(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

// ─── /start handler ───────────────────────────────────────────────────────────

async function handleStart(supabase, message, token) {
  const chatId = message.chat.id;

  if (!token) {
    await sendMessage(
      chatId,
      "👋 *SuiX Notifications*\n\n" +
        "To link this chat to your wallet, start from the SuiX Utility app and tap *Connect Telegram* there."
    );
    return;
  }

  const cutoff = new Date(Date.now() - CONFIG.LINK_TTL_MIN * 60 * 1000).toISOString();
  const { data: row, error } = await supabase
    .from("telegram_linking")
    .select("token, wallet_address, chat_id, created_at")
    .eq("token", token)
    .gte("created_at", cutoff)
    .maybeSingle();

  if (error) {
    console.error("[listener] lookup failed:", error.message);
    await sendMessage(chatId, "⚠️ Something went wrong. Please try again from the SuiX app.");
    return;
  }

  if (!row) {
    await sendMessage(
      chatId,
      "⚠️ *Link expired or invalid*\n\n" +
        "Please return to the SuiX app and tap *Connect Telegram* again for a fresh link."
    );
    return;
  }

  const { error: updErr } = await supabase
    .from("telegram_linking")
    .update({ chat_id: String(chatId) })
    .eq("token", token);

  if (updErr) {
    console.error("[listener] chat_id write failed:", updErr.message);
    await sendMessage(chatId, "⚠️ Could not complete linking. Please try again from the SuiX app.");
    return;
  }

  const short = `${row.wallet_address.slice(0, 6)}…${row.wallet_address.slice(-4)}`;
  const chatStr = String(chatId);
  const maskedChat = chatStr.length > 4 ? `${chatStr.slice(0, 2)}****${chatStr.slice(-2)}` : "****";
  await sendMessage(
    chatId,
    "✅ *Connected to SuiX Notifications*\n\n" +
      `You'll be notified about drift and rebalance opportunities for wallet \`${short}\`.\n\n` +
      "👉 *Please return to the SuiX app to finish enabling notifications.* " +
      "You'll sign one transaction to store your encrypted notification credential in your own wallet."
  );
  console.log(`[listener] Linked token ${token.slice(0, 8)}… → chat ${maskedChat} (wallet ${short})`);
}

// ─── getUpdates long-poll loop ─────────────────────────────────────────────────

async function pollLoop(supabase) {
  console.log("[listener] getUpdates loop running");
  while (polling) {
    try {
      const res = await fetch(`${TG_API}/getUpdates?offset=${offset}&timeout=30`);
      const json = await res.json();

      if (!json.ok) {
        console.error("[listener] getUpdates error:", json.description);
        await sleep(2000);
        continue;
      }

      for (const update of json.result) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text) continue;

        const text = message.text.trim();
        if (text.startsWith("/start")) {
          const parts = text.split(/\s+/);
          const tok = parts[1] ?? null;
          try {
            await handleStart(supabase, message, tok);
          } catch (err) {
            console.error("[listener] handleStart failed:", err.message);
          }
        }
      }
    } catch (err) {
      console.error("[listener] poll loop error:", err.message);
      await sleep(2000);
    }
  }
}

// ─── TTL sweep ─────────────────────────────────────────────────────────────────

async function sweep(supabase) {
  const cutoff = new Date(Date.now() - CONFIG.LINK_TTL_MIN * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("telegram_linking")
    .delete()
    .lt("created_at", cutoff);
  if (error) console.error("[listener] sweep failed:", error.message);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the listener. Awaits getMe (fails fast on a bad token), then kicks off
 * the poll loop in the background (does NOT block) and schedules the sweep.
 * Returns the bot username on success.
 */
export async function startListener(supabase) {
  const me = await tg("getMe");
  if (!me?.ok) {
    throw new Error(`getMe failed — check TELEGRAM_BOT_TOKEN: ${me?.description ?? "unknown error"}`);
  }
  console.log(`[listener] Connected as @${me.result.username}`);

  polling = true;

  // Sweep on boot + on an interval
  sweep(supabase).catch(() => {});
  setInterval(() => sweep(supabase).catch((e) => console.error(e.message)), CONFIG.LINK_SWEEP_INTERVAL_MS);

  // Fire-and-forget the poll loop — it runs for the life of the process
  pollLoop(supabase).catch((err) => console.error("[listener] poll loop crashed:", err.message));

  return me.result.username;
}

export function stopListener() {
  polling = false;
}
