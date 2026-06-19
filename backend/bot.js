import 'dotenv/config';
import express from 'express';
import supabase from './lib/supabase.js';
import { runTokenTracker } from './services/tokenTracker.js';
import { runBasketManager } from './services/basketManager.js';
import routes from './api/routes.js';
import { corsMiddleware, requestLogger, statusLimiter, executeLimiter, validateWalletAddress, validateBasketKey } from './api/middleware.js';
// import { main as runScanner } from './rebalancer/scanner.js';
import telegramRoutes from './api/telegram.js';

// ── Config ────────────────────────────────────────────────────────────────────

const TRACKER_INTERVAL_HOURS = parseFloat(process.env.TRACKER_INTERVAL_HOURS) || 12;
const TRACKER_START_HOUR     = process.env.TRACKER_START_HOUR !== undefined ? parseInt(process.env.TRACKER_START_HOUR) : null;
const TRACKER_START_MINUTE   = parseInt(process.env.TRACKER_START_MINUTE) || 0;
const API_PORT               = parseInt(process.env.API_PORT) || 3010;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getTimestamp() {
    return new Date().toLocaleString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, timeZoneName: 'short'
    });
}

// ── API Server ────────────────────────────────────────────────────────────────

function startApiServer() {
    const app = express();
    app.set('trust proxy', 1);

    app.use(corsMiddleware);
    app.use(requestLogger);
    app.use(express.json());

    // Apply rate limiters and validators per route group
    app.use('/api/wallet/:address/status', statusLimiter, validateWalletAddress, validateBasketKey);
    app.use('/api/execute',                executeLimiter, validateWalletAddress);
    app.use('/api/automate',               executeLimiter);
    app.use('/api/basket',                 statusLimiter);
    app.use('/api/baskets',                statusLimiter);

    // Mount all routes under /api
    app.use('/api/telegram', telegramRoutes);
    app.use('/api', routes);

    app.listen(API_PORT, () => {
        console.log(`\n🌐 API server running on port ${API_PORT}`);
        console.log(`   Health:    http://localhost:${API_PORT}/api/health`);
        console.log(`   Baskets:   http://localhost:${API_PORT}/api/baskets`);
        console.log(`   Status:    http://localhost:${API_PORT}/api/wallet/:address/status?basket=suix-5`);
        console.log(`   Rebalance: http://localhost:${API_PORT}/api/execute/rebalance`);
        console.log(`   Redeem:    http://localhost:${API_PORT}/api/execute/redeem\n`);
    });
}

// ── Supabase Run Logger ───────────────────────────────────────────────────────
// run_type is no longer just 'market_cap' — the tracker now covers multiple
// categories per run, so we log 'all' and record per-category info in details.

async function logRun({ status, tokensUpdated, basketsUpdated, details, durationMs }) {
    const { error } = await supabase
        .from('tracker_runs')
        .insert({
            run_type:        'all',
            status,
            tokens_updated:  tokensUpdated,
            baskets_updated: basketsUpdated,
            details,
            duration_ms:     durationMs
        });

    if (error) console.log(`⚠️  Failed to log run: ${error.message}`);
    else       console.log(`📝 Run logged — status: ${status}`);
}

// ── Tracker + Basket Manager Run ──────────────────────────────────────────────

