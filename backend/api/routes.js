import express from 'express';
import supabase from '../lib/supabase.js';
import {
    analyzeWallet,
    generateTrades,
    buildRebalanceTransaction,
    buildRedeemTransaction,
    previewTransaction,
} from '../services/executionEngine.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const router = express.Router();

// ── GET /health ───────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
    res.json({
        status:    'ok',
        timestamp: new Date().toISOString(),
        config: {
            fee_wallet_set: !!process.env.FEE_WALLET_ADDRESS,
            fee_bps:        parseInt(process.env.FEE_BPS)      || 50,
            slippage_bps:   parseInt(process.env.SLIPPAGE_BPS) || 350,
            network:        process.env.SUI_NETWORK || 'mainnet',
        }
    });
});

// ── GET /baskets ──────────────────────────────────────────────────────────────
// All active baskets — for basket selection UI

router.get('/baskets', async (req, res) => {
    try {
        const { default: supabase } = await import('../lib/supabase.js');

        const { data, error } = await supabase
            .from('baskets')
            .select('basket_key, name, description, category, token_count, last_updated')
            .eq('is_active', true)
            .order('basket_key');

        if (error) throw new Error(error.message);
        res.json({ baskets: data });

    } catch (err) {
        console.error('[GET /baskets]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /basket/:key ──────────────────────────────────────────────────────────
// Single basket — full composition and weights
// Example: GET /api/basket/suix-5

router.get('/basket/:key', async (req, res) => {
    try {
        const { default: supabase } = await import('../lib/supabase.js');

        const { data, error } = await supabase
            .from('baskets')
            .select('basket_key, name, description, category, token_count, weights, last_updated')
            .eq('basket_key', req.params.key)
            .eq('is_active', true)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: `Basket '${req.params.key}' not found` });
        }

        res.json({ basket: data });

    } catch (err) {
        console.error('[GET /basket/:key]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /wallet/:address/status ───────────────────────────────────────────────
// Scans wallet, returns dashboard data — green/yellow/red, drift, uninvested funds.
// Query params:
//   basket  — basket key, e.g. ?basket=suix-5  (required)
//
// Example: GET /api/wallet/0xabc.../status?basket=suix-5

router.get('/wallet/:address/status', async (req, res) => {
    try {
        const { address } = req.params;
        const { basket }  = req.query;

        if (!basket) {
            return res.status(400).json({ error: 'basket query param required — e.g. ?basket=suix-5' });
        }

        const analysis = await analyzeWallet(address, basket);

        const safeHoldings = analysis.holdings
            .filter(h => !h.isStale)
            .map(({ rawBalance, rawBalanceStr, ...rest }) => rest);

        res.json({
            wallet:      analysis.walletAddress,
            basket:      analysis.basketKey,
            basket_name: analysis.basketName,
            status:      analysis.status,
            total_usd:   analysis.totalUsdValue,
            gas_sui:     analysis.gasSui,
            max_drift:   analysis.maxDrift,
            uninvested:  analysis.uninvested,
            has_stale:   analysis.hasStale,
            stale_tokens: (analysis.staleHoldings || []).map(s => ({
                symbol:    s.symbol,
                coin_type: s.coinType,
            })),
            holdings:    safeHoldings,
            drift:       analysis.analysis.map(a => ({
                symbol:         a.symbol,
                target_weight:  a.target_weight,
                current_weight: a.current_weight,
                drift:          a.drift,
                current_value:  a.current_value,
            })),
            last_basket_update: analysis.lastBasketUpdate,
            timestamp:   new Date().toISOString(),
        });

    } catch (err) {
        console.error('[GET /wallet/status]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /execute/rebalance ───────────────────────────────────────────────────
// Builds an unsigned PTB for the user to sign.
// Covers initial deploy, drift correction, and adding new funds — same button.
//
// Body:
//   wallet_address  — user's dedicated wallet address
//   basket_key      — e.g. "suix-5"
//   deploy_usdc     — optional: additional USDC being deployed (number, USD value)
//
// Returns:
//   tx_bytes  — base64 PTB, pass to wallet.signAndExecuteTransaction()

router.post('/execute/rebalance', async (req, res) => {
    try {
        const { wallet_address, basket_key, deploy_usdc = 0 } = req.body;

        if (!wallet_address) return res.status(400).json({ error: 'wallet_address required' });
        if (!basket_key)     return res.status(400).json({ error: 'basket_key required' });

        console.log(`\n[POST /execute/rebalance] wallet=${wallet_address.slice(0, 10)}... basket=${basket_key} deploy_usdc=$${deploy_usdc}`);

        const walletAnalysis = await analyzeWallet(wallet_address, basket_key, { quoteStale: true });
        const trades         = generateTrades(walletAnalysis);

        if (trades.length === 0) {
            return res.json({
                status:  'no_trades_needed',
                message: 'Portfolio is within tolerance — no rebalance required',
                analysis: {
                    total_usd: walletAnalysis.totalUsdValue,
                    max_drift: walletAnalysis.maxDrift,
                    status:    walletAnalysis.status,
                }
            });
        }

        let txBytes = await buildRebalanceTransaction(wallet_address, trades);

        let preview = await previewTransaction(txBytes);
        if (!preview.success) {
            console.log(`[POST /execute/rebalance] dry-run failed: ${preview.error} — rebuilding...`);
            txBytes = await buildRebalanceTransaction(wallet_address, trades);
            preview = await previewTransaction(txBytes);
            if (!preview.success) {
                return res.status(422).json({ error: 'rebalance_simulation_failed', detail: preview.error });
            }
        }

        res.json({
            status:      'ready_to_sign',
            tx_bytes:    txBytes,
            trade_count: trades.length,
            trades:      trades.map(t => ({
                action:         t.action,
                from_symbol:    t.from_symbol,
                to_symbol:      t.to_symbol,
                from_coin_type: t.from_coin_type,
                to_coin_type:   t.to_coin_type,
                from_units:     t.from_units,   // already a string
                from_decimals:  t.from_decimals,
                usd_amount:     t.usd_amount,
                is_stale:       t.is_stale || false,
            })),
            analysis: {
                total_usd:  walletAnalysis.totalUsdValue,
                max_drift:  walletAnalysis.maxDrift,
                status:     walletAnalysis.status,
                uninvested: walletAnalysis.uninvested,
            },
            fee: {
                rate_bps:    parseInt(process.env.FEE_BPS) || 50,
                description: '0.50% collected via 7K on each swap',
            },
            gasEstimate: preview.gasUsedMist,
        });

    } catch (err) {
        // Dust-only trades are not an error — treat as balanced
        if (err.message?.includes('dust') || err.message?.includes('balanced')) {
            return res.json({
                status:  'no_trades_needed',
                message: err.message,
            });
        }
        console.error('[POST /execute/rebalance]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /execute/redeem ──────────────────────────────────────────────────────
// Builds an unsigned redemption PTB.
// Sells a % of portfolio back to USDC or SUI.
//
// Body:
//   wallet_address  — user's dedicated wallet address
//   basket_key      — e.g. "suix-5"
//   redeem_pct      — 1–100
//   redeem_to       — "usdc" (default) | "sui"

router.post('/execute/redeem', async (req, res) => {
    try {
        const { wallet_address, basket_key, redeem_pct, redeem_to = 'usdc' } = req.body;

        if (!wallet_address) return res.status(400).json({ error: 'wallet_address required' });
        if (!basket_key)     return res.status(400).json({ error: 'basket_key required' });
        if (!redeem_pct || redeem_pct < 1 || redeem_pct > 100) {
            return res.status(400).json({ error: 'redeem_pct must be 1–100' });
        }
        if (!['usdc', 'sui'].includes(redeem_to)) {
            return res.status(400).json({ error: 'redeem_to must be "usdc" or "sui"' });
        }

        console.log(`\n[POST /execute/redeem] wallet=${wallet_address.slice(0, 10)}... basket=${basket_key} pct=${redeem_pct}% to=${redeem_to}`);

        let txBytes = await buildRedeemTransaction(wallet_address, basket_key, redeem_pct, redeem_to);

        let preview = await previewTransaction(txBytes);
        if (!preview.success) {
            console.log(`[POST /execute/redeem] dry-run failed: ${preview.error} — rebuilding...`);
            txBytes = await buildRedeemTransaction(wallet_address, basket_key, redeem_pct, redeem_to);
            preview = await previewTransaction(txBytes);
            if (!preview.success) {
                return res.status(422).json({ error: 'rebalance_simulation_failed', detail: preview.error });
            }
        }

        res.json({
            status:     'ready_to_sign',
            tx_bytes:   txBytes,
            redeem_pct,
            redeem_to,
            fee: {
                rate_bps:    parseInt(process.env.FEE_BPS) || 50,
                description: '0.50% collected via 7K on each swap',
            },
            gasEstimate: preview.gasUsedMist,
        });

    } catch (err) {
        console.error('[POST /execute/redeem]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /api/automate/sponsor ────────────────────────────────────────────────
// Option C: Backend builds the complete activate_policy transaction,
// signs as gas sponsor, and returns tx_bytes + sponsor_sig to frontend.
// Frontend signs as sender (automation wallet keypair, never leaves browser)
// then submits both signatures directly to the Sui RPC.
//
// Private key never touches the backend — only the Seal-encrypted blob is sent.
//
// Body:
//   encrypted_blob     — array of numbers (Seal-encrypted keypair bytes)
//   automation_address — the new wallet's Sui address
//   drift_bps          — drift threshold in basis points (e.g. 300 = 3%)
//   freq_secs          — check frequency in seconds (e.g. 43200 = 12h)
//
// Returns:
//   tx_bytes    — base64 fully-built transaction, ready for sender to sign
//   sponsor_sig — base64 bot wallet signature over those tx bytes
//   bot_address — bot wallet address (for verification)

router.post('/automate/sponsor', async (req, res) => {
    try {
        const { encrypted_blob, automation_address, drift_bps = 300, freq_secs = 43200 } = req.body;

        // ── Validate inputs ───────────────────────────────────────────────────
        if (!encrypted_blob || !Array.isArray(encrypted_blob)) {
            return res.status(400).json({ error: 'encrypted_blob required (array of bytes)' });
        }
        if (!automation_address) {
            return res.status(400).json({ error: 'automation_address required' });
        }
        const SUI_ADDRESS_REGEX = /^0x[0-9a-fA-F]{64}$/;
        if (!SUI_ADDRESS_REGEX.test(automation_address)) {
            return res.status(400).json({ error: 'Invalid automation_address format' });
        }

        // ── Load bot keypair ──────────────────────────────────────────────────
        const backendSecretKey = process.env.BACKEND_SECRET_KEY;
        if (!backendSecretKey) throw new Error('BACKEND_SECRET_KEY not configured');

        const { secretKey } = decodeSuiPrivateKey(backendSecretKey.trim());
        const botKeypair = Ed25519Keypair.fromSecretKey(secretKey);
        const botAddress = botKeypair.getPublicKey().toSuiAddress();

        console.log(`\n[POST /automate/sponsor]`);
        console.log(`   automation: ${automation_address.slice(0, 10)}...`);
        console.log(`   bot:        ${botAddress.slice(0, 10)}...`);
        console.log(`   drift_bps:  ${drift_bps} | freq_secs: ${freq_secs}`);
        console.log(`   blob:       ${encrypted_blob.length} bytes`);

        // ── Connect to Sui ────────────────────────────────────────────────────
        const suiClient = new SuiClient({ url: 'https://fullnode.mainnet.sui.io' });

        // ── Fetch gas coin from bot wallet ────────────────────────────────────
        const gasCoins = await suiClient.getCoins({
            owner:    botAddress,
            coinType: '0x2::sui::SUI',
        });

        if (!gasCoins.data || gasCoins.data.length === 0) {
            return res.status(500).json({ error: 'Bot wallet has no SUI coins for gas' });
        }

        const gasCoin = gasCoins.data[0];
        console.log(`   gas coin:   ${gasCoin.coinObjectId} (${Number(gasCoin.balance) / 1e9} SUI)`);

        // ── Fetch shared object versions ──────────────────────────────────────
        const PACKAGE_ID = '0x65436b396702ba21d3c5cc0849aa0d83e7bff7d4fc90d22088d64f74aef73e5e';
        const CONFIG_ID  = '0x8efeeae6c6fa67146aa1de69ba7e3f1fa37cd19249890247f06d63ee949c8121';
        const CLOCK_ID   = '0x0000000000000000000000000000000000000000000000000000000000000006';

        const [configObj, clockObj] = await Promise.all([
            suiClient.getObject({ id: CONFIG_ID,  options: { showOwner: true } }),
            suiClient.getObject({ id: CLOCK_ID,   options: { showOwner: true } }),
        ]);

        const configVersion = configObj.data?.owner?.Shared?.initial_shared_version;
        const clockVersion  = clockObj.data?.owner?.Shared?.initial_shared_version;

        if (!configVersion || !clockVersion) {
            throw new Error('Could not read shared object versions for Config or Clock');
        }

        console.log(`   config v:   ${configVersion}`);
        console.log(`   clock v:    ${clockVersion}`);

        // ── Build the complete transaction ────────────────────────────────────
        const tx = new Transaction();

        // Sender is the automation wallet (signs in browser)
        tx.setSender(automation_address);

        // Bot wallet sponsors the gas
        tx.setGasOwner(botAddress);
        tx.setGasBudget(20_000_000);
        tx.setGasPayment([{
            objectId: gasCoin.coinObjectId,
            version:  gasCoin.version,
            digest:   gasCoin.digest,
        }]);

        tx.moveCall({
            target: `${PACKAGE_ID}::policy::activate_policy`,
            arguments: [
                tx.sharedObjectRef({
                    objectId:             CONFIG_ID,
                    initialSharedVersion: configVersion,
                    mutable:              true,
                }),
                tx.pure.u64(drift_bps),
                tx.pure.u64(freq_secs),
                tx.pure.vector('u8', encrypted_blob),
                tx.sharedObjectRef({
                    objectId:             CLOCK_ID,
                    initialSharedVersion: clockVersion,
                    mutable:              false,
                }),
            ],
        });

        const txBytes = await tx.build({ client: suiClient });
        console.log(`   tx built:   ${txBytes.length} bytes`);

        // ── Bot signs as sponsor ──────────────────────────────────────────────
        const sponsorSig = await botKeypair.signTransaction(txBytes);
        console.log(`   sponsor sig generated ✓`);

        res.json({
            status:      'ready',
            tx_bytes:    Buffer.from(txBytes).toString('base64'),
            sponsor_sig: sponsorSig.signature,
            bot_address: botAddress,
        });

        try {
            const driftBpsVal = parseInt(drift_bps);
            const freqSecsVal = parseInt(freq_secs);
            await supabase.from('wallets').upsert({
                wallet_address: automation_address,
                basket_id:      req.body.basket_key || 'suix-5',
                state:          '3',
                drift_bps:      Number.isFinite(driftBpsVal) ? driftBpsVal : 300,
                freq_secs:      Number.isFinite(freqSecsVal) ? freqSecsVal : 43200,
            }, { onConflict: 'wallet_address' });
            console.log('   wallet registered in utility.wallets ✓');
        } catch (dbErr) {
            console.warn('   DB write failed (non-fatal):', dbErr.message);
        }

    } catch (err) {
        console.error('[POST /automate/sponsor]', err.message);
        res.status(500).json({ error: err.message });
    }
});

export default router;
