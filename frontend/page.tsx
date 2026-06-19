'use client';

import { useState, useEffect, useCallback } from 'react';
import { CoreClient as SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { SealClient } from '@mysten/seal';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import dynamic from 'next/dynamic';
import React from 'react';
import Link from 'next/link';

const ConnectButton = dynamic(
  () => import('@mysten/dapp-kit').then(m => m.ConnectButton),
  { ssr: false, loading: () => <div style={{ height: 38, width: 120, borderRadius: 12, background: 'rgba(255,255,255,0.08)' }} /> }
);

const API_URL  = '/utility-api';
const SUI_RPC  = process.env.NEXT_PUBLIC_SUI_RPC_URL || 'https://fullnode.mainnet.sui.io';
const LOGO_URL = 'https://indigo-elaborate-bovid-600.mypinata.cloud/ipfs/bafybeihr2x6573m4bccxqed7ykvz3attt257ao6di474qxoaeyho4bkzya';

// ── contract constants ─────────────────────────────────────────────────────────
const PACKAGE_ID = '0x65436b396702ba21d3c5cc0849aa0d83e7bff7d4fc90d22088d64f74aef73e5e';
const CONFIG_ID  = '0x8efeeae6c6fa67146aa1de69ba7e3f1fa37cd19249890247f06d63ee949c8121';
const MAINNET_KEY_SERVERS = [
  {
    objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10',
    url: 'https://open.key-server.mainnet.seal.mirai.cloud',
    weight: 1,
  },
];
const SEAL_THRESHOLD = 1;

// ── notification contract constants (credential sensing only) ─────────────────
const NOTIFICATION_PACKAGE_ID = '0xc09469d5816468c49d136d6f47ceb43e86560789457816652d431c76c7460ee5';
const NOTIFICATION_CONFIG_ID  = '0xecb7d250ef5537f9402b3c0221738b4c6a14e885f9c681b55b2551f7be140ddc';
const MAINNET_NOTIFICATION_KEY_SERVERS = [{
  objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10',
  url:      'https://open.key-server.mainnet.seal.mirai.cloud',
  weight:   1,
}];

// ── palette ────────────────────────────────────────────────────────────────────
const C = {
  bg0: '#05070d', ink: '#e8edf7', inkDim: '#9aa6bd', inkMute: '#5f6a82',
  line: 'rgba(148,170,210,0.12)', lineStrong: 'rgba(148,170,210,0.20)',
  brand: '#3aa1ff', brandSoft: '#7ad0ff',
  pos: '#4ade8c', warn: '#f5c14b', neg: '#ff6b8a', tg: '#26a5e4',
};

// ── types ──────────────────────────────────────────────────────────────────────
type PortfolioStatus  = 'green' | 'yellow' | 'red' | null;
type RedeemTo         = 'usdc' | 'sui';
type ActiveTab        = 'telegram' | 'auto';
type ActivationPhase  = 'idle' | 'step1' | 'step2' | 'querying' | 'encrypting' | 'done' | 'error' | 'deactivating';

interface BasketToken {
  symbol: string; name: string; target_weight: number;
  price_usd: number; market_cap_usd: number; coin_type: string;
  volume_24h_usd?: number | null;
  price_change_24h_pct?: number | null;
}
interface Basket {
  basket_key: string; name: string; description: string;
  weights: BasketToken[]; token_count: number; last_updated: string;
}
interface DriftItem {
  symbol: string; target_weight: number; current_weight: number;
  drift: number; current_value: number;
}
interface WalletStatus {
  status: PortfolioStatus; total_usd: number; max_drift: number;
  uninvested?: { usdc: number; sui: number; hasAny: boolean };
  has_stale: boolean; stale_tokens: { symbol: string; coin_type: string }[];
  drift: DriftItem[]; holdings: { symbol: string; humanAmt: number; usdValue: number }[];
  gas_sui?: number;
}

// ── helpers ────────────────────────────────────────────────────────────────────
const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;
const fmtFreq = (secs: number): string =>
  secs < 86400 ? `${Math.round(secs / 3600)}h` : `${Math.round(secs / 86400)}d`;
const formatUsdCompact = (n: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);

// ── shared style objects ────────────────────────────────────────────────────────
const WRAP: React.CSSProperties = { maxWidth: 1280, margin: '0 auto', padding: '0 clamp(16px, 4vw, 48px)', position: 'relative', zIndex: 1 };
const PANEL: React.CSSProperties = {
  marginTop: 24, borderRadius: 24, border: `1px solid ${C.lineStrong}`,
  background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)',
  backdropFilter: 'blur(20px) saturate(130%)', padding: 32, position: 'relative', overflow: 'hidden',
};
const BTN_PRIMARY: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 10,
  padding: '12px 18px', borderRadius: 12, fontSize: 14, fontWeight: 500,
  border: '1px solid rgba(120,180,255,0.45)',
  background: 'linear-gradient(180deg, #2a8bff 0%, #1561d6 100%)',
  color: '#fff', cursor: 'pointer', letterSpacing: '-0.005em',
  boxShadow: '0 1px 0 rgba(255,255,255,0.18) inset, 0 10px 28px rgba(20,90,220,0.40)',
  fontFamily: 'inherit',
};
const BTN_GHOST: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 10,
  padding: '12px 18px', borderRadius: 12, fontSize: 14, fontWeight: 500,
  border: `1px solid ${C.lineStrong}`, background: 'transparent',
  color: C.ink, cursor: 'pointer', fontFamily: 'inherit',
};
const BTN_DANGER: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 10,
  padding: '12px 18px', borderRadius: 12, fontSize: 14, fontWeight: 500,
  border: '1px solid rgba(255,107,138,0.45)',
  background: 'linear-gradient(180deg, #ff5a7c 0%, #c5314e 100%)',
  color: '#fff', cursor: 'pointer', fontFamily: 'inherit',
  boxShadow: '0 1px 0 rgba(255,255,255,0.18) inset, 0 10px 28px rgba(220,40,80,0.32)',
};
const MONO: React.CSSProperties = { fontFamily: "'Geist Mono', ui-monospace, monospace", letterSpacing: 0 };
const TOKEN_COLORS: Record<string, string> = { SUI: '#4DA2FF', WAL: '#7B6FFF', DEEP: '#FF6B6B', MMT: '#4ECDC4', TRUTH: '#FFD93D', MAGMA: '#FF8C42', SWARM: '#A8FF78', IKA: '#F7B731', CETUS: '#26de81' };
const FALLBACK_COLORS = ['#4DA2FF','#7B6FFF','#FF6B6B','#4ECDC4','#FFD93D','#FF8C42'];
const ICON_OVERRIDES: Record<string, string> = {
  SUI: '/tokens/sui.png',
  MAGMA: '/tokens/magma.jpg',
};
const tokenColor = (sym: string, i = 0) => TOKEN_COLORS[sym] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
const BASKET_SUBTITLES: Record<string, string> = {
  'suix-5':    'Top 5 · more concentrated',
  'suix-10':   'Top 10 · more diversified',
  'suix-meme': 'Sui memes · high risk',
  'suix-defi': 'Sui DeFi protocol tokens',
  'suix-stack': 'Sui core protocol layers',
};
const BASKET_WEIGHTING: Record<string, string> = {
  'suix-stack': 'equal-weighted',
};

const BASKET_DISPLAY_NAMES: Record<string, string> = {
  'suix-5':    'SuiX 5',
  'suix-10':   'SuiX 10',
  'suix-meme': 'SuiX Meme',
  'suix-defi': 'SuiX DeFi',
  'suix-stack': 'SuiX Stack',
};

// ── arrows SVG ─────────────────────────────────────────────────────────────────
const ArrowRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M5 12h14M13 5l7 7-7 7"/>
  </svg>
);
const CheckSVG = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M5 12l4.5 4.5L20 6"/>
  </svg>
);