async function runOnce() {
    const startTime = Date.now();

    console.log('\n' + '═'.repeat(60));
    console.log(`🚀 TRACKER RUN STARTED: ${getTimestamp()}`);
    console.log('═'.repeat(60));

    let tokensUpdated  = 0;
    let basketsUpdated = 0;

    try {
        const { tokens, tokensUpdated: tu, runs, failures = [] } = await runTokenTracker();
        tokensUpdated = tu;

        // Basket manager runs even on partial tracker success — a basket whose
        // category failed is rebuilt from last-known-good active tokens, or
        // skipped (keeping previous weights) if too few remain.
        basketsUpdated = await runBasketManager();

        const durationMs = Date.now() - startTime;
        const isPartial  = failures.length > 0;

        await logRun({
            status: isPartial ? 'partial' : 'success',
            tokensUpdated,
            basketsUpdated,
            details: {
                categories: runs.map(r => ({ category: r.category, tokens: r.tokens.length })),
                ...(isPartial ? { failures } : {}),
                topToken: tokens[0]?.symbol,
                tokenCount: tokens.length,
            },
            durationMs
        });

        console.log('\n' + '═'.repeat(60));
        console.log(`${isPartial ? '⚠️  RUN PARTIAL' : '✅ RUN COMPLETE'}: ${getTimestamp()}`);
        console.log(`⏱️  Duration: ${(durationMs / 1000).toFixed(1)}s`);
        console.log('═'.repeat(60) + '\n');

    } catch (error) {
        const durationMs = Date.now() - startTime;
        console.error('\n❌ RUN FAILED:', error.message);
        await logRun({
            status: 'failed',
            tokensUpdated,
            basketsUpdated,
            details: { error: error.message },
            durationMs
        });
        throw error;
    }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function calculateFirstRunDelay() {
    if (TRACKER_START_HOUR === null) return 0;
    const now     = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(TRACKER_START_HOUR, TRACKER_START_MINUTE, 0, 0);
    if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
    return nextRun - now;
}

async function scheduleNextRun() {
    const now     = new Date();
    const nextRun = new Date(now);
    nextRun.setHours(
        TRACKER_START_HOUR !== null ? TRACKER_START_HOUR : now.getHours(),
        TRACKER_START_MINUTE, 0, 0
    );
    while (nextRun <= now) {
        nextRun.setHours(nextRun.getHours() + TRACKER_INTERVAL_HOURS);
    }

    const delay = nextRun - now;
    console.log(`⏰ Next tracker run: ${nextRun.toLocaleString()} (in ${Math.round(delay / 1000 / 60)} min)\n`);

    setTimeout(async () => {
        try {
            await runOnce();
        } catch (error) {
            console.error(`❌ Scheduled run failed: ${error.message}`);
        }
        await scheduleNextRun();
    }, delay);
}

// ── DISABLED 2026-06-09: scanner now runs as its own pm2 process (rebalancer/scanner.js, clock-aligned to 8:10) — do not re-enable here or it will double-run ──
// // ── Scanner Scheduler ─────────────────────────────────────────────────────────
//
// async function runScannerOnce() {
//     console.log('\n[scanner] Starting scheduled scan...');
//     try {
//         await runScanner();
//     } catch (err) {
//         console.error('[scanner] Run failed:', err.message);
//     }
// }
//
// async function scheduleScannerRuns() {
//     const SCANNER_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
//     await runScannerOnce();
//     setInterval(runScannerOnce, SCANNER_INTERVAL_MS);
// }

// ── Entry Point ───────────────────────────────────────────────────────────────

console.log('╔' + '═'.repeat(58) + '╗');
console.log('║' + ' '.repeat(14) + 'SUIX UTILITY BACKEND' + ' '.repeat(24) + '║');
console.log('╚' + '═'.repeat(58) + '╝\n');

const isManualRun = process.argv.includes('--manual');

if (isManualRun) {
    // Manual: run tracker once then exit — API server not started
    console.log('🔧 MANUAL RUN — tracker only, exiting when complete\n');
    runOnce()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));

} else {
    // Normal start: API server + scheduler both run together
    startApiServer();

    console.log(`⏰ Tracker interval: every ${TRACKER_INTERVAL_HOURS}h`);

    const firstDelay = calculateFirstRunDelay();
    if (firstDelay > 0) {
        const firstRun = new Date(Date.now() + firstDelay);
        console.log(`🎯 First tracker run: ${firstRun.toLocaleString()} (in ${Math.round(firstDelay / 1000 / 60)} min)\n`);
        sleep(firstDelay).then(runOnce).then(scheduleNextRun);
    } else {
        console.log('🚀 First tracker run: immediate\n');
        runOnce()
            .then(scheduleNextRun)
            .catch(error => {
                console.error('❌ Fatal tracker error:', error.message);
                // Don't exit — API server should keep running even if tracker fails
            });
    }

    // scheduleScannerRuns();

    process.on('SIGINT', () => {
        console.log(`\n🛑 Stopped at ${getTimestamp()}`);
        process.exit(0);
    });
}
