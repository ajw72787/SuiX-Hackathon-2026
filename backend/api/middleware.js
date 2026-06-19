import rateLimit from 'express-rate-limit';

// ── CORS ──────────────────────────────────────────────────────────────────────
// Only allow requests from your frontend domain.
// Add localhost for local dev.

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(o => o.trim());

export function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// Status checks — fairly generous, frontend polls this for dashboard
export const statusLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max:      30,           // 30 requests per minute per IP
    message:  { error: 'Too many requests — slow down' },
    standardHeaders: true,
    legacyHeaders:   false,
});

// Execute endpoints — tighter, these hit 7K for quotes
export const executeLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max:      10,           // 10 execute requests per minute per IP
    message:  { error: 'Too many execution requests — please wait' },
    standardHeaders: true,
    legacyHeaders:   false,
});

// ── Input Validation ──────────────────────────────────────────────────────────
// Sui addresses are 0x followed by 64 hex characters

const SUI_ADDRESS_REGEX = /^0x[0-9a-fA-F]{64}$/;

export function validateWalletAddress(req, res, next) {
    const address = req.params.address || req.body?.wallet_address;

    if (!address) {
        return res.status(400).json({ error: 'Wallet address required' });
    }

    if (!SUI_ADDRESS_REGEX.test(address)) {
        return res.status(400).json({ error: 'Invalid Sui wallet address format' });
    }

    next();
}

export function validateBasketKey(req, res, next) {
    const VALID_BASKETS = ['suix-5', 'suix-10', 'suix-meme', 'suix-defi', 'suix-ai', 'suix-stack'];
    const key = req.params.key || req.body?.basket_key || req.query?.basket;

    if (!key) {
        return res.status(400).json({ error: 'basket_key required' });
    }

    if (!VALID_BASKETS.includes(key)) {
        return res.status(400).json({
            error:          `Invalid basket key: '${key}'`,
            valid_baskets:  VALID_BASKETS,
        });
    }

    next();
}

// ── Request Logger ────────────────────────────────────────────────────────────

export function requestLogger(req, res, next) {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const log      = `[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;

        if (res.statusCode >= 400) {
            console.error(log);
        } else {
            console.log(log);
        }
    });

    next();
}
