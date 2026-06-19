// ── api/telegram.js ─────────────────────────────────────────────────────────
//
// Telegram notification linking routes (Stage 2).
//
// Standalone route file — imports nothing from routes.js and shares no logic
// with the execution/automation routes. Touches only the utility.telegram_linking
// table (the transient token <-> wallet <-> chat_id row used during onboarding).
//
// Mounted in bot.js with:
//     import telegramRoutes from './api/telegram.js';
//     app.use('/api/telegram', telegramRoutes);   // before app.use('/api', routes)
//
// Endpoints (all under /api/telegram):
//     POST /link-start     { wallet_address }            -> { token, bot_url }
//     GET  /link-status    ?token=...                    -> { chat_id | null }
//     POST /link-complete  { token }                     -> { ok }
//
// The getUpdates listener that actually captures chat_id is a SEPARATE process
// (notification-bot) — it is outbound-only and needs no public URL. These routes
// just create the linking row, let the frontend poll for the chat_id the listener
// writes, and clean the row up once the credential is written on-chain.

import express from 'express';
import supabase from '../lib/supabase.js';

const router = express.Router();

// Bot username used to build the t.me deep link. Set TELEGRAM_BOT_USERNAME in
// .env once BotFather gives you the bot (no @, e.g. SuiXUtilityBot).
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';

// Linking rows older than this are considered expired (matches the listener's TTL).
const LINK_TTL_MIN = parseInt(process.env.LINK_TTL_MIN) || 15;

const SUI_ADDRESS_REGEX = /^0x[0-9a-fA-F]{1,64}$/;

// ── POST /link-start ──────────────────────────────────────────────────────────
// Create a one-time linking token for a wallet, return the t.me deep link.
//
// Body: { wallet_address }
// Returns: { token, bot_url }

router.post('/link-start', async (req, res) => {
    try {
        const { wallet_address, basket_id } = req.body || {};

        if (!wallet_address || !SUI_ADDRESS_REGEX.test(wallet_address)) {
            return res.status(400).json({ error: 'Valid wallet_address required' });
        }
        if (!BOT_USERNAME) {
            console.error('[telegram/link-start] TELEGRAM_BOT_USERNAME not set');
            return res.status(500).json({ error: 'Bot not configured' });
        }

        // Which basket to judge drift against. Defaults to suix-5 if omitted.
        const basket = (basket_id || 'suix-5').toString();

        // Clear any stale pending rows for this wallet so they don't accumulate
        await supabase
            .from('telegram_linking')
            .delete()
            .eq('wallet_address', wallet_address);

        const { data, error } = await supabase
            .from('telegram_linking')
            .insert({ wallet_address, basket_id: basket })
            .select('token')
            .single();

        if (error) {
            console.error('[telegram/link-start] insert failed:', error.message);
            return res.status(500).json({ error: 'Could not start linking' });
        }

        return res.json({
            token:   data.token,
            bot_url: `https://t.me/${BOT_USERNAME}?start=${data.token}`,
        });

    } catch (err) {
        console.error('[telegram/link-start]', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ── GET /link-status ────────────────────────────────────────────────────────
// Frontend polls this after opening the deep link. Returns the chat_id once the
// listener has captured it (null until then). Also reports expiry so the UI can
// prompt a retry.
//
// Query: ?token=...
// Returns: { chat_id: string | null, expired: boolean }

router.get('/link-status', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).json({ error: 'token required' });

        const { data, error } = await supabase
            .from('telegram_linking')
            .select('chat_id, created_at')
            .eq('token', token)
            .maybeSingle();

        if (error) {
            console.error('[telegram/link-status]', error.message);
            return res.status(500).json({ error: 'Lookup failed' });
        }

        if (!data) {
            // Row gone (completed or swept) — treat as expired so UI can reset
            return res.json({ chat_id: null, expired: true });
        }

        const ageMin = (Date.now() - new Date(data.created_at).getTime()) / 60000;
        return res.json({
            chat_id: data.chat_id ?? null,
            expired: ageMin > LINK_TTL_MIN,
        });

    } catch (err) {
        console.error('[telegram/link-status]', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ── POST /link-complete ───────────────────────────────────────────────────────
// Frontend calls this right after it has signed activate_notification and polled
// the NotificationActivated event for policy_id + credential_id. This finalizes
// the durable notification record:
//   1. Upsert the complete row into utility.telegram
//      (wallet, policy, credential, basket — basket pulled from the linking row).
//   2. Delete the transient linking row (chat_id is now encrypted on-chain).
//
// Writing here (rather than waiting for the registry's next poll) makes the
// notification go live immediately. The registry remains a safety-net reconciler
// and won't clobber basket_id on its event-driven upsert.
//
// Body: { token, wallet_address, policy_id, credential_id }
// Returns: { ok: true }

router.post('/link-complete', async (req, res) => {
    try {
        const { token, wallet_address, policy_id, credential_id } = req.body || {};
        if (!token) return res.status(400).json({ error: 'token required' });

        // Pull the basket the user chose (stored on the linking row at link-start)
        const { data: linkRow } = await supabase
            .from('telegram_linking')
            .select('wallet_address, basket_id')
            .eq('token', token)
            .maybeSingle();

        const wallet = wallet_address || linkRow?.wallet_address;
        const basket = linkRow?.basket_id || 'suix-5';

        // Finalize the durable notification record (idempotent on wallet_address)
        if (wallet && policy_id && credential_id) {
            const { error: upErr } = await supabase
                .from('telegram')
                .upsert(
                    {
                        wallet_address: wallet,
                        policy_id,
                        credential_id,
                        basket_id: basket,
                        updated_at: new Date().toISOString(),
                    },
                    { onConflict: 'wallet_address' }
                );
            if (upErr) {
                console.error('[telegram/link-complete] telegram upsert failed:', upErr.message);
                // fall through — still delete the linking row; registry will reconcile
            }
        }

        // Clean up the transient linking row
        const { error } = await supabase
            .from('telegram_linking')
            .delete()
            .eq('token', token);

        if (error) {
            console.error('[telegram/link-complete] cleanup failed:', error.message);
            return res.status(500).json({ error: 'Cleanup failed' });
        }

        return res.json({ ok: true });

    } catch (err) {
        console.error('[telegram/link-complete]', err.message);
        return res.status(500).json({ error: err.message });
    }
});

export default router;
