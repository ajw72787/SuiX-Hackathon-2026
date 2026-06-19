# SuiX — Non-Custodial Portfolio Utility

SuiX lets you run an index-fund-style portfolio directly from your own wallet
on Sui. Pick a curated basket of tokens, and SuiX calculates drift and routes
the rebalance — sign it yourself in manual mode, or authorize automation to
sign it for you using a key only you control.

Built for **Sui Overflow 2026** — DeFi & Payments track.

## The problem

Most "set and forget" portfolio products require giving up custody of your
assets. SuiX keeps funds in the user's own wallet at all times — automation
works by encrypting a dedicated signing key with Seal and storing it
on-chain, never on a server, revocable in one transaction.

## How it works

1. **Pick a basket** — curated indexes (SuiX 5, SuiX 10, SuiX Meme, SuiX DeFi,
   SuiX Stack), recomputed every 12 hours from on-chain liquidity and market
   data.
2. **Connect a wallet** — that wallet becomes the user's portfolio.
3. **Rebalance** — manually (one signature, routed via the Cetus aggregator)
   or automatically, by activating a Seal-encrypted `AutomationCredential`.
4. **Get notified** — optional Telegram alerts when drift exceeds a
   threshold, via a separate Seal-encrypted `NotificationCredential`.

## Architecture

```
contracts/
  suix_automation/   — on-chain policy + AutomationCredential (Seal-encrypted signing key)
  suix_notification/ — on-chain policy + NotificationCredential (Seal-encrypted Telegram chat ID)

backend/
  api/                — Express routes (wallet status, rebalance/redeem tx building, Telegram linking)
  automation/         — scanner + automation engine (decrypts credential, signs, submits rebalance)
  notification/        — standalone service: Telegram listener, drift scanner, Seal-decrypt notifier
  services/            — shared execution engine (Cetus routing), token tracker, basket manager
  lib/                 — Supabase + Sui RPC clients

frontend/
  page.tsx             — main dashboard (basket comparison, redeem, automation/notification tabs)
  create/page.tsx      — generates + activates an automation wallet
  notifications/page.tsx — Telegram linking flow
```

## Non-custodial design

- Signing keys and Telegram chat IDs are Seal-encrypted **in the browser**
  before they ever leave the user's device.
- The backend only ever receives encrypted blobs — it requests decryption
  from Seal key servers at execution time, uses the key in memory, and wipes
  it immediately after (`decryptedBytes.fill(0)`).
- Every automated transaction is dry-run (`previewTransaction`) before
  signing — nothing executes blind.
- Users can deactivate and delete their credential on-chain at any time.

## Deployed (Mainnet)

| Contract | Package ID | Config ID |
|---|---|---|
| Automation (`policy`) | `0x65436b396702ba21d3c5cc0849aa0d83e7bff7d4fc90d22088d64f74aef73e5e` | `0x8efeeae6c6fa67146aa1de69ba7e3f1fa37cd19249890247f06d63ee949c8121` |
| Notification | `0xc09469d5816468c49d136d6f47ceb43e86560789457816652d431c76c7460ee5` | `0xecb7d250ef5537f9402b3c0221738b4c6a14e885f9c681b55b2551f7be140ddc` |

## Tech stack

Sui Move · Seal (encryption) · Cetus aggregator (swaps) · Next.js / dApp Kit ·
Express · Supabase

## Running locally

```bash
# Contracts
cd contracts/suix_automation && sui move test
cd contracts/suix_notification && sui move test

# Backend
cd backend
cp .env.example .env   # fill in your own keys
npm install
node bot.js              # API + tracker
node automation/scanner.js --run-now   # automation scan (manual trigger)
node notification/index.js --run-now   # notification scan (manual trigger)

# Frontend
cd frontend
npm install
npm run dev
```

## License

Source-available — see [LICENSE](LICENSE). Viewing and evaluation permitted; forking, redeployment, or reuse beyond attributed snippets is not.