// ══════════════════════════════════════════════════════════════════════════════
export default function UtilityDashboard() {
  useEffect(() => { document.title = 'SuiX Utility — Non-Custodial Portfolio Management'; }, []);

  const [menuOpen, setMenuOpen] = useState(false);

  const currentAccount = useCurrentAccount();
  const connected      = !!currentAccount?.address;
  const userAddress    = currentAccount?.address;
  const { mutate: signAndExecuteTransaction } = useSignAndExecuteTransaction();
  const [client] = useState(() => new SuiClient({ network: 'mainnet' }));

  // basket
  const [baskets,        setBaskets]        = useState<Basket[]>([]);
  const [selectedBasket, setSelectedBasket] = useState('suix-5');
  const [basketDetail,   setBasketDetail]   = useState<Basket | null>(null);

  // wallet
  const [walletStatus,  setWalletStatus]  = useState<WalletStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // actions
  const [redeemPct,     setRedeemPct]     = useState(100);
  const [redeemTo,      setRedeemTo]      = useState<RedeemTo>('usdc');
  const [actionLoading, setActionLoading] = useState(false);
  const [txStatus,      setTxStatus]      = useState('');
  const [previewTrades, setPreviewTrades] = useState<{ action: string; symbol: string; usd_amount: number; from_symbol?: string; to_symbol?: string; is_stale?: boolean }[] | null>(null);

  // ui
  const [activeTab,      setActiveTab]      = useState<ActiveTab>('telegram');
  const [driftBps,       setDriftBps]       = useState(300);
  const [freqSecs,       setFreqSecs]       = useState(43200);
  // automation activation
  const [activationPhase, setActivationPhase] = useState<ActivationPhase>('idle');
  const [activationError, setActivationError] = useState('');
  const [policyId,        setPolicyId]        = useState('');
  const [credentialId,    setCredentialId]    = useState('');
  const [policyActive,    setPolicyActive]    = useState(true);

  // telegram credential sensing
  const [tgPolicyId,     setTgPolicyId]     = useState('');
  const [tgCredentialId, setTgCredentialId] = useState('');
  const [tgPolicyActive, setTgPolicyActive] = useState(true);

  const [suinsName, setSuinsName] = useState<string | null>(null);
  const [tokenIcons, setTokenIcons] = useState<Record<string, string>>({});

  // ── data loading ─────────────────────────────────────────────────────────────
  const loadBaskets = useCallback(async () => {
    try {
      const res  = await fetch(`${API_URL}/api/baskets`);
      const data = await res.json();
      const order = ['suix-5', 'suix-10', 'suix-meme', 'suix-defi', 'suix-stack'];
      const mc    = (data.baskets || [])
        .filter((b: Basket) => order.includes(b.basket_key))
        .sort((a: Basket, b: Basket) => order.indexOf(a.basket_key) - order.indexOf(b.basket_key));
      setBaskets(mc.length > 0 ? mc : data.baskets || []);
    } catch (e) { console.error('loadBaskets', e); }
  }, []);

  const loadBasketDetail = useCallback(async (key: string) => {
    try {
      const res  = await fetch(`${API_URL}/api/basket/${key}`);
      const data = await res.json();
      setBasketDetail(data.basket);
    } catch (e) { console.error('loadBasketDetail', e); }
  }, []);

  const loadWalletStatus = useCallback(async () => {
    if (!userAddress) return;
    setStatusLoading(true);
    try {
      const res  = await fetch(`${API_URL}/api/wallet/${userAddress}/status?basket=${selectedBasket}`);
      const data = await res.json();
      setWalletStatus(data);
    } catch (e) { console.error('loadWalletStatus', e); }
    finally { setStatusLoading(false); }
  }, [userAddress, selectedBasket]);

  useEffect(() => { loadBaskets(); }, [loadBaskets]);
  useEffect(() => { loadBasketDetail(selectedBasket); }, [selectedBasket, loadBasketDetail]);
  useEffect(() => {
    if (!connected) { setWalletStatus(null); return; }
    loadWalletStatus();
    const i = setInterval(loadWalletStatus, 30_000);
    return () => clearInterval(i);
  }, [connected, loadWalletStatus]);

  // ── load existing policy on wallet connect ────────────────────────────────────
  async function loadExistingPolicy(address: string) {
    try {
      const res = await fetch('https://fullnode.mainnet.sui.io', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'suix_getOwnedObjects',
          params: [
            address,
            { filter: { StructType: '0x65436b396702ba21d3c5cc0849aa0d83e7bff7d4fc90d22088d64f74aef73e5e::policy::AutomationCredential' }, options: { showContent: true } },
          ],
        }),
      });
      const json = await res.json();
      if (!json.result?.data || json.result.data.length === 0) return;
      const objectId: string = json.result.data[0].data.objectId;
      const policy_id: string = json.result.data[0].data.content.fields.policy_id;
      setPolicyId(policy_id);
      setCredentialId(objectId);
      try {
        const policyRes = await fetch('https://fullnode.mainnet.sui.io', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 2,
            method: 'sui_getObject',
            params: [policy_id, { showContent: true }],
          }),
        });
        const policyJson = await policyRes.json();
        const content = policyJson.result?.data?.content;
        setPolicyActive(content?.fields?.active !== false);
        if (content?.fields?.drift_threshold_bps !== undefined)
          setDriftBps(Number(content.fields.drift_threshold_bps));
        if (content?.fields?.frequency_secs !== undefined)
          setFreqSecs(Number(content.fields.frequency_secs));
      } catch { setPolicyActive(true); }
      setActivationPhase('done');
    } catch { /* silent */ }
  }

  useEffect(() => {
    if (userAddress && activationPhase === 'idle') loadExistingPolicy(userAddress);
  }, [userAddress, activationPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadExistingNotificationCredential(address: string) {
    try {
      const res = await fetch('https://fullnode.mainnet.sui.io', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'suix_getOwnedObjects',
          params: [
            address,
            { filter: { StructType: `${NOTIFICATION_PACKAGE_ID}::notification::NotificationCredential` }, options: { showContent: true } },
          ],
        }),
      });
      const json = await res.json();
      if (!json.result?.data || json.result.data.length === 0) return;
      const obj = json.result.data[0].data;
      const tgPId = obj.content?.fields?.policy_id ?? '';
      setTgPolicyId(tgPId);
      setTgCredentialId(obj.objectId);
      if (tgPId) {
        try {
          const policyRes = await fetch('https://fullnode.mainnet.sui.io', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 2,
              method: 'sui_getObject',
              params: [tgPId, { showContent: true }],
            }),
          });
          const policyJson = await policyRes.json();
          const content = policyJson.result?.data?.content;
          setTgPolicyActive(content?.fields?.active !== false);
        } catch { setTgPolicyActive(true); }
      }
    } catch { /* silent */ }
  }

  useEffect(() => {
    if (userAddress) loadExistingNotificationCredential(userAddress);
  }, [userAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!userAddress) { setSuinsName(null); return; }
    fetch('https://fullnode.mainnet.sui.io', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'suix_resolveNameServiceNames',
        params: [userAddress],
      }),
    })
      .then(r => r.json())
      .then(j => setSuinsName(j.result?.data?.[0] ?? null))
      .catch(() => setSuinsName(null));
  }, [userAddress]);

  useEffect(() => {
    if (!basketDetail) return;
    const missing = basketDetail.weights.filter(t => !ICON_OVERRIDES[t.symbol] && !tokenIcons[t.coin_type]);
    if (missing.length === 0) return;
    Promise.all(
      missing.map(t =>
        fetch('https://fullnode.mainnet.sui.io', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getCoinMetadata', params: [t.coin_type] }),
        })
          .then(r => r.json())
          .then(j => ({ coin_type: t.coin_type, iconUrl: (j.result?.iconUrl as string) || '' }))
          .catch(() => ({ coin_type: t.coin_type, iconUrl: '' }))
      )
    ).then(results => {
      const updates: Record<string, string> = {};
      for (const { coin_type, iconUrl } of results) {
        if (iconUrl) updates[coin_type] = iconUrl;
      }
      setTokenIcons(prev => ({ ...prev, ...updates }));
    });
  }, [basketDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── actions ───────────────────────────────────────────────────────────────────
  async function handlePreview() {
    if (!userAddress) return;
    setActionLoading(true); setPreviewTrades(null); setTxStatus('Fetching trade preview…');
    try {
      const res  = await fetch(`${API_URL}/api/execute/rebalance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: userAddress, basket_key: selectedBasket, deploy_usdc: walletStatus?.uninvested?.usdc || 0 }),
      });
      const data = await res.json();
      if (data.status === 'no_trades_needed') { setTxStatus('✅ Portfolio is already balanced'); setPreviewTrades([]); return; }
      if (data.error) throw new Error(data.error);
      setPreviewTrades(data.trades || []); setTxStatus('');
    } catch (e: any) { setTxStatus(`❌ Preview failed: ${e.message}`); }
    finally { setActionLoading(false); }
  }

  async function handleRebalance() {
    if (!userAddress) return;
    setActionLoading(true); setTxStatus('Building transaction…');
    try {
      const res  = await fetch(`${API_URL}/api/execute/rebalance`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: userAddress, basket_key: selectedBasket, deploy_usdc: walletStatus?.uninvested?.usdc || 0 }),
      });
      const data = await res.json();
      if (data.status === 'no_trades_needed') { setTxStatus('✅ Portfolio is already balanced'); return; }
      if (!data.tx_bytes) throw new Error(data.error || 'No transaction returned');
      setTxStatus(`Signing ${data.trade_count} swap(s)…`);
      signAndExecuteTransaction(
        { transaction: data.tx_bytes as any },
        {
          onSuccess: (result: any) => { setTxStatus(`✅ Rebalanced! TX: ${result?.digest?.slice(0, 8)}…`); setTimeout(loadWalletStatus, 4000); },
          onError: (e: any) => { setTxStatus(`❌ Transaction rejected: ${e?.message || 'Unknown error'}`); },
        }
      );
    } catch (e: any) { setTxStatus(`❌ ${e.message}`); }
    finally { setActionLoading(false); }
  }

  async function handleRedeem() {
    if (!userAddress) return;
    setActionLoading(true); setTxStatus('Building redemption transaction…');
    try {
      const res  = await fetch(`${API_URL}/api/execute/redeem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: userAddress, basket_key: selectedBasket, redeem_pct: redeemPct, redeem_to: redeemTo }),
      });
      const data = await res.json();
      if (!data.tx_bytes) throw new Error(data.error || 'No transaction returned');
      setTxStatus('Signing redemption…');
      signAndExecuteTransaction(
        { transaction: data.tx_bytes as any },
        {
          onSuccess: (result: any) => { setTxStatus(`✅ Redeemed ${redeemPct}% to ${redeemTo.toUpperCase()}! TX: ${result?.digest?.slice(0, 8)}…`); setTimeout(loadWalletStatus, 4000); },
          onError: (e: any) => { setTxStatus(`❌ Transaction rejected: ${e?.message || 'Unknown error'}`); },
        }
      );
    } catch (e: any) { setTxStatus(`❌ ${e.message}`); }
    finally { setActionLoading(false); }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ⚠ LIKELY UNUSED — flagged 2026-06 for future review (do not delete yet)
  //
  // This is the OLD inline policy-creation flow (generate keypair → Seal-encrypt →
  // activate_policy → poll for PolicyActivated). The "Create Automated Wallet" CTA in
  // the auto tab now links to /utility/create instead of calling this, so nothing in
  // this file appears to trigger handleActivatePolicy anymore.
  //
  // NOTE: this is NOT the credential-detection logic. Sensing an incoming wallet that
  // already holds an AutomationCredential is handled by loadExistingPolicy() — that one
  // is live and must stay. The in-progress phase rows ('encrypting' / 'step1' /
  // 'querying') in the auto tab are also only reachable through this function.
  //
  // Kept for reference / a possible future inline-activation path. Verify before relying on it.
  // ──────────────────────────────────────────────────────────────────────────

  // ── State 3: single-step policy activation + Seal encryption ─────────────────
  async function handleActivatePolicy() {
    if (!userAddress) return;
    setActivationPhase('encrypting');
    setActivationError('');

    const signTx = (tx: Transaction): Promise<{ digest: string }> =>
      new Promise((resolve, reject) =>
        signAndExecuteTransaction(
          { transaction: tx },
          { onSuccess: resolve as any, onError: reject }
        )
      );

    try {
      const signingKeypair = Ed25519Keypair.generate();
      const encodedKey = signingKeypair.getSecretKey();
      const { secretKey: rawKeyBytes } = decodeSuiPrivateKey(encodedKey);
      const keyBytes = new Uint8Array(32);
      keyBytes.set(rawKeyBytes.slice(0, 32));

      const sealSuiClient = new SuiJsonRpcClient({
        url: 'https://fullnode.mainnet.sui.io',
        network: 'mainnet' as any,
      });
      const sealClient = new SealClient({
        suiClient: sealSuiClient as any,
        serverConfigs: MAINNET_KEY_SERVERS,
        verifyKeyServers: false,
      });

      const { encryptedObject } = await sealClient.encrypt({
        threshold: SEAL_THRESHOLD,
        packageId: PACKAGE_ID,
        id: PACKAGE_ID,
        data: keyBytes,
        demType: 1,
      });

      const blobArray = Array.from(encryptedObject);

      setActivationPhase('step1');
      const txA = new Transaction();
      txA.moveCall({
        target: `${PACKAGE_ID}::policy::activate_policy`,
        arguments: [
          txA.object(CONFIG_ID),
          txA.pure.u64(driftBps),
          txA.pure.u64(freqSecs),
          txA.pure.vector('u8', blobArray),
          txA.object('0x6'),
        ],
      });
      txA.setGasBudget(100_000_000);

      const resultA = await signTx(txA);

      setActivationPhase('querying');
      let pId = '', cId = '';
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const txBlock = await sealSuiClient.getTransactionBlock({
            digest: resultA.digest,
            options: { showEvents: true },
          });
          const events = (txBlock as any).events || [];
          const ev = events.find((e: any) =>
            e.type?.includes('PolicyActivated')
          );
          if (ev?.parsedJson) {
            const d = ev.parsedJson as any;
            pId = d.policy_id;
            cId = d.automation_credential_id;
            break;
          }
        } catch { }
      }
      if (!pId || !cId) throw new Error('PolicyActivated event not found after 18s');

      setActivationPhase('done');
      setPolicyId(pId);
      setCredentialId(cId);

    } catch (e: any) {
      const errMsg = e?.message ?? String(e);
      const errStack = e?.stack ? e.stack.slice(0, 300) : '';
      setActivationError(errMsg + ' | ' + errStack);
      setActivationPhase('error');
    }
  }

  // ── State 3: deactivate + delete policy ───────────────────────────────────────
  async function handleDeactivate() {
    if (!userAddress || !policyId || !credentialId) return;
    setActivationPhase('deactivating'); setActivationError('');
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::policy::deactivate_and_delete`,
        arguments: [
          tx.object(CONFIG_ID),
          tx.object(policyId),
          tx.object(credentialId),
          tx.object('0x6'),
        ],
      });
      tx.setGasBudget(100_000_000);
      await new Promise<void>((resolve, reject) =>
        signAndExecuteTransaction({ transaction: tx }, { onSuccess: () => resolve(), onError: reject })
      );
      setPolicyId(''); setCredentialId('');
      setActivationPhase('idle');
    } catch (e: any) {
      setActivationError(e?.message ?? String(e));
      setActivationPhase('error');
    }
  }

  // ── State 3: pause policy (deactivate_policy — reversible) ──────────────────
  async function handlePause() {
    if (!userAddress || !policyId) return;
    setActivationError('');
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::policy::deactivate_policy`,
        arguments: [tx.object(policyId)],
      });
      tx.setGasBudget(100_000_000);
      await new Promise<void>((resolve, reject) =>
        signAndExecuteTransaction({ transaction: tx }, { onSuccess: () => resolve(), onError: reject })
      );
      setPolicyActive(false);
    } catch (e: any) {
      setActivationError(e?.message ?? String(e));
    }
  }

  // ── State 3: resume policy (reactivate_policy) ────────────────────────────
  async function handleResume() {
    if (!userAddress || !policyId) return;
    setActivationError('');
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::policy::reactivate_policy`,
        arguments: [tx.object(policyId)],
      });
      tx.setGasBudget(100_000_000);
      await new Promise<void>((resolve, reject) =>
        signAndExecuteTransaction({ transaction: tx }, { onSuccess: () => resolve(), onError: reject })
      );
      setPolicyActive(true);
    } catch (e: any) {
      setActivationError(e?.message ?? String(e));
    }
  }

  // ── Telegram: deactivate + delete notification credential ────────────────────
  async function handleDeactivateNotification() {
    if (!userAddress || !tgPolicyId || !tgCredentialId) return;
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${NOTIFICATION_PACKAGE_ID}::notification::deactivate_and_delete`,
        arguments: [
          tx.object(NOTIFICATION_CONFIG_ID),
          tx.object(tgPolicyId),
          tx.object(tgCredentialId),
          tx.object('0x6'),
        ],
      });
      tx.setGasBudget(20_000_000);
      await new Promise<void>((resolve, reject) =>
        signAndExecuteTransaction({ transaction: tx }, { onSuccess: () => resolve(), onError: reject })
      );
      await new Promise(r => setTimeout(r, 3000));
      setTgPolicyId('');
      setTgCredentialId('');
    } catch (e: any) {
      console.error('deactivateNotification', e?.message ?? e);
    }
  }

  // ── Telegram: pause notification (reversible) ────────────────────────────────
  async function handlePauseNotification() {
    if (!userAddress || !tgPolicyId) return;
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${NOTIFICATION_PACKAGE_ID}::notification::deactivate_notification`,
        arguments: [tx.object(tgPolicyId)],
      });
      tx.setGasBudget(20_000_000);
      await new Promise<void>((resolve, reject) =>
        signAndExecuteTransaction({ transaction: tx }, { onSuccess: () => resolve(), onError: reject })
      );
      setTgPolicyActive(false);
    } catch (e: any) {
      console.error('pauseNotification', e?.message ?? e);
    }
  }

  // ── Telegram: resume notification ─────────────────────────────────────────────
  async function handleResumeNotification() {
    if (!userAddress || !tgPolicyId) return;
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${NOTIFICATION_PACKAGE_ID}::notification::reactivate_notification`,
        arguments: [tx.object(tgPolicyId)],
      });
      tx.setGasBudget(20_000_000);
      await new Promise<void>((resolve, reject) =>
        signAndExecuteTransaction({ transaction: tx }, { onSuccess: () => resolve(), onError: reject })
      );
      setTgPolicyActive(true);
    } catch (e: any) {
      console.error('resumeNotification', e?.message ?? e);
    }
  }

  // ── derived ───────────────────────────────────────────────────────────────────
  const portStatus   = walletStatus?.status;
  const driftPct     = driftBps / 100;
  const freqHrs      = freqSecs / 3600;
  const redeemGross  = (walletStatus?.total_usd || 0) * redeemPct / 100;
  const redeemFee    = redeemGross * 0.005;
  const redeemNet    = redeemGross - redeemFee;

  const modePillText =
    activationPhase === 'done' && policyId ? `AUTOMATED · ${driftPct.toFixed(0)}% · ${fmtFreq(freqSecs)}`
    : tgPolicyId ? 'TELEGRAM ALERTS'
    : 'MANUAL MODE';

  function statusStripProps() {
    if (!connected) return null;
    if (statusLoading && !walletStatus) return null;
    if (!walletStatus) return null;
    const s = walletStatus.status;
    if (s === 'green') return { cls: 'ok', color: '#a8f0c4', borderColor: 'rgba(74,222,140,0.20)', bg: 'rgba(20,28,46,0.65)', title: 'Portfolio balanced', meta: `Max drift ${fmtPct(walletStatus.max_drift)} · within threshold` };
    if (s === 'red')   return { cls: 'red', color: '#ffa3b6', borderColor: 'rgba(255,107,138,0.30)', bg: 'linear-gradient(180deg,rgba(50,16,22,0.55),rgba(10,15,28,0.6))', title: 'Action required', meta: walletStatus.has_stale ? `Stale tokens to exit: ${walletStatus.stale_tokens.map(t => t.symbol).join(', ')} · Max drift ${fmtPct(walletStatus.max_drift)}` : `Max drift ${fmtPct(walletStatus.max_drift)}` };
    return { cls: 'warn', color: '#ffd884', borderColor: 'rgba(245,193,75,0.28)', bg: 'linear-gradient(180deg,rgba(50,40,16,0.55),rgba(10,15,28,0.6))', title: 'Drifting — rebalance recommended', meta: `Max drift ${fmtPct(walletStatus.max_drift)} · ${walletStatus.uninvested?.hasAny ? fmtUsd(walletStatus.uninvested.usdc) + ' USDC uninvested · ' : ''}last scan just now` };
  }
  const strip = statusStripProps();

  // drift color
  const driftColor = (d: number) => d > 0.05 ? '#ffa3b6' : d > 0.02 ? '#ffd884' : '#a8f0c4';

  return (
    <div className="utility-page" style={{ minHeight: '100vh', background: C.bg0, color: C.ink, fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif", letterSpacing: '-0.01em', overflowX: 'hidden' }}>

      {/* ── Background ── */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: `
          radial-gradient(1100px 700px at 80% -10%, rgba(30,123,255,0.20), transparent 60%),
          radial-gradient(900px 600px at 10% 10%, rgba(58,161,255,0.08), transparent 55%),
          radial-gradient(1400px 800px at 50% 110%, rgba(10,79,204,0.16), transparent 60%),
          linear-gradient(180deg,#05070d 0%, #070b14 45%, #05070d 100%)` }} />
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
        background: 'radial-gradient(120% 80% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)' }} />

      {/* Mobile menu */}
      {menuOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(5,7,13,0.92)', backdropFilter: 'blur(20px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }} onClick={() => setMenuOpen(false)}>
          <button onClick={() => setMenuOpen(false)} style={{ position: 'absolute', top: 32, right: 24, background: 'none', border: 'none', cursor: 'pointer', color: C.inkDim, padding: 8 }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          {([['Vaults', '/vaults'], ['Utility', '/utility'], ['Learn', '/learn']] as [string, string][]).map(([label, href]) => (
            <Link key={href} href={href} onClick={() => setMenuOpen(false)} style={{ fontSize: 32, fontWeight: 500, color: C.ink, textDecoration: 'none', padding: '16px 48px', borderRadius: 16 }}>{label}</Link>
          ))}
        </div>
      )}

      {/* ── Nav ── */}
      <nav style={{ position: 'sticky', top: 0, zIndex: 50,
        backdropFilter: 'blur(18px) saturate(140%)', WebkitBackdropFilter: 'blur(18px) saturate(140%)',
        background: 'linear-gradient(180deg, rgba(5,7,13,0.72), rgba(5,7,13,0.32))',
        borderBottom: `1px solid ${C.line}` }}>
        <div style={WRAP}>
          <div className="nav-row" style={{ display: 'flex', alignItems: 'center', gap: 32, height: 96 }}>
            <Link href="/" aria-label="SuiX" style={{ display: 'flex', alignItems: 'center' }}>
              <img src={LOGO_URL} alt="SuiX" className="nav-logo"
                style={{ height: 136, width: 'auto', filter: 'drop-shadow(0 0 24px rgba(58,161,255,0.45))', transition: 'filter .25s ease, transform .25s ease' }} />
            </Link>
            <div className="navlinks" style={{ display: 'flex', gap: 2, marginLeft: 44 }}>
              {([['Vaults', '/vaults'], ['Utility', '/utility'], ['Learn', '/learn']] as [string, string][]).map(([label, href]) => (
                <Link key={href} href={href} className="nav-link"
                  style={{ padding: '10px 18px', borderRadius: 11, fontSize: 15, color: href === '/utility' ? C.ink : C.inkDim, fontWeight: 400, textDecoration: 'none',
                    ...(href === '/utility' ? { background: 'rgba(58,161,255,0.10)', border: `1px solid rgba(58,161,255,0.18)` } : {}) }}>
                  {label}
                </Link>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <div className="network-pill" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 999, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', fontSize: 12, color: C.inkDim, ...MONO }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.pos, boxShadow: `0 0 8px ${C.pos}`, display: 'inline-block', flexShrink: 0 }} />
              Sui · Mainnet
            </div>
            <button className="hamburger-btn" onClick={() => setMenuOpen(true)} style={{ display: 'none', background: 'none', border: 'none', cursor: 'pointer', color: C.inkDim, padding: 8, borderRadius: 8, flexShrink: 0 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
            </button>
          </div>
        </div>
      </nav>

      {/* ── Page Head ── */}
      <section style={{ padding: '72px 0 36px', position: 'relative' }}>
        <div style={WRAP}>

          <div style={{ textAlign: 'center' }}>
            {/* eyebrow */}
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderRadius: 999, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.025)', fontSize: 12, color: C.inkDim, ...MONO, letterSpacing: '0.10em', marginBottom: 24 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.brand, display: 'inline-block', animation: 'pulseDot 2.4s infinite' }} />
              NON-CUSTODIAL · YOUR WALLET · YOUR CONTROL
            </div>
            <h1 style={{ fontSize: 'clamp(40px, 6vw, 80px)', lineHeight: 0.97, letterSpacing: '-0.04em', fontWeight: 500, margin: '0 auto' }}>
              <span style={{ background: 'linear-gradient(180deg,#ffffff 0%,#cfdeef 55%,#7a93b8 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'block' }}>
                Run an index fund
              </span>
              <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, background: 'linear-gradient(120deg,#9fd1ff 0%,#3aa1ff 50%,#1561d6 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'block' }}>
                from your own wallet.
              </em>
            </h1>
            <p style={{ fontSize: 15, lineHeight: 1.6, color: C.inkDim, maxWidth: '46ch', margin: '20px auto 0' }}>
              Follow a target basket inside the wallet you control. SuiX calculates drift and routes the rebalance — you sign it in manual mode, or let SuiX's automation sign it for you using a key you authorize.
            </p>
          </div>

          {/* mode pills — only when connected */}
          {connected && (
            <div style={{ marginTop: 24, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'center' }}>
              <span className="mode-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 999, border: `1px solid ${C.lineStrong}`, background: 'rgba(20,28,46,0.45)', backdropFilter: 'blur(20px)', fontSize: 12, color: C.inkDim, ...MONO, letterSpacing: '0.06em' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: activeTab === 'auto' ? C.pos : activeTab === 'telegram' ? C.tg : C.brand, boxShadow: `0 0 8px ${activeTab === 'auto' ? C.pos : activeTab === 'telegram' ? C.tg : C.brand}`, display: 'inline-block', ...(activeTab === 'auto' ? { animation: 'pulseDotGreen 2.2s infinite' } : {}) }} />
                <span style={{ color: C.inkMute }}>MODE</span>
                <span style={{ color: C.ink }}>{modePillText}</span>
              </span>
              <span className="mode-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderRadius: 999, border: `1px solid ${C.lineStrong}`, background: 'rgba(20,28,46,0.45)', backdropFilter: 'blur(20px)', fontSize: 12, color: C.inkDim, ...MONO, letterSpacing: '0.06em' }}>
                <span style={{ color: C.inkMute }}>BASKET</span>
                <span style={{ color: C.ink }}>{BASKET_DISPLAY_NAMES[selectedBasket] || selectedBasket.toUpperCase()}</span>
              </span>
            </div>
          )}

          {/* 3-step onboarding strip — shown only when disconnected */}
          {!connected && (
            <div style={{ marginTop: 32 }}>
              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <div style={{ ...MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute }}>How the utility works</div>
              </div>
              <div className="onboarding-grid" style={{ borderRadius: 20, border: `1px solid ${C.line}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.45), rgba(10,15,28,0.45))', backdropFilter: 'blur(20px)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
                {([
                  { num: '01', title: 'Pick your index', desc: 'Choose from one of our curated indexes: SuiX 5, SuiX 10, SuiX Meme, SuiX DeFi, or SuiX Stack — weighted indexes recomputed every 12 hours. You can pick before or after connecting.' },
                  { num: '02', title: 'Connect your wallet', desc: 'This wallet becomes your index portfolio — only use a wallet dedicated to SuiX Utility.' },
                  { num: '03', title: 'Rebalance', desc: 'Preview your drift and hit Rebalance. One signature in manual mode, routed via Cetus aggregator — or activate automation for hands-free rebalancing.' },
                ] as { num: string; title: string; desc: string }[]).map(({ num, title, desc }, i) => (
                  <div key={num} style={{ padding: '36px 40px', borderLeft: i > 0 ? `1px solid ${C.line}` : 'none' }}>
                    <div style={{ ...MONO, fontSize: 12, color: C.brand, letterSpacing: '0.10em', marginBottom: 12 }}>{num}</div>
                    <div style={{ fontSize: 17, fontWeight: 500, color: C.ink, marginBottom: 10 }}>{title}</div>
                    <div style={{ fontSize: 14, color: C.inkDim, lineHeight: 1.65 }}>{desc}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ maxWidth: 1080, margin: '0 auto', width: '100%' }}>

          {/* basket selector label */}
          <div style={{ textAlign: 'center', marginTop: 40 }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 8 }}>Choose your index</div>
            <div style={{ fontSize: 14, color: C.inkDim, maxWidth: '52ch', margin: '0 auto' }}>
              An index is a curated  basket of Sui tokens (market-cap or equal-weighted) recomputed every 12 hours. Pick one to follow in your own wallet.
            </div>
          </div>

          {/* basket picker */}
          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
            {(baskets.length > 0 ? baskets : ([{ basket_key: 'suix-5', name: BASKET_DISPLAY_NAMES['suix-5'] }, { basket_key: 'suix-10', name: BASKET_DISPLAY_NAMES['suix-10'] }] as any[]).sort((a: any, b: any) => ['suix-5', 'suix-10'].indexOf(a.basket_key) - ['suix-5', 'suix-10'].indexOf(b.basket_key))).map((b: any) => (
              <button key={b.basket_key} onClick={() => setSelectedBasket(b.basket_key)}
                className="basket-btn"
                style={{ padding: '10px 18px', borderRadius: 12, fontSize: 13, fontWeight: 500,
                  border: selectedBasket === b.basket_key ? '1px solid rgba(120,180,255,0.40)' : `1px solid ${C.line}`,
                  background: selectedBasket === b.basket_key ? 'linear-gradient(180deg, rgba(58,161,255,0.10), rgba(30,123,255,0.04))' : 'rgba(255,255,255,0.02)',
                  color: selectedBasket === b.basket_key ? C.ink : C.inkDim, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', transition: 'all .2s ease' }}>
                {b.name || BASKET_DISPLAY_NAMES[b.basket_key] || b.basket_key.toUpperCase()}
                <span style={{ ...MONO, fontSize: 10.5, color: selectedBasket === b.basket_key ? C.brandSoft : C.inkMute, letterSpacing: '0.06em' }}>
                  {BASKET_SUBTITLES[b.basket_key] ?? ''}
                </span>
              </button>
            ))}
          </div>

          {/* ── Basket composition (always visible) ── */}
          <div style={{ marginTop: 24, borderRadius: 20, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.45) 0%, rgba(10,15,28,0.45) 100%)', backdropFilter: 'blur(20px) saturate(130%)', padding: 28, position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(255,255,255,0.03), transparent 30%)' }} />
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
              <div>
                <div style={{ ...MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 6 }}>What&apos;s inside</div>
                <div style={{ fontSize: 16, fontWeight: 500, color: C.ink }}>
                  {BASKET_DISPLAY_NAMES[selectedBasket] || selectedBasket.toUpperCase()} holdings <span style={{ color: C.inkDim, fontWeight: 400 }}>· {BASKET_WEIGHTING[selectedBasket] ?? 'market-cap weighted'} · updated every 12h</span>
                </div>
              </div>
              {basketDetail && (
                <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.06em', textAlign: 'right' }}>
                  LAST UPDATED · <span style={{ color: C.inkDim }}>{new Date(basketDetail.last_updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                </div>
              )}
            </div>

            {!basketDetail ? (
              <div style={{ padding: '32px 0', textAlign: 'center', color: C.inkMute, fontSize: 13, ...MONO }}>Loading composition…</div>
            ) : (
              <>
                {/* stacked allocation bar */}
                <div style={{ height: 34, borderRadius: 10, overflow: 'hidden', display: 'flex', gap: 2 }}>
                  {basketDetail.weights.map((t, i) => {
                    const color = tokenColor(t.symbol, i);
                    const textColor = ['#FFD93D', '#A8FF78', '#4ECDC4', '#26de81', '#F7B731'].includes(color) ? '#05070d' : '#fff';
                    return (
                      <div key={t.coin_type} style={{ flex: t.target_weight * 100, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {t.target_weight >= 0.08 && (
                          <span style={{ ...MONO, fontSize: 11, color: textColor }}>{Math.round(t.target_weight * 100)}%</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* legend */}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
                  {basketDetail.weights.map((t, i) => {
                    const color = tokenColor(t.symbol, i);
                    return (
                      <div key={t.coin_type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: color, display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ fontSize: 12, color: C.inkDim }}>{t.symbol}</span>
                      </div>
                    );
                  })}
                </div>
                {/* compact table rows */}
                <div style={{ marginTop: 20 }}>
                  <div className="basket-header-row" style={{ display: 'grid', gridTemplateColumns: '28px 36px 1fr 90px 82px 72px 100px 80px', gap: 14, padding: '0 0 8px', borderBottom: `1px solid ${C.line}`, ...MONO, fontSize: 10, color: C.inkMute, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                    <div /><div />
                    <div>Token</div>
                    <div className="basket-col-extra" style={{ textAlign: 'right' }}>Mcap</div>
                    <div className="basket-col-extra" style={{ textAlign: 'right' }}>Vol</div>
                    <div className="basket-col-extra" style={{ textAlign: 'right' }}>24H</div>
                    <div style={{ textAlign: 'right' }}>Price</div>
                    <div style={{ textAlign: 'right' }}>Weight</div>
                  </div>
                  {basketDetail.weights.map((t, i) => {
                    const rank = String(i + 1).padStart(2, '0');
                    const pct24h = t.price_change_24h_pct;
                    const pct24hColor = pct24h == null || pct24h === 0 ? C.inkMute : pct24h > 0 ? C.pos : C.neg;
                    const pct24hText = pct24h == null || pct24h === 0 ? '—' : `${pct24h > 0 ? '+' : ''}${pct24h.toFixed(1)}%`;
                    return (
                      <div key={t.coin_type} className="basket-row" style={{ display: 'grid', gridTemplateColumns: '28px 36px 1fr 90px 82px 72px 100px 80px', gap: 14, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${C.line}` }}>
                        <div style={{ ...MONO, fontSize: 11, color: C.inkMute, textAlign: 'right' }}>{rank}</div>
                        <div><TokenIcon iconUrl={tokenIcons[t.coin_type]} symbol={t.symbol} /></div>
                        <div>
                          <span style={{ fontWeight: 500, fontSize: 14, color: C.ink }}>{t.symbol}</span>
                          <span style={{ fontSize: 12, color: C.inkMute, marginLeft: 8, fontWeight: 400 }}>{t.name}</span>
                        </div>
                        <div className="basket-col-extra" style={{ ...MONO, fontSize: 12, color: C.inkDim, textAlign: 'right' }}>
                          {t.market_cap_usd ? formatUsdCompact(t.market_cap_usd) : '—'}
                        </div>
                        <div className="basket-col-extra" style={{ ...MONO, fontSize: 12, color: C.inkMute, textAlign: 'right' }}>
                          {t.volume_24h_usd != null ? formatUsdCompact(t.volume_24h_usd) : '—'}
                        </div>
                        <div className="basket-col-extra" style={{ ...MONO, fontSize: 12, color: pct24hColor, textAlign: 'right' }}>
                          {pct24hText}
                        </div>
                        <div style={{ ...MONO, fontSize: 12, color: C.inkDim, textAlign: 'right' }}>${t.price_usd.toFixed(4)}</div>
                        <div style={{ ...MONO, fontSize: 16, fontWeight: 500, color: '#cfe2ff', textAlign: 'right' }}>{fmtPct(t.target_weight)}</div>
                        <div className="basket-row-mobile-meta" style={{ display: 'none' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden' }}>
                              <TokenIcon iconUrl={tokenIcons[t.coin_type]} symbol={t.symbol} />
                              <span style={{ fontWeight: 500, fontSize: 14, color: C.ink, flexShrink: 0 }}>{t.symbol}</span>
                              <span style={{ fontSize: 12, color: C.inkMute, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                            </div>
                            <span style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 20, fontWeight: 500, color: '#cfe2ff', flexShrink: 0 }}>{fmtPct(t.target_weight)}</span>
                          </div>
                          <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                            <div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 3 }}>PRICE</div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12.5, color: C.inkDim }}>${t.price_usd.toFixed(4)}</div>
                            </div>
                            <div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 3 }}>MCAP</div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12.5, color: C.inkDim }}>{t.market_cap_usd ? formatUsdCompact(t.market_cap_usd) : '—'}</div>
                            </div>
                            <div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 3 }}>VOL</div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12.5, color: C.inkDim }}>{t.volume_24h_usd != null ? formatUsdCompact(t.volume_24h_usd) : '—'}</div>
                            </div>
                            <div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 3 }}>24H</div>
                              <div style={{ fontFamily: "'Geist Mono', ui-monospace, monospace", fontSize: 12.5, color: pct24hColor }}>{pct24hText}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* connect prompt when disconnected */}
          {!connected && (
            <div style={{ marginTop: 32, borderRadius: 20, border: `1px solid rgba(58,161,255,0.20)`, background: 'rgba(58,161,255,0.04)', padding: '28px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 500, color: C.ink, marginBottom: 6 }}>Connect your dedicated wallet</div>
                <div style={{ fontSize: 14, color: C.inkDim, maxWidth: '48ch', lineHeight: 1.55 }}>This wallet will be treated as your index portfolio. Only use a wallet dedicated exclusively to SuiX Utility.</div>
              </div>
              <div style={{ borderRadius: 10, overflow: 'hidden' }}>
                <ConnectButton />
              </div>
            </div>
          )}

          {/* connected wallet status row */}
          {connected && (
            <div style={{ marginTop: 32, borderRadius: 20, border: `1px solid rgba(58,161,255,0.20)`, background: 'rgba(58,161,255,0.04)', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: C.inkDim, fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: 4 }}>Connected Wallet</div>
                <div style={{ fontSize: 14, fontWeight: 500, color: C.ink, fontFamily: 'monospace' }}>
                  {suinsName ?? (userAddress ? userAddress.slice(0, 6) + '…' + userAddress.slice(-4) : '')}
                </div>
              </div>
              <div style={{ borderRadius: 10, overflow: 'hidden' }}>
                <ConnectButton />
              </div>
            </div>
          )}

          {/* ── Portfolio comparison (connected view) ── */}
          {connected && (
            <PortfolioComparisonPanel
              basketDetail={basketDetail}
              walletStatus={walletStatus}
              userAddress={userAddress}
              selectedBasket={selectedBasket}
              driftBps={driftBps}
              actionLoading={actionLoading}
              onRebalance={handleRebalance}
              suinsName={suinsName}
            />
          )}

          {/* tx status */}
          {txStatus && (
            <div style={{ marginTop: 16, borderRadius: 14, padding: '14px 18px', fontSize: 13,
              ...(txStatus.includes('✅') ? { border: '1px solid rgba(74,222,140,0.25)', background: 'rgba(74,222,140,0.08)', color: '#a8f0c4' } :
                  txStatus.includes('❌') ? { border: '1px solid rgba(255,107,138,0.25)', background: 'rgba(255,107,138,0.08)', color: '#ffa3b6' } :
                  { border: `1px solid rgba(58,161,255,0.25)`, background: 'rgba(58,161,255,0.08)', color: C.brandSoft }) }}>
              {txStatus}
            </div>
          )}

          {/* ── Redeem panel (always visible when connected) ── */}
          {connected && walletStatus && (
            <div style={PANEL}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(255,255,255,0.04), transparent 30%)' }} />
              <div style={{ marginBottom: 28 }}>
                <div style={{ ...MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 8 }}>Exit</div>
                <h3 style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em', margin: 0, lineHeight: 1.1 }}>
                  Redeem · <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, color: C.brand }}>Exit position</em>
                </h3>
                <p style={{ margin: '8px 0 0', color: C.inkDim, fontSize: 14, maxWidth: '54ch', lineHeight: 1.55 }}>
                  Sell a portion of your basket back to USDC or SUI. Tokens stay in your wallet at all times.
                </p>
              </div>

              <div className="redeem-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 24 }}>
                <div>
                  <label style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Redeem to</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: 5, borderRadius: 14, border: `1px solid ${C.lineStrong}`, background: 'rgba(20,28,46,0.45)', marginTop: 14 }}>
                    {(['usdc', 'sui'] as RedeemTo[]).map(opt => (
                      <button key={opt} onClick={() => setRedeemTo(opt)}
                        style={{ padding: '14px 0', borderRadius: 10, fontSize: 14, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', transition: 'all .2s ease',
                          ...(redeemTo === opt ? { color: C.ink, background: 'linear-gradient(180deg, rgba(58,161,255,0.20), rgba(30,123,255,0.10))', border: '1px solid rgba(120,180,255,0.35)', boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset' } : { color: C.inkDim, border: '1px solid transparent', background: 'transparent' }) }}>
                        {opt.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  <div style={{ marginTop: 28 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
                      <label style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Amount to redeem</label>
                      <span style={{ ...MONO, fontSize: 34, fontWeight: 400, color: C.ink }}>
                        {redeemPct}<em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, color: C.brand, fontSize: 32, marginLeft: 2 }}>%</em>
                      </span>
                    </div>
                    <input type="range" className="suix-range" min={1} max={100} step={1} value={redeemPct}
                      style={{ '--p': `${redeemPct}%` } as React.CSSProperties}
                      onChange={e => setRedeemPct(Number(e.target.value))} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', ...MONO, fontSize: 10.5, color: C.inkMute, marginTop: 10 }}>
                      <span>1</span><span>25</span><span>50</span><span>75</span><span>100</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
                      {[25, 50, 75, 100].map(p => (
                        <button key={p} onClick={() => setRedeemPct(p)}
                          style={{ flex: 1, padding: '10px 0', borderRadius: 10, ...MONO, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .2s ease',
                            ...(redeemPct === p ? { color: C.brandSoft, border: '1px solid rgba(120,180,255,0.40)', background: 'rgba(58,161,255,0.08)' } : { color: C.inkDim, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)' }) }}>
                          {p}%
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div style={{ borderRadius: 18, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55), rgba(10,15,28,0.55))', padding: '24px 26px' }}>
                  <div style={{ ...MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 18 }}>Estimated execution</div>
                  {[
                    { label: 'Portfolio value', val: fmtUsd(walletStatus.total_usd) },
                    { label: 'Redeeming', val: fmtUsd(redeemGross) },
                    { label: '0.50% execution fee', val: `−${fmtUsd(redeemFee)}`, muted: true },
                  ].map((r, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '10px 0', borderBottom: `1px solid ${C.line}`, fontSize: r.muted ? 12.5 : 14, color: r.muted ? C.inkMute : C.inkDim }}>
                      <span>{r.label}</span>
                      <span style={{ ...MONO, color: C.ink }}>{r.val}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 18, marginTop: 6, borderTop: `1px solid ${C.line}` }}>
                    <span style={{ fontSize: 13, color: C.inkDim }}>Est. {redeemTo.toUpperCase()} received</span>
                    <span style={{ ...MONO, fontSize: 24, color: '#cfe2ff' }}>
                      ~{redeemTo === 'sui' ? `${(redeemNet / 3.84).toFixed(4)} SUI` : fmtUsd(redeemNet)}
                    </span>
                  </div>

                  <button onClick={handleRedeem} disabled={actionLoading || !connected}
                    style={{ ...BTN_PRIMARY, width: '100%', justifyContent: 'center', marginTop: 22, padding: '16px', fontSize: 15, opacity: (!connected || actionLoading) ? 0.4 : 1, cursor: (!connected || actionLoading) ? 'not-allowed' : 'pointer' }}>
                    Redeem {redeemPct}% to {redeemTo.toUpperCase()} <ArrowRight />
                  </button>

                  <div style={{ ...MONO, marginTop: 18, fontSize: 10.5, color: C.inkMute, letterSpacing: '0.06em', textAlign: 'center' }}>
                    REMAINING {100 - redeemPct}% STAYS IN BASKET · YOU SIGN · NEVER MOVE FUNDS WITHOUT YOUR SIGNATURE
                  </div>
                </div>
              </div>
            </div>
          )}

          </div>{/* /card-column 1080 */}

        </div>
      </section>

      {/* ── Tabs ── */}
      <section style={{ position: 'relative', zIndex: 1 }}>
        <div style={WRAP}>

          {/* section divider */}
          <div className="section-divider" style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 60, marginBottom: 40 }}>
            <div style={{ flex: 1, height: 1, background: C.line }} />
            <span style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', padding: '6px 14px', border: `1px solid ${C.line}`, borderRadius: 999, background: 'rgba(255,255,255,0.02)' }}>
              ADDITIONAL FEATURES
            </span>
            <div style={{ flex: 1, height: 1, background: C.line }} />
          </div>

          {/* tab bar */}
          <div className="tab-bar" style={{ display: 'flex', gap: 4, border: `1px solid ${C.lineStrong}`, background: 'rgba(20,28,46,0.45)', borderRadius: 14, padding: 5, width: 'fit-content', backdropFilter: 'blur(20px)', flexWrap: 'wrap', marginTop: 40, marginLeft: 'auto', marginRight: 'auto', overflowX: 'auto' as 'auto', WebkitOverflowScrolling: 'touch' }}>
            {([['telegram', 'Telegram Alerts'], ['auto', 'Automation']] as [ActiveTab, string][]).map(([key, label]) => (
              <button key={key} onClick={() => setActiveTab(key)}
                style={{ padding: '10px 22px', borderRadius: 10, fontSize: 14, fontWeight: 500, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: 'inherit', transition: 'all .2s ease', whiteSpace: 'nowrap',
                  ...(activeTab === key
                    ? { color: C.ink, background: 'linear-gradient(180deg, rgba(58,161,255,0.18), rgba(30,123,255,0.10))', boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset, 0 6px 18px -8px rgba(30,123,255,0.45)', border: '1px solid rgba(120,180,255,0.30)' }
                    : { color: C.inkDim, border: '1px solid transparent', background: 'transparent' }) }}>
                {label}
              </button>
            ))}
          </div>

          {/* ═══════ TAB: TELEGRAM ═══════ */}
          {activeTab === 'telegram' && (
            <div style={PANEL}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(255,255,255,0.04), transparent 30%)' }} />
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, marginBottom: 24, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ ...MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 8 }}>Telegram alerts</div>
                  <h4 style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em', margin: 0 }}>Get drift alerts on <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, color: C.brand }}>Telegram</em></h4>
                </div>
                <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.06em', textAlign: 'right' }}>
                  CONTRACT · <span style={{ color: C.inkDim }}>0xc09469…60ee5</span><br />
                  CONFIG · <span style={{ color: C.inkDim }}>0xecb7d2…0ddc</span>
                </div>
              </div>

              {/* ── ACTIVE state — credential sensed ── */}
              {tgPolicyId ? (
                <div style={{ borderRadius: 18, border: tgPolicyActive ? '1px solid rgba(74,222,140,0.30)' : '1px solid rgba(245,193,75,0.30)', background: tgPolicyActive ? 'linear-gradient(180deg, rgba(74,222,140,0.07), rgba(10,15,28,0.55))' : 'linear-gradient(180deg, rgba(245,193,75,0.07), rgba(10,15,28,0.55))', padding: '28px 26px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: tgPolicyActive ? C.pos : C.warn, boxShadow: `0 0 12px ${tgPolicyActive ? C.pos : C.warn}`, flexShrink: 0, display: 'inline-block', ...(tgPolicyActive ? { animation: 'pulseDotGreen 2s infinite' } : {}) }} />
                    <span style={{ fontSize: 16, fontWeight: 500, color: tgPolicyActive ? '#a8f0c4' : '#ffd884' }}>{tgPolicyActive ? 'Telegram notifications active' : 'Telegram notifications paused'}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                    {[
                      { label: 'POLICY',     val: `${tgPolicyId.slice(0, 10)}…${tgPolicyId.slice(-6)}` },
                      { label: 'CREDENTIAL', val: `${tgCredentialId.slice(0, 10)}…${tgCredentialId.slice(-6)}` },
                    ].map(({ label, val }) => (
                      <div key={label} style={{ borderRadius: 12, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', padding: '12px 14px' }}>
                        <div style={{ ...MONO, fontSize: 10, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
                        <div style={{ ...MONO, fontSize: 13, color: '#cfe2ff' }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                    <p style={{ margin: 0, fontSize: 13, color: C.inkDim, maxWidth: '44ch', lineHeight: 1.5 }}>
                      {tgPolicyActive
                        ? 'Your chat ID is Seal-encrypted on-chain. SuiX DMs you when your index drifts.'
                        : 'Notifications are paused — no drift alerts will be sent until you resume. Your credential remains in your wallet.'
                      }
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {tgPolicyActive
                        ? <button onClick={handlePauseNotification} style={{ ...BTN_GHOST, fontSize: 13, padding: '10px 16px' }}>Pause</button>
                        : <button onClick={handleResumeNotification} style={{ ...BTN_PRIMARY, fontSize: 13, padding: '10px 16px' }}>Resume</button>
                      }
                      <button onClick={handleDeactivateNotification} style={{ ...BTN_DANGER, fontSize: 13, padding: '10px 16px' }}>
                        Deactivate &amp; Delete
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* ── IDLE state — no credential, show CTA ── */
                <>
                  <div style={{ marginTop: 24, borderRadius: 18, border: '1px solid rgba(120,180,255,0.25)', background: 'linear-gradient(180deg, rgba(58,161,255,0.08), rgba(10,15,28,0.55))', padding: '24px 26px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                    <div>
                      <h5 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 500, color: C.ink }}>Set up Telegram notifications</h5>
                      <p style={{ margin: 0, fontSize: 13, color: C.inkDim, maxWidth: '42ch', lineHeight: 1.5 }}>
                        Link your Telegram in a guided flow — Seal-encrypts your chat ID in-browser, stores it on-chain in your wallet, and our bot DMs you when your index drifts. You stay in control and can revoke any time.
                      </p>
                    </div>
                    <Link href='/utility/notifications' style={{ ...BTN_PRIMARY, textDecoration: 'none' }}>
                      Set Up Telegram Alerts <ArrowRight />
                    </Link>
                  </div>
                  <p style={{ ...MONO, marginTop: 18, color: C.inkMute, fontSize: 11, letterSpacing: '0.06em', textAlign: 'center' }}>
                    REVERSIBLE · DEACTIVATE &amp; DELETE ON-CHAIN ANY TIME · FREE — ONLY GAS TO REGISTER
                  </p>
                </>
              )}
            </div>
          )}

          {/* ═══════ TAB: AUTO ═══════ */}
          {activeTab === 'auto' && (
            <div style={PANEL}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(255,255,255,0.04), transparent 30%)' }} />
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, marginBottom: 24, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ ...MONO, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.inkMute, marginBottom: 8 }}>Auto-rebalance</div>
                  <h4 style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em', margin: 0 }}>Activate your <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, color: C.brand }}>Policy</em></h4>
                </div>
                <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.06em', textAlign: 'right' }}>
                  CONTRACT · <span style={{ color: C.inkDim }}>0x65436b…73e5e</span><br />
                  CONFIG · <span style={{ color: C.inkDim }}>0x8efeea…8121</span>
                </div>
              </div>

              {/* ── ACTIVE / DONE state ── */}
              {activationPhase === 'done' && policyId ? (
                <div style={{ borderRadius: 18, border: policyActive ? '1px solid rgba(74,222,140,0.30)' : '1px solid rgba(245,193,75,0.30)', background: policyActive ? 'linear-gradient(180deg, rgba(74,222,140,0.07), rgba(10,15,28,0.55))' : 'linear-gradient(180deg, rgba(245,193,75,0.07), rgba(10,15,28,0.55))', padding: '28px 26px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: policyActive ? C.pos : C.warn, boxShadow: `0 0 12px ${policyActive ? C.pos : C.warn}`, flexShrink: 0, display: 'inline-block', ...(policyActive ? { animation: 'pulseDotGreen 2s infinite' } : {}) }} />
                    <span style={{ fontSize: 16, fontWeight: 500, color: policyActive ? '#a8f0c4' : '#ffd884' }}>{policyActive ? 'Automation active' : 'Automation paused'}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                    {[
                      { label: 'POLICY', val: `${policyId.slice(0, 10)}…${policyId.slice(-6)}` },
                      { label: 'CREDENTIAL', val: `${credentialId.slice(0, 10)}…${credentialId.slice(-6)}` },
                      { label: 'DRIFT TRIGGER', val: `${driftPct.toFixed(1)}%` },
                      { label: 'FREQUENCY', val: fmtFreq(freqSecs) },
                    ].map(({ label, val }) => (
                      <div key={label} style={{ borderRadius: 12, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', padding: '12px 14px' }}>
                        <div style={{ ...MONO, fontSize: 10, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
                        <div style={{ ...MONO, fontSize: 13, color: '#cfe2ff' }}>{val}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                    <p style={{ margin: 0, fontSize: 13, color: C.inkDim, maxWidth: '44ch', lineHeight: 1.5 }}>
                      {policyActive
                        ? <>Your <code style={{ ...MONO, fontSize: 11.5, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', color: '#cfe2ff' }}>AutomationCredential</code> lives in your wallet. SuiX will rebalance when drift exceeds your threshold. Revoke any time.</>
                        : <>Automation is paused — the bot will not rebalance until you resume. Your <code style={{ ...MONO, fontSize: 11.5, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', color: '#cfe2ff' }}>AutomationCredential</code> remains in your wallet.</>
                      }
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {policyActive
                        ? <button onClick={handlePause} style={{ ...BTN_GHOST, fontSize: 13, padding: '10px 16px' }}>Pause</button>
                        : <button onClick={handleResume} style={{ ...BTN_PRIMARY, fontSize: 13, padding: '10px 16px' }}>Resume</button>
                      }
                      <button onClick={handleDeactivate} style={{ ...BTN_DANGER, fontSize: 13, padding: '10px 16px' }}>
                        Deactivate &amp; Delete
                      </button>
                    </div>
                  </div>
                </div>

              ) : activationPhase !== 'idle' && activationPhase !== 'error' ? (
                /* ── IN-PROGRESS state ── */
                <div style={{ borderRadius: 18, border: `1px solid ${C.lineStrong}`, background: 'rgba(20,28,46,0.55)', padding: '32px 26px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    {[
                      { phase: 'encrypting',   label: 'Generating key & encrypting via Seal',           sub: 'In-browser — key never leaves your device' },
                      { phase: 'step1',        label: 'Step 1/1 · Activating policy with encrypted blob', sub: 'Sign the transaction in your wallet' },
                      { phase: 'querying',     label: 'Fetching Policy ID from chain',                   sub: 'Reading PolicyActivated event…' },
                      { phase: 'deactivating', label: 'Deactivating policy',                             sub: 'Sign the transaction in your wallet' },
                    ].map(({ phase, label, sub }) => {
                      const phases: ActivationPhase[] = ['encrypting', 'step1', 'querying'];
                      const currentIdx = phases.indexOf(activationPhase as ActivationPhase);
                      const stepIdx    = phases.indexOf(phase as ActivationPhase);
                      const isActive   = activationPhase === phase || (phase === 'deactivating' && activationPhase === 'deactivating');
                      const isDone     = stepIdx >= 0 && stepIdx < currentIdx;
                      if (phase === 'deactivating' && activationPhase !== 'deactivating') return null;
                      if (phase !== 'deactivating' && activationPhase === 'deactivating') return null;
                      return (
                        <div key={phase} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', opacity: isActive ? 1 : isDone ? 0.7 : 0.3 }}>
                          <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: `1px solid ${isActive ? C.brand : isDone ? C.pos : C.lineStrong}`, background: isDone ? 'rgba(74,222,140,0.10)' : isActive ? 'rgba(58,161,255,0.10)' : 'rgba(255,255,255,0.02)' }}>
                            {isDone
                              ? <CheckSVG />
                              : isActive
                                ? <span style={{ width: 10, height: 10, borderRadius: '50%', background: C.brand, display: 'block', animation: 'pulseDot 1.4s infinite' }} />
                                : <span style={{ ...MONO, fontSize: 11, color: C.inkMute }}>{String(stepIdx + 1)}</span>
                            }
                          </div>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 500, color: isActive ? C.ink : C.inkDim }}>{label}</div>
                            {isActive && <div style={{ fontSize: 12, color: C.inkMute, marginTop: 4 }}>{sub}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

              ) : (
                /* ── IDLE / CONFIG state ── */
                <>
                  {activationPhase === 'error' && (
                    <div style={{ marginBottom: 20, borderRadius: 12, padding: '12px 16px', border: '1px solid rgba(255,107,138,0.25)', background: 'rgba(255,107,138,0.07)', fontSize: 13, color: '#ffa3b6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                      <span>{activationError || 'Activation failed'}</span>
                      <button onClick={() => setActivationPhase('idle')} style={{ ...BTN_GHOST, padding: '4px 10px', fontSize: 11 }}>retry</button>
                    </div>
                  )}
                  <div style={{ marginTop: 24, borderRadius: 18, border: '1px solid rgba(120,180,255,0.25)', background: 'linear-gradient(180deg, rgba(58,161,255,0.08), rgba(10,15,28,0.55))', padding: '24px 26px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                    <div>
                      <h5 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 500, color: C.ink }}>Activate auto-rebalance</h5>
                      <p style={{ margin: 0, fontSize: 13, color: C.inkDim, maxWidth: '48ch', lineHeight: 1.5 }}>
                        Creates a fresh wallet right in your browser and shows you its private key once — you own it, and SuiX never stores it. That key is Seal-encrypted in-browser and stored on-chain as an <code style={{ ...MONO, fontSize: 11.5, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', color: '#cfe2ff' }}>AutomationCredential</code> inside the new wallet, so SuiX can rebalance for you. SuiX sponsors the gas, and you can import the key into Slush or any Sui wallet at any time.
                      </p>
                    </div>
                    <Link href='/utility/create' style={{ ...BTN_PRIMARY, textDecoration: 'none' }}>
                      Create Automated Wallet <ArrowRight />
                    </Link>
                  </div>
                  <p style={{ ...MONO, marginTop: 18, color: C.inkMute, fontSize: 11, letterSpacing: '0.06em', textAlign: 'center' }}>
                    REVERSIBLE · DEACTIVATE &amp; DELETE ON-CHAIN ANY TIME · ACTIVATION FREE (GAS SPONSORED)<br />
                    AUTOMATED REBALANCES: 0.50% EXECUTION FEE ON TRADED AMOUNT · GAS FROM WALLET SUI BALANCE
                  </p>
                </>
              )}
            </div>
          )}


        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ marginTop: 60, borderTop: '1px solid rgba(148,170,210,0.12)', padding: '88px 0 36px', position: 'relative', zIndex: 1 }}>
        <div style={WRAP}>
          <div className="foot-grid" style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr', gap: 48 }}>
            <div>
              <img src={LOGO_URL} alt="SuiX" style={{ height: 44, width: 'auto' }} />
              <p style={{ fontSize: 14, color: '#9aa6bd', lineHeight: 1.55, margin: '18px 0 0', maxWidth: '32ch' }}>
                Index fund-style exposure to Sui — custodial vaults for new users, non-custodial portfolio management for advanced users.
              </p>
            </div>
            <div>
              <FootCol label="Product" links={[['Vaults', '/vaults'], ['Utility', '/utility']]} />
            </div>
            <div>
              <FootCol label="Resources" links={[['Learn More', '/learn']]} />
            </div>
          </div>
          <div style={{ marginTop: 56, paddingTop: 24, borderTop: '1px solid rgba(148,170,210,0.12)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#5f6a82', fontFamily: "'Geist Mono', ui-monospace, monospace", gap: 16, flexWrap: 'wrap' }}>
            <div>© 2026 SuiX · sui-x.com</div>
            <div>beta software · not financial advice · use at your own risk</div>
          </div>
        </div>
      </footer>

      <style>{`
        .section-divider, .tab-bar { max-width: 100%; box-sizing: border-box; }

        @keyframes pcPulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }

        @media (max-width: 980px) {
          .hamburger-btn { display: flex !important; }
          .network-pill { display: none !important; }
          .navlinks { display: none !important; }
          .nav-logo { height: 136px !important; }
          .nav-row { height: 152px !important; }
        }

        @media (max-width: 900px) {
          .redeem-grid { grid-template-columns: 1fr !important; }
          .onboarding-grid { grid-template-columns: 1fr !important; }
          .onboarding-grid > div { border-left: none !important; border-top: 1px solid rgba(148,170,210,0.12) !important; }
          .onboarding-grid > div:first-child { border-top: none !important; }
        }

        @media (max-width: 700px) {
          .pc-desktop-grid { display: none !important; }
          .pc-mobile-list { display: flex !important; }
          .pc-footer { flex-direction: column !important; align-items: stretch !important; }
          .pc-footer > button { width: 100% !important; justify-content: center !important; }
          .basket-header-row { display: none !important; }
          .basket-row { grid-template-columns: 28px 36px 1fr 110px 90px !important; }
          .basket-col-extra { display: none !important; }
        }

        @media (max-width: 640px) {
          .basket-row { display: block !important; padding: 14px 0; }
          .basket-row > *:not(.basket-row-mobile-meta) { display: none !important; }
          .basket-row-mobile-meta { display: flex !important; flex-direction: column; gap: 10px; }
        }

        @media (max-width: 560px) {
          .strip-actions { flex-direction: column; width: 100%; }
          .strip-actions > button { flex: 1; justify-content: center; width: 100%; }
          .mode-pill { padding: 8px 12px !important; }
          .basket-btn { padding: 8px 12px !important; }
        }

        @media (max-width: 480px) {
          .pc-footer > button { padding: 16px !important; font-size: 15px !important; }
        }
      `}</style>
    </div>
  );
}

// ── WeightBar: fill bar + target tick for portfolio comparison rows ────────────
function WeightBar({ currentPct, targetPct, barColor, barOpacity = 0.55 }: {
  currentPct: number; targetPct: number; barColor: string; barOpacity?: number;
}) {
  const clampedCurrent = Math.min(Math.max(currentPct, 0), 100);
  const clampedTarget  = Math.min(Math.max(targetPct, 0), 100);
  const isZero = clampedCurrent === 0;
  return (
    <div style={{ position: 'relative', height: 14, borderRadius: 4, background: 'rgba(255,255,255,0.04)' }}>
      {isZero ? (
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, borderRadius: 2, background: C.inkMute, opacity: 0.4 }} />
      ) : (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4,
          width: `${clampedCurrent}%`,
          background: barColor, opacity: barOpacity, transition: 'width 0.3s ease',
        }} />
      )}
      <div style={{
        position: 'absolute', top: -3, bottom: -3, width: 2, background: C.inkMute,
        ...(clampedTarget === 0
          ? { left: 0, transform: 'none' }
          : { left: `${clampedTarget}%`, transform: 'translateX(-50%)' }),
      }} />
    </div>
  );
}

// ── PortfolioComparisonPanel ───────────────────────────────────────────────────
function PortfolioComparisonPanel({
  basketDetail, walletStatus, userAddress, selectedBasket, driftBps,
  actionLoading, onRebalance, suinsName,
}: {
  basketDetail: Basket | null;
  walletStatus: WalletStatus | null;
  userAddress: string | undefined;
  selectedBasket: string;
  driftBps: number;
  actionLoading: boolean;
  onRebalance: () => void;
  suinsName: string | null;
}) {
  const [showAllMobile, setShowAllMobile] = useState(false);

  if (!basketDetail || !walletStatus) {
    const skeletonCount = basketDetail?.weights.length ?? 5;
    return (
      <div style={{ ...PANEL, marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <div style={{ height: 20, width: 240, borderRadius: 4, background: 'rgba(255,255,255,0.06)', animation: 'pcPulse 1.6s ease-in-out infinite' }} />
          </div>
          <div style={{ height: 28, width: 90, borderRadius: 999, background: 'rgba(255,255,255,0.06)', animation: 'pcPulse 1.6s ease-in-out infinite' }} />
        </div>
        {Array.from({ length: skeletonCount }).map((_, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '88px minmax(0, 1fr) 150px 110px', columnGap: 20, alignItems: 'center', padding: '12px 0', borderTop: `1px solid ${C.line}` }}>
            <div style={{ height: 14, width: 40, borderRadius: 3, background: 'rgba(255,255,255,0.06)', animation: 'pcPulse 1.6s ease-in-out infinite' }} />
            <div style={{ height: 14, borderRadius: 4, background: 'rgba(255,255,255,0.06)', animation: 'pcPulse 1.6s ease-in-out infinite' }} />
            <div style={{ height: 14, width: 100, borderRadius: 3, background: 'rgba(255,255,255,0.04)', animation: 'pcPulse 1.6s ease-in-out infinite', marginLeft: 'auto' }} />
            <div style={{ height: 14, width: 60, borderRadius: 3, background: 'rgba(255,255,255,0.04)', animation: 'pcPulse 1.6s ease-in-out infinite', marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    );
  }

  // ── data ────────────────────────────────────────────────────────────────────
  const thresholdPct   = driftBps / 100;
  const totalValue     = walletStatus.total_usd;
  const maxDriftPct    = (walletStatus.max_drift * 100).toFixed(1);

  const suiAmt         = walletStatus.gas_sui ?? (walletStatus.holdings.find(h => h.symbol === 'SUI')?.humanAmt ?? 0);
  const gasOk          = suiAmt >= 0.2;

  const panelStatus: 'balanced' | 'drifting' | 'action' =
    walletStatus.has_stale || suiAmt < 0.1 ? 'action'
    : walletStatus.max_drift * 10000 >= driftBps ? 'drifting'
    : 'balanced';

  const panelBorder =
    panelStatus === 'balanced' ? '2px solid rgba(74,222,140,0.45)'
    : panelStatus === 'drifting' ? '2px solid rgba(245,193,75,0.50)'
    : '2px solid rgba(255,107,138,0.55)';

  const panelBoxShadow =
    panelStatus === 'balanced' ? '0 0 24px rgba(74,222,140,0.12)'
    : panelStatus === 'drifting' ? '0 0 24px rgba(245,193,75,0.14)'
    : '0 0 28px rgba(255,107,138,0.18)';

  const badgeStyle = panelStatus === 'balanced'
    ? { border: '1px solid rgba(74,222,140,0.45)', background: 'rgba(74,222,140,0.10)', color: C.pos,  text: 'Balanced' }
    : panelStatus === 'drifting'
    ? { border: '1px solid rgba(245,193,75,0.50)', background: 'rgba(245,193,75,0.08)', color: C.warn, text: `Drifting · ${maxDriftPct}% max` }
    : { border: '1px solid rgba(255,107,138,0.55)', background: 'rgba(255,107,138,0.08)', color: C.neg,  text: 'Action required' };

  const driftMap      = new Map(walletStatus.drift.map(d => [d.symbol, d]));
  const basketSymbols = new Set(basketDetail.weights.map(t => t.symbol));
  const staleSymbols  = new Set((walletStatus.stale_tokens || []).map(s => s.symbol));

  // format trade amount: never show "$0" for an active trade
  const fmtTradeUsd = (verb: string, usd: number): string => {
    if (usd < 0.01) return `${verb} <$0.01`;
    const decimals = usd >= 1 && totalValue >= 100 ? 0 : 2;
    return `${verb} $${usd.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  };

  // basket rows
  const rows = basketDetail.weights.map(t => {
    const d          = driftMap.get(t.symbol);
    const currentPct = (d?.current_weight ?? 0) * 100;
    const targetPct  = t.target_weight * 100;
    const driftAmt   = currentPct - targetPct;
    const absDrift   = Math.abs(driftAmt);
    const tradeUsd   = (absDrift / 100) * totalValue;
    let action: 'buy' | 'sell' | 'ok' = 'ok';
    let barColor = C.pos;
    if (absDrift > thresholdPct) {
      if (driftAmt > 0) { action = 'sell'; barColor = C.neg; }
      else              { action = 'buy';  barColor = C.brand; }
    }
    return { symbol: t.symbol, currentPct, targetPct, tradeUsd, action, barColor };
  });

  // stale token rows (sold out of basket definition but still held)
  const staleRows = (walletStatus.stale_tokens || []).map(st => {
    const holding    = walletStatus.holdings.find(h => h.symbol === st.symbol);
    const currentPct = holding ? (holding.usdValue / totalValue) * 100 : 0;
    const tradeUsd   = holding?.usdValue ?? 0;
    return { symbol: st.symbol, currentPct, tradeUsd };
  });

  const extraTokens    = walletStatus.holdings.filter(
    h => h.symbol !== 'USDC' && !basketSymbols.has(h.symbol) && !staleSymbols.has(h.symbol)
  );
  const uninvestedUsdc = walletStatus.uninvested?.usdc ?? 0;
  const tradesNeeded   = rows.filter(r => r.action !== 'ok').length + staleRows.length;
  const isBalanced     = panelStatus === 'balanced';

  const mobileActiveRows = basketDetail.weights.length > 6 && !showAllMobile
    ? rows.filter(r => r.action !== 'ok')
    : rows;

  const GRID_COLS = '88px minmax(0, 1fr) 150px 110px';

  return (
    <div style={{ ...PANEL, marginTop: 24, border: panelBorder, boxShadow: panelBoxShadow }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(255,255,255,0.03), transparent 30%)' }} />

      {/* Header */}
      <div className="pc-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-0.02em', margin: 0, lineHeight: 1.3 }}>
          Your portfolio vs{' '}
          <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, color: C.brand }}>
            {BASKET_DISPLAY_NAMES[selectedBasket] || selectedBasket.toUpperCase()}
          </em>
          {' '}
          <span style={{ ...MONO, fontSize: 14, fontWeight: 400, color: C.inkDim }}>
            · {fmtUsd(totalValue)}
          </span>
        </h3>
        <span style={{ display: 'inline-flex', alignItems: 'center', padding: '5px 12px', borderRadius: 999, ...badgeStyle, ...MONO, fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap' }}>
          {badgeStyle.text}
        </span>
      </div>

      {/* Desktop: 4-col grid */}
      <div className="pc-desktop-grid" style={{ marginTop: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: GRID_COLS, columnGap: 20, padding: '0 0 8px', ...MONO, fontSize: 10, color: C.inkMute, letterSpacing: '0.10em', textTransform: 'uppercase' }}>
          <div>Token</div><div>Allocation</div>
          <div style={{ textAlign: 'right' }}>Cur / Target</div>
          <div style={{ textAlign: 'right' }}>Trade</div>
        </div>
        {rows.map(row => (
          <div key={row.symbol} style={{ display: 'grid', gridTemplateColumns: GRID_COLS, columnGap: 20, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${C.line}` }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: C.ink }}>{row.symbol}</div>
            <WeightBar currentPct={row.currentPct} targetPct={row.targetPct} barColor={row.barColor} />
            <div style={{ ...MONO, fontSize: 12, color: C.inkDim, textAlign: 'right' }}>
              {row.currentPct.toFixed(1)}% / {row.targetPct.toFixed(1)}%
            </div>
            <div style={{ ...MONO, fontSize: 12, textAlign: 'right', color: row.action === 'sell' ? C.neg : row.action === 'buy' ? C.pos : C.inkMute }}>
              {row.action === 'ok' ? '—' : fmtTradeUsd(row.action, row.tradeUsd)}
            </div>
          </div>
        ))}
        {staleRows.map(row => (
          <div key={`stale-${row.symbol}`} style={{ display: 'grid', gridTemplateColumns: GRID_COLS, columnGap: 20, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${C.line}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: C.neg }}>{row.symbol}</span>
              <span style={{ ...MONO, fontSize: 10, padding: '2px 6px', borderRadius: 6, background: 'rgba(255,107,138,0.08)', border: '1px solid rgba(255,107,138,0.25)', color: C.neg }}>stale</span>
            </div>
            <WeightBar currentPct={row.currentPct} targetPct={0} barColor={C.neg} barOpacity={0.45} />
            <div style={{ ...MONO, fontSize: 12, color: C.inkDim, textAlign: 'right' }}>
              {row.currentPct.toFixed(1)}% / 0%
            </div>
            <div style={{ ...MONO, fontSize: 12, textAlign: 'right', color: C.neg }}>
              {fmtTradeUsd('sell', row.tradeUsd)}
            </div>
          </div>
        ))}
      </div>

      {/* Mobile: stacked blocks */}
      <div className="pc-mobile-list" style={{ display: 'none', flexDirection: 'column', gap: 14, marginTop: 16 }}>
        {mobileActiveRows.map(row => (
          <div key={row.symbol}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: C.ink }}>{row.symbol}</span>
              <span style={{ ...MONO, fontSize: 12, color: row.action === 'sell' ? C.neg : row.action === 'buy' ? C.pos : C.inkMute }}>
                {row.action === 'ok' ? '—' : fmtTradeUsd(row.action, row.tradeUsd)}
              </span>
            </div>
            <WeightBar currentPct={row.currentPct} targetPct={row.targetPct} barColor={row.barColor} />
            <div style={{ ...MONO, fontSize: 11, color: C.inkMute, marginTop: 4 }}>
              {row.currentPct.toFixed(1)}% → {row.targetPct.toFixed(1)}% target
            </div>
          </div>
        ))}
        {staleRows.map(row => (
          <div key={`stale-${row.symbol}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: C.neg }}>{row.symbol}</span>
                <span style={{ ...MONO, fontSize: 10, padding: '2px 6px', borderRadius: 6, background: 'rgba(255,107,138,0.08)', border: '1px solid rgba(255,107,138,0.25)', color: C.neg }}>stale</span>
              </div>
              <span style={{ ...MONO, fontSize: 12, color: C.neg }}>{fmtTradeUsd('sell', row.tradeUsd)}</span>
            </div>
            <WeightBar currentPct={row.currentPct} targetPct={0} barColor={C.neg} barOpacity={0.45} />
            <div style={{ ...MONO, fontSize: 11, color: C.inkMute, marginTop: 4 }}>
              {row.currentPct.toFixed(1)}% → 0% target
            </div>
          </div>
        ))}
        {basketDetail.weights.length > 6 && (
          <button onClick={() => setShowAllMobile(v => !v)}
            style={{ ...BTN_GHOST, fontSize: 12, padding: '8px 16px', alignSelf: 'center', background: 'transparent' }}>
            {showAllMobile ? 'Show fewer' : `Show all ${basketDetail.weights.length} tokens`}
          </button>
        )}
      </div>

      {/* Pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        {uninvestedUsdc > 1 && (
          <span style={{ ...MONO, fontSize: 12, padding: '5px 12px', borderRadius: 999, background: 'rgba(58,161,255,0.08)', border: '1px solid rgba(58,161,255,0.25)', color: C.brand }}>
            ${Math.round(uninvestedUsdc).toLocaleString()} USDC uninvested
          </span>
        )}
        {extraTokens.length > 0 && (
          <span style={{ ...MONO, fontSize: 12, padding: '5px 12px', borderRadius: 999, background: 'transparent', border: `1px solid ${C.line}`, color: C.inkMute }}>
            {extraTokens.length} token{extraTokens.length > 1 ? 's' : ''} not in basket · ignored
          </span>
        )}
        <span style={{ ...MONO, fontSize: 12, padding: '5px 12px', borderRadius: 999, border: gasOk ? `1px solid ${C.line}` : '1px solid rgba(245,193,75,0.30)', background: gasOk ? 'transparent' : 'rgba(245,193,75,0.07)', color: gasOk ? C.inkMute : C.warn }}>
          gas {gasOk ? 'ok' : 'low'} · {suiAmt.toFixed(2)} SUI
        </span>
      </div>

      {/* Footer */}
      <div className="pc-footer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${C.line}`, paddingTop: 16, marginTop: 18, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: C.inkDim }}>
          {tradesNeeded === 0 ? 'No trades needed' : `${tradesNeeded} trade${tradesNeeded > 1 ? 's' : ''} needed to match target`}
        </div>
        <button onClick={onRebalance} disabled={actionLoading || isBalanced}
          style={{ ...BTN_PRIMARY, opacity: (actionLoading || isBalanced) ? 0.4 : 1, cursor: (actionLoading || isBalanced) ? 'not-allowed' : 'pointer' }}>
          {actionLoading ? 'Building…' : 'Rebalance'} <ArrowRight />
        </button>
      </div>
      {tradesNeeded > 0 && (
        <p style={{ ...MONO, margin: '10px 0 0', fontSize: 11, color: C.inkMute, letterSpacing: '0.06em', textAlign: 'center' }}>
          0.50% EXECUTION FEE ON THE TRADED AMOUNT · GAS FROM WALLET SUI BALANCE
        </p>
      )}
    </div>
  );
}

// ── Footer helper ──────────────────────────────────────────────────────────
interface FootColProps { label: string; links: [string, string][]; external?: boolean; }
function FootCol({ label, links, external }: FootColProps) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.12em', color: '#5f6a82', margin: '0 0 14px', fontWeight: 500, fontFamily: "'Geist Mono', ui-monospace, monospace" }}>{label}</div>
      {links.map(([text, href]) =>
        external ? (
          <a key={href} href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'block', fontSize: 14, color: '#9aa6bd', padding: '5px 0', textDecoration: 'none' }}>{text}</a>
        ) : (
          <Link key={href} href={href} style={{ display: 'block', fontSize: 14, color: '#9aa6bd', padding: '5px 0', textDecoration: 'none' }}>{text}</Link>
        )
      )}
    </div>
  );
}

// ── TokenIcon helper ──────────────────────────────────────────────────────────
function TokenIcon({ iconUrl, symbol }: { iconUrl?: string; symbol: string }) {
  const [imgErr, setImgErr] = useState(false);
  const src = ICON_OVERRIDES[symbol] || iconUrl;
  if (src && !imgErr) {
    return (
      <img
        src={src}
        alt={symbol}
        onError={() => setImgErr(true)}
        style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: `1px solid ${C.lineStrong}`, background: 'rgba(255,255,255,0.04)' }}
      />
    );
  }
  return (
    <span style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', ...MONO, fontSize: 10, fontWeight: 500, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(135deg, rgba(58,161,255,0.18), rgba(30,123,255,0.04))', color: '#cfe2ff', flexShrink: 0 }}>
      {symbol.slice(0, 3)}
    </span>
  );
}
