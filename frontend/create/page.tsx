'use client';

import { useState, useEffect, useCallback } from 'react';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey, encodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SealClient } from '@mysten/seal';
import Link from 'next/link';
import React from 'react';

const API_URL  = '/utility-api';
const LOGO_URL = 'https://indigo-elaborate-bovid-600.mypinata.cloud/ipfs/bafybeihr2x6573m4bccxqed7ykvz3attt257ao6di474qxoaeyho4bkzya';

// ── Contract constants ─────────────────────────────────────────────────────────
const PACKAGE_ID = '0x65436b396702ba21d3c5cc0849aa0d83e7bff7d4fc90d22088d64f74aef73e5e';
const CONFIG_ID  = '0x8efeeae6c6fa67146aa1de69ba7e3f1fa37cd19249890247f06d63ee949c8121';
const MAINNET_KEY_SERVERS = [{
    objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10',
    url:      'https://open.key-server.mainnet.seal.mirai.cloud',
    weight:   1,
}];

// ── Palette — matches existing utility page exactly ────────────────────────────
const C = {
    bg0: '#05070d', ink: '#e8edf7', inkDim: '#9aa6bd', inkMute: '#5f6a82',
    line: 'rgba(148,170,210,0.12)', lineStrong: 'rgba(148,170,210,0.20)',
    brand: '#3aa1ff', brandSoft: '#7ad0ff',
    pos: '#4ade8c', warn: '#f5c14b', neg: '#ff6b8a',
};

const WRAP: React.CSSProperties  = { maxWidth: 860, margin: '0 auto', padding: '0 clamp(16px, 4vw, 48px)', position: 'relative', zIndex: 1 };
const MONO: React.CSSProperties  = { fontFamily: "'Geist Mono', ui-monospace, monospace", letterSpacing: 0 };
const BTN_PRIMARY: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '14px 22px', borderRadius: 12, fontSize: 14, fontWeight: 500,
    border: '1px solid rgba(120,180,255,0.45)',
    background: 'linear-gradient(180deg, #2a8bff 0%, #1561d6 100%)',
    color: '#fff', cursor: 'pointer', letterSpacing: '-0.005em',
    boxShadow: '0 1px 0 rgba(255,255,255,0.18) inset, 0 10px 28px rgba(20,90,220,0.40)',
    fontFamily: 'inherit',
};
const BTN_GHOST: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '14px 22px', borderRadius: 12, fontSize: 14, fontWeight: 500,
    border: `1px solid ${C.lineStrong}`, background: 'transparent',
    color: C.ink, cursor: 'pointer', fontFamily: 'inherit',
};

// ── Types ──────────────────────────────────────────────────────────────────────
type Phase =
    | 'intro'        // landing — explain what's about to happen
    | 'generating'   // generating keypair in browser
    | 'reveal'       // show private key, await acknowledgment
    | 'basket'       // pick basket + configure drift/freq
    | 'encrypting'   // Seal encrypting key
    | 'sponsoring'   // calling backend for sponsor sig
    | 'submitting'   // submitting dual-signed tx to chain
    | 'polling'      // waiting for PolicyActivated event
    | 'done'         // success — show wallet info
    | 'error';       // something went wrong

interface WalletInfo {
    address:      string;
    privateKey:   string;  // only held in memory during reveal phase, cleared after
    policyId:     string;
    credentialId: string;
}

const ArrowRight = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 12h14M13 5l7 7-7 7"/>
    </svg>
);
const CheckSVG = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M5 12l4.5 4.5L20 6"/>
    </svg>
);
const CopySVG = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
);
const EyeSVG = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
    </svg>
);
const EyeOffSVG = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
);

// ── Step indicator ─────────────────────────────────────────────────────────────
const STEPS: { phase: Phase; label: string }[] = [
    { phase: 'reveal',     label: 'Save private key' },
    { phase: 'basket',     label: 'Configure basket' },
    { phase: 'encrypting', label: 'Encrypt & activate' },
    { phase: 'done',       label: 'Wallet ready' },
];

function StepDots({ current }: { current: Phase }) {
    const activeIdx = STEPS.findIndex(s => s.phase === current);
    const inProgress = ['generating', 'encrypting', 'sponsoring', 'submitting', 'polling'].includes(current);

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 48 }}>
            {STEPS.map((step, i) => {
                const isDone    = activeIdx > i || current === 'done';
                const isActive  = activeIdx === i || (inProgress && (step.phase === 'encrypting') && ['encrypting','sponsoring','submitting','polling'].includes(current));
                const isFuture  = activeIdx < i && current !== 'done';
                return (
                    <React.Fragment key={step.phase}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                            <div style={{
                                width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                border: isDone ? '1px solid rgba(74,222,140,0.50)' : isActive ? '1px solid rgba(58,161,255,0.60)' : `1px solid ${C.line}`,
                                background: isDone ? 'rgba(74,222,140,0.10)' : isActive ? 'rgba(58,161,255,0.12)' : 'rgba(255,255,255,0.02)',
                                transition: 'all .35s ease',
                            }}>
                                {isDone
                                    ? <span style={{ color: C.pos }}><CheckSVG /></span>
                                    : isActive
                                        ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.brand, display: 'block', animation: 'pulseDot 1.4s infinite' }} />
                                        : <span style={{ ...MONO, fontSize: 11, color: C.inkMute }}>{i + 1}</span>
                                }
                            </div>
                            <span className="step-label" style={{ ...MONO, fontSize: 10, letterSpacing: '0.08em', color: isDone ? '#a8f0c4' : isActive ? C.brandSoft : C.inkMute, whiteSpace: 'nowrap', textTransform: 'uppercase' }}>
                                {step.label}
                            </span>
                        </div>
                        {i < STEPS.length - 1 && (
                            <div style={{ flex: 1, height: 1, background: isDone ? 'rgba(74,222,140,0.30)' : `${C.line}`, margin: '0 8px', marginBottom: 28, transition: 'background .35s ease' }} />
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
}

const freqLabel = (s: number) => s === 43200 ? '12h' : s === 86400 ? '1d' : s === 604800 ? '7d' : s === 2592000 ? '30d' : `${s / 3600}h`;

// ══════════════════════════════════════════════════════════════════════════════
export default function CreateAutomationWallet() {
    useEffect(() => { document.title = 'SuiX — Create Automated Wallet'; }, []);

    const [phase,          setPhase]          = useState<Phase>('intro');
    const [error,          setError]          = useState('');
    const [keypair,        setKeypair]        = useState<Ed25519Keypair | null>(null);
    const [privateKey,     setPrivateKey]     = useState('');   // cleared after reveal
    const [walletAddress,  setWalletAddress]  = useState('');
    const [acknowledged,   setAcknowledged]   = useState(false);
    const [showKey,        setShowKey]        = useState(false);
    const [copiedField,    setCopiedField]    = useState<'address' | 'key' | null>(null);
    const [policyId,       setPolicyId]       = useState('');
    const [credentialId,   setCredentialId]   = useState('');
    const [selectedBasket, setSelectedBasket] = useState('suix-5');
    const [driftBps,       setDriftBps]       = useState(300);
    const [freqSecs,       setFreqSecs]       = useState(43200);
    const [statusMsg,      setStatusMsg]      = useState('');
    const [baskets,        setBaskets]        = useState<{ basket_key: string; name: string }[]>([]);

    const driftPct = driftBps / 100;
    const freqHrs  = freqSecs / 3600;

    // Load baskets for picker
    useEffect(() => {
        const ORDER = ['suix-5', 'suix-10', 'suix-meme'];
        fetch(`${API_URL}/api/baskets`)
            .then(r => r.json())
            .then(d => setBaskets((d.baskets || [])
                .filter((b: any) => ORDER.includes(b.basket_key))
                .sort((a: any, z: any) => ORDER.indexOf(a.basket_key) - ORDER.indexOf(z.basket_key))
            ))
            .catch(() => {});
    }, []);

    useEffect(() => { if (phase === 'reveal') setShowKey(false); }, [phase]);

    // ── Step 1: Generate keypair ────────────────────────────────────────────────
    function handleGenerate() {
        setPhase('generating');
        setError('');

        // Small timeout so the UI updates before the sync crypto work
        setTimeout(() => {
            try {
                const kp      = Ed25519Keypair.generate();
                const addr    = kp.getPublicKey().toSuiAddress();
                const encKey  = kp.getSecretKey();

                setKeypair(kp);
                setWalletAddress(addr);
                setPrivateKey(encKey);
                setPhase('reveal');
            } catch (e: any) {
                setError(e.message);
                setPhase('error');
            }
        }, 100);
    }

    // ── Step 2: Copy helpers ────────────────────────────────────────────────────
    async function handleCopyKey() {
        try {
            await navigator.clipboard.writeText(privateKey);
            setCopiedField('key');
            setTimeout(() => setCopiedField(null), 2500);
        } catch {}
    }
    async function handleCopyAddress() {
        try {
            await navigator.clipboard.writeText(walletAddress);
            setCopiedField('address');
            setTimeout(() => setCopiedField(null), 2500);
        } catch {}
    }

    // ── Step 3: Proceed to basket config ───────────────────────────────────────
    function handleAcknowledge() {
        if (!acknowledged) return;
        setPhase('basket');
    }

    // ── Step 4: Encrypt + send to backend + sign + submit ──────────────────────
    async function handleActivate() {
        if (!keypair || !walletAddress) return;
        setError('');

        try {
            // ── 4a. Seal encrypt the private key ──────────────────────────────
            setPhase('encrypting');
            setStatusMsg('Encrypting private key via Seal…');

            const encodedKey = keypair.getSecretKey();
            const { secretKey: rawKeyBytes } = decodeSuiPrivateKey(encodedKey);
            const keyBytes = new Uint8Array(32);
            keyBytes.set(rawKeyBytes.slice(0, 32));

            const sealSuiClient = new SuiJsonRpcClient({
                url:     'https://fullnode.mainnet.sui.io',
                network: 'mainnet' as any,
            });
            const sealClient = new SealClient({
                suiClient:        sealSuiClient as any,
                serverConfigs:    MAINNET_KEY_SERVERS,
                verifyKeyServers: false,
            });

            const { encryptedObject } = await sealClient.encrypt({
                threshold: 1,
                packageId: PACKAGE_ID,
                id:        PACKAGE_ID,
                data:      keyBytes,
                demType:   1,
            });

            // Convert to plain array for JSON transport
            const encryptedBlob = Array.from(encryptedObject);

            // ── 4b. Send to backend — backend builds full tx + signs as sponsor ─
            setPhase('sponsoring');
            setStatusMsg('Getting gas sponsorship from SuiX…');

            const sponsorRes = await fetch(`${API_URL}/api/automate/sponsor`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    encrypted_blob:     encryptedBlob,
                    automation_address: walletAddress,
                    drift_bps:          driftBps,
                    freq_secs:          freqSecs,
                    basket_key:         selectedBasket,
                }),
            });

            if (!sponsorRes.ok) {
                const err = await sponsorRes.json();
                throw new Error(err.error || 'Sponsorship failed');
            }

            const { tx_bytes: txBytesBase64, sponsor_sig } = await sponsorRes.json();

            // ── 4c. Frontend signs as sender (automation wallet, still in memory) ─
            setPhase('submitting');
            setStatusMsg('Signing as automation wallet…');

            const txBytes  = new Uint8Array(Buffer.from(txBytesBase64, 'base64'));
            const senderSig = await keypair.signTransaction(txBytes);

            // ── 4d. Wipe private key from memory immediately after signing ─────
            keyBytes.fill(0);
            setPrivateKey('');

            // ── 4e. Submit both signatures directly to Sui RPC ────────────────
            setStatusMsg('Submitting to chain…');

            const submitRes = await fetch('https://fullnode.mainnet.sui.io', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id:      1,
                    method:  'sui_executeTransactionBlock',
                    params: [
                        txBytesBase64,
                        [senderSig.signature, sponsor_sig],
                        { showEvents: true, showEffects: true },
                        'WaitForLocalExecution',
                    ],
                }),
            });

            const submitJson = await submitRes.json();
            if (submitJson.error) throw new Error(submitJson.error.message || 'Transaction failed');

            const digest = submitJson.result?.digest;
            if (!digest) throw new Error('No digest returned from transaction');

            // ── 4f. Poll for PolicyActivated event ────────────────────────────
            setPhase('polling');
            setStatusMsg(`Submitted (${digest.slice(0, 8)}…) — waiting for confirmation…`);

            let pId = '';
            let cId = '';

            for (let attempt = 0; attempt < 20; attempt++) {
                await new Promise(r => setTimeout(r, 1500));
                try {
                    const evRes = await fetch('https://fullnode.mainnet.sui.io', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            id:      1,
                            method:  'sui_getTransactionBlock',
                            params:  [digest, { showEvents: true }],
                        }),
                    });
                    const evJson = await evRes.json();
                    const events = evJson.result?.events || [];
                    const ev     = events.find((e: any) => e.type?.includes('PolicyActivated'));
                    if (ev?.parsedJson) {
                        pId = ev.parsedJson.policy_id;
                        cId = ev.parsedJson.automation_credential_id;
                        break;
                    }
                } catch { /* retry */ }
            }

            if (!pId || !cId) {
                throw new Error(`PolicyActivated event not found — check Suivision: ${digest}`);
            }

            setPolicyId(pId);
            setCredentialId(cId);
            setPhase('done');

        } catch (e: any) {
            setError(e?.message ?? String(e));
            setPhase('error');
        }
    }

    // ── Render ─────────────────────────────────────────────────────────────────
    const showSteps = !['intro', 'error'].includes(phase);

    return (
        <div style={{ minHeight: '100vh', background: C.bg0, color: C.ink, fontFamily: "'Geist', ui-sans-serif, system-ui, sans-serif", letterSpacing: '-0.01em', overflowX: 'hidden' }}>

            {/* Background */}
            <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
                background: `
                    radial-gradient(1100px 700px at 80% -10%, rgba(30,123,255,0.18), transparent 60%),
                    radial-gradient(900px 600px at 10% 10%, rgba(58,161,255,0.07), transparent 55%),
                    linear-gradient(180deg,#05070d 0%, #070b14 45%, #05070d 100%)` }} />

            {/* Nav */}
            <nav style={{ position: 'sticky', top: 0, zIndex: 50, backdropFilter: 'blur(18px) saturate(140%)', WebkitBackdropFilter: 'blur(18px) saturate(140%)', background: 'linear-gradient(180deg, rgba(5,7,13,0.72), rgba(5,7,13,0.32))', borderBottom: `1px solid ${C.line}` }}>
                <div style={{ maxWidth: 1280, margin: '0 auto', padding: '0 clamp(16px, 4vw, 48px)' }}>
                    <div className="nav-row" style={{ display: 'flex', alignItems: 'center', gap: 32, height: 96 }}>
                        <Link href="/" aria-label="SuiX">
                            <img src={LOGO_URL} alt="SuiX" className="nav-logo" style={{ height: 136, width: 'auto', filter: 'drop-shadow(0 0 24px rgba(58,161,255,0.45))' }} />
                        </Link>
                        <Link href="/utility" style={{ fontSize: 13, color: C.inkMute, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
                            Back to Utility
                        </Link>
                        <div style={{ flex: 1 }} />
                        <div className="network-pill" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', fontSize: 12, color: C.inkMute, ...MONO }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.pos, boxShadow: `0 0 8px ${C.pos}`, display: 'inline-block' }} />
                            Sui · Mainnet
                        </div>
                    </div>
                </div>
            </nav>

            <section style={{ padding: '64px 0 80px', position: 'relative', zIndex: 1 }}>
                <div style={WRAP}>

                    {/* Page header */}
                    <div style={{ marginBottom: 56 }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderRadius: 999, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.025)', fontSize: 11, color: C.inkMute, ...MONO, letterSpacing: '0.10em', marginBottom: 20 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.pos, display: 'inline-block', animation: 'pulseDotGreen 2.4s infinite' }} />
                            STATE · 03 · AUTOMATED WALLET
                        </div>
                        <h1 style={{ fontSize: 'clamp(36px,5vw,64px)', lineHeight: 0.96, letterSpacing: '-0.04em', fontWeight: 500, margin: '0 0 16px', maxWidth: '18ch' }}>
                            <span style={{ background: 'linear-gradient(180deg,#ffffff 0%,#cfdeef 55%,#7a93b8 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'block' }}>
                                Create your
                            </span>
                            <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, background: 'linear-gradient(120deg,#9fd1ff 0%,#3aa1ff 50%,#1561d6 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'block' }}>
                                automated wallet.
                            </em>
                        </h1>
                        <p style={{ fontSize: 15, lineHeight: 1.6, color: C.inkDim, maxWidth: '52ch', margin: 0 }}>
                            A fresh wallet is generated in your browser. Its private key is Seal-encrypted and stored on-chain — only accessible by the SuiX backend to auto-rebalance on your behalf. SuiX sponsors the gas. You own the credential and can revoke it any time.
                        </p>
                    </div>

                    {/* Step dots */}
                    {showSteps && <StepDots current={phase} />}

                    {/* ── INTRO ── */}
                    {phase === 'intro' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div className="intro-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 36 }}>
                                {[
                                    { icon: '🔑', title: 'Generated in your browser', body: 'The keypair is created client-side. The private key is shown to you once and never transmitted anywhere.' },
                                    { icon: '🔒', title: 'Sealed on-chain', body: 'Your private key is Seal-encrypted and stored as an AutomationCredential object in your new wallet — not on our servers.' },
                                    { icon: '⛽', title: 'SuiX pays the gas', body: 'Our bot sponsors the activation transaction. You pay nothing to get started — just save your private key.' },
                                    { icon: '🔄', title: 'Auto-rebalances for you', body: 'When drift exceeds your threshold, the backend decrypts the key, signs, and executes the rebalance — charging the standard 0.50% execution fee on the traded amount. Keys are wiped immediately after.' },
                                ].map(({ icon, title, body }) => (
                                    <div key={title} style={{ borderRadius: 16, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', padding: '20px 22px' }}>
                                        <div style={{ fontSize: 22, marginBottom: 10 }}>{icon}</div>
                                        <div style={{ fontSize: 14, fontWeight: 500, color: C.ink, marginBottom: 6 }}>{title}</div>
                                        <div style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.55 }}>{body}</div>
                                    </div>
                                ))}
                            </div>

                            <div style={{ borderRadius: 14, border: '1px solid rgba(245,193,75,0.25)', background: 'rgba(245,193,75,0.05)', padding: '16px 20px', marginBottom: 32, fontSize: 13, color: '#ffd884', lineHeight: 1.6 }}>
                                <strong style={{ display: 'block', marginBottom: 4 }}>⚠ Use a dedicated wallet only</strong>
                                This wallet will be treated as your entire index portfolio. Do not store unrelated assets in it. SuiX will act on everything inside it when it rebalances.
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <button className="action-btn" onClick={handleGenerate} style={BTN_PRIMARY}>
                                    Generate my automated wallet <ArrowRight />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ── GENERATING ── */}
                    {phase === 'generating' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 48, textAlign: 'center' }}>
                            <div style={{ width: 48, height: 48, borderRadius: '50%', border: `2px solid ${C.brand}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', margin: '0 auto 20px' }} />
                            <div style={{ fontSize: 15, color: C.inkDim }}>Generating Ed25519 keypair in your browser…</div>
                        </div>
                    )}

                    {/* ── REVEAL ── */}
                    {phase === 'reveal' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid rgba(245,193,75,0.30)`, background: 'linear-gradient(180deg, rgba(40,30,10,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                                <span style={{ fontSize: 20 }}>⚠</span>
                                <div>
                                    <div style={{ fontSize: 16, fontWeight: 500, color: '#ffd884' }}>Save your private key now</div>
                                    <div style={{ fontSize: 13, color: C.inkDim, marginTop: 2 }}>This is the only time it will be shown. We do not store it anywhere.</div>
                                </div>
                            </div>

                            <div style={{ marginBottom: 24 }}>
                                <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Wallet address</div>
                                <div style={{ ...MONO, fontSize: 13, color: '#cfe2ff', padding: '12px 16px', borderRadius: 10, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', wordBreak: 'break-all' }}>
                                    {walletAddress}
                                </div>
                                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                                    <button onClick={handleCopyAddress} style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.lineStrong}`, background: 'rgba(255,255,255,0.04)', color: copiedField === 'address' ? C.pos : C.inkDim, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, ...MONO }}>
                                        {copiedField === 'address' ? <><CheckSVG /> Copied</> : <><CopySVG /> Copy address</>}
                                    </button>
                                </div>
                            </div>

                            <div style={{ marginBottom: 28 }}>
                                <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>Private key</div>
                                <div style={{ ...MONO, fontSize: 13, color: '#ffd884', padding: '14px 16px', borderRadius: 10, border: '1px solid rgba(245,193,75,0.30)', background: 'rgba(245,193,75,0.04)', wordBreak: 'break-all', lineHeight: 1.6 }}>
                                    {showKey ? privateKey : '•'.repeat(52)}
                                </div>
                                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                                    <button onClick={() => setShowKey(v => !v)} style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.lineStrong}`, background: 'rgba(255,255,255,0.04)', color: C.inkDim, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, ...MONO }}>
                                        {showKey ? <><EyeOffSVG /> Hide</> : <><EyeSVG /> Reveal</>}
                                    </button>
                                    <button onClick={handleCopyKey} style={{ padding: '6px 10px', borderRadius: 8, border: `1px solid ${C.lineStrong}`, background: 'rgba(255,255,255,0.04)', color: copiedField === 'key' ? C.pos : C.inkDim, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, ...MONO }}>
                                        {copiedField === 'key' ? <><CheckSVG /> Copied</> : <><CopySVG /> Copy key</>}
                                    </button>
                                </div>
                            </div>

                            <div style={{ borderRadius: 12, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', padding: '14px 18px', marginBottom: 28, fontSize: 13, color: C.inkDim, lineHeight: 1.6 }}>
                                You can import this key into <strong style={{ color: C.ink }}>Slush</strong> or any Sui wallet to access the wallet directly at any time.
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', borderRadius: 12, border: acknowledged ? '1px solid rgba(74,222,140,0.30)' : `1px solid ${C.lineStrong}`, background: acknowledged ? 'rgba(74,222,140,0.05)' : 'rgba(255,255,255,0.02)', cursor: 'pointer', marginBottom: 28, transition: 'all .2s ease' }}
                                onClick={() => setAcknowledged(!acknowledged)}>
                                <div style={{ width: 20, height: 20, borderRadius: 6, border: acknowledged ? '1px solid rgba(74,222,140,0.50)' : `1px solid ${C.lineStrong}`, background: acknowledged ? 'rgba(74,222,140,0.15)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all .2s ease' }}>
                                    {acknowledged && <span style={{ color: C.pos }}><CheckSVG /></span>}
                                </div>
                                <span style={{ fontSize: 14, color: acknowledged ? '#a8f0c4' : C.inkDim }}>
                                    I have saved my private key in a secure location. I understand this is the only time it will be shown.
                                </span>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <button className="action-btn" onClick={handleAcknowledge} disabled={!acknowledged}
                                    style={{ ...BTN_PRIMARY, opacity: acknowledged ? 1 : 0.4, cursor: acknowledged ? 'pointer' : 'not-allowed' }}>
                                    I've saved it — continue <ArrowRight />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ── BASKET CONFIG ── */}
                    {phase === 'basket' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div style={{ marginBottom: 32 }}>
                                <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 8 }}>Step 2 of 3</div>
                                <h3 style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.025em', margin: '0 0 8px' }}>
                                    Configure your <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, color: C.brand }}>basket</em>
                                </h3>
                                <p style={{ margin: 0, color: C.inkDim, fontSize: 14, lineHeight: 1.55, maxWidth: '50ch' }}>
                                    Choose which basket to track and set your rebalance parameters. These are stored on-chain in your policy.
                                </p>
                            </div>

                            {/* Basket picker */}
                            <div style={{ marginBottom: 32 }}>
                                <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Basket</div>
                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                    {(baskets.length > 0 ? baskets : [{ basket_key: 'suix-5', name: 'SUIX-5' }, { basket_key: 'suix-10', name: 'SUIX-10' }, { basket_key: 'suix-meme', name: 'SuiX Meme' }]).map(b => (
                                        <button key={b.basket_key} onClick={() => setSelectedBasket(b.basket_key)}
                                            style={{ padding: '12px 20px', borderRadius: 12, fontSize: 14, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', transition: 'all .2s ease',
                                                border: selectedBasket === b.basket_key ? '1px solid rgba(120,180,255,0.40)' : `1px solid ${C.line}`,
                                                background: selectedBasket === b.basket_key ? 'linear-gradient(180deg, rgba(58,161,255,0.12), rgba(30,123,255,0.04))' : 'rgba(255,255,255,0.02)',
                                                color: selectedBasket === b.basket_key ? C.ink : C.inkDim }}>
                                            {b.name || b.basket_key.toUpperCase()}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="config-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, marginBottom: 36 }}>
                                {/* Drift threshold */}
                                <div>
                                    <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Drift threshold</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 16 }}>
                                        <span style={{ ...MONO, fontSize: 40, fontWeight: 400, color: C.ink }}>
                                            {driftPct.toFixed(2)}<em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, color: C.brand, fontSize: 32 }}>%</em>
                                        </span>
                                        <span style={{ ...MONO, fontSize: 11, color: C.inkMute }}>{driftBps} BPS</span>
                                    </div>
                                    <input type="range" min={50} max={1000} step={25} value={driftBps}
                                        onChange={e => setDriftBps(Number(e.target.value))}
                                        style={{ width: '100%', accentColor: C.brand }} />
                                    <div style={{ display: 'flex', justifyContent: 'space-between', ...MONO, fontSize: 10.5, color: C.inkMute, marginTop: 6 }}>
                                        <span>0.5%</span><span>3%</span><span>5%</span><span>10%</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: C.inkMute, marginTop: 10, lineHeight: 1.5 }}>
                                        Rebalance triggers when any token drifts more than this from target.
                                    </div>
                                </div>

                                {/* Frequency */}
                                <div>
                                    <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 12 }}>Check frequency</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 16 }}>
                                        <span style={{ ...MONO, fontSize: 40, fontWeight: 400, color: C.ink }}>
                                            {freqLabel(freqSecs)}
                                        </span>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, padding: 4, borderRadius: 12, border: `1px solid ${C.lineStrong}`, background: 'rgba(20,28,46,0.45)' }}>
                                        {[43200, 86400, 604800, 2592000].map(s => (
                                            <button key={s} onClick={() => setFreqSecs(s)}
                                                style={{ padding: '10px 0', borderRadius: 8, fontSize: 12, fontWeight: 500, ...MONO, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .2s ease',
                                                    ...(freqSecs === s
                                                        ? { color: C.ink, background: 'linear-gradient(180deg, rgba(58,161,255,0.18), rgba(30,123,255,0.08))', border: '1px solid rgba(120,180,255,0.30)' }
                                                        : { color: C.inkDim, border: '1px solid transparent', background: 'transparent' }) }}>
                                                {freqLabel(s)}
                                            </button>
                                        ))}
                                    </div>
                                    <div style={{ fontSize: 12, color: C.inkMute, marginTop: 10, lineHeight: 1.5 }}>
                                        Minimum time between automated rebalances. The scanner checks every 12 hours.
                                    </div>
                                </div>
                            </div>

                            {/* Summary box */}
                            <div style={{ borderRadius: 14, border: `1px solid ${C.line}`, background: 'rgba(5,7,13,0.55)', padding: '18px 20px', ...MONO, fontSize: 12, color: C.inkDim, lineHeight: 1.75, marginBottom: 28 }}>
                                {[
                                    { text: 'Encrypt 32-byte key via Seal · ', sub: 'in-browser, never transmitted' },
                                    { text: 'Call backend for bot gas sponsorship · ', sub: 'SuiX pays activation gas' },
                                    { text: 'Sign as automation wallet · ', sub: 'from memory, key wiped after' },
                                    { text: 'Submit activate_policy · ', sub: `${selectedBasket.toUpperCase()} · ${driftPct.toFixed(1)}% drift · ${freqLabel(freqSecs)} frequency` },
                                ].map((s, i) => (
                                    <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                        <span style={{ color: C.brandSoft }}>›</span>
                                        <span style={{ color: C.inkMute }}>○</span>
                                        <span>{s.text}<span style={{ color: C.inkMute }}>{s.sub}</span></span>
                                    </div>
                                ))}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <button className="action-btn" onClick={handleActivate} style={BTN_PRIMARY}>
                                    Encrypt &amp; activate <ArrowRight />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ── IN PROGRESS (encrypting / sponsoring / submitting / polling) ── */}
                    {['encrypting', 'sponsoring', 'submitting', 'polling'].includes(phase) && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 48 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                {[
                                    { p: 'encrypting', label: 'Seal-encrypting private key',     sub: 'In-browser — key never leaves your device' },
                                    { p: 'sponsoring', label: 'Getting gas sponsorship',          sub: 'SuiX bot wallet signing as gas sponsor' },
                                    { p: 'submitting', label: 'Signing as automation wallet',     sub: 'Using keypair still in memory — wiped immediately after' },
                                    { p: 'polling',    label: 'Confirming on-chain',              sub: statusMsg },
                                ].map(({ p, label, sub }, i) => {
                                    const phases   = ['encrypting', 'sponsoring', 'submitting', 'polling'];
                                    const currIdx  = phases.indexOf(phase);
                                    const stepIdx  = phases.indexOf(p);
                                    const isActive = phase === p;
                                    const isDone   = stepIdx < currIdx;
                                    return (
                                        <div key={p} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', opacity: isActive ? 1 : isDone ? 0.7 : 0.3, transition: 'opacity .3s ease' }}>
                                            <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${isDone ? 'rgba(74,222,140,0.50)' : isActive ? 'rgba(58,161,255,0.60)' : C.line}`, background: isDone ? 'rgba(74,222,140,0.10)' : isActive ? 'rgba(58,161,255,0.10)' : 'rgba(255,255,255,0.02)' }}>
                                                {isDone
                                                    ? <span style={{ color: C.pos }}><CheckSVG /></span>
                                                    : isActive
                                                        ? <span style={{ width: 10, height: 10, borderRadius: '50%', background: C.brand, display: 'block', animation: 'pulseDot 1.4s infinite' }} />
                                                        : <span style={{ ...MONO, fontSize: 11, color: C.inkMute }}>{i + 1}</span>
                                                }
                                            </div>
                                            <div style={{ paddingTop: 4 }}>
                                                <div style={{ fontSize: 14, fontWeight: 500, color: isActive ? C.ink : isDone ? C.inkDim : C.inkMute }}>{label}</div>
                                                {(isActive || isDone) && <div style={{ fontSize: 12, color: C.inkMute, marginTop: 4 }}>{sub}</div>}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* ── DONE ── */}
                    {phase === 'done' && (
                        <div className="state-card" style={{ borderRadius: 24, border: '1px solid rgba(74,222,140,0.30)', background: 'linear-gradient(180deg, rgba(10,30,20,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
                                <div style={{ width: 48, height: 48, borderRadius: 14, border: '1px solid rgba(74,222,140,0.40)', background: 'rgba(74,222,140,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <span style={{ color: C.pos, transform: 'scale(1.3)' }}><CheckSVG /></span>
                                </div>
                                <div>
                                    <div style={{ fontSize: 18, fontWeight: 500, color: '#a8f0c4' }}>Automation wallet activated</div>
                                    <div style={{ fontSize: 13, color: C.inkDim, marginTop: 2 }}>Your AutomationCredential is live on-chain. SuiX will rebalance when drift exceeds your threshold.</div>
                                </div>
                            </div>

                            <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 28 }}>
                                {[
                                    { label: 'WALLET ADDRESS',  val: walletAddress,  full: true },
                                    { label: 'BASKET',          val: selectedBasket.toUpperCase() },
                                    { label: 'POLICY ID',       val: `${policyId.slice(0, 12)}…${policyId.slice(-8)}` },
                                    { label: 'CREDENTIAL ID',   val: `${credentialId.slice(0, 12)}…${credentialId.slice(-8)}` },
                                    { label: 'DRIFT TRIGGER',   val: `${driftPct.toFixed(1)}%` },
                                    { label: 'CHECK FREQUENCY', val: freqLabel(freqSecs) },
                                ].map(({ label, val, full }) => (
                                    <div key={label} style={{ borderRadius: 12, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', padding: '14px 16px', ...(full ? { gridColumn: '1 / -1' } : {}) }}>
                                        <div style={{ ...MONO, fontSize: 10, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
                                        <div style={{ ...MONO, fontSize: 13, color: '#cfe2ff', wordBreak: 'break-all' }}>{val}</div>
                                    </div>
                                ))}
                            </div>

                            <div style={{ borderRadius: 14, border: '1px solid rgba(58,161,255,0.20)', background: 'rgba(58,161,255,0.05)', padding: '16px 20px', marginBottom: 28, fontSize: 13, color: C.inkDim, lineHeight: 1.65 }}>
                                <strong style={{ color: C.ink, display: 'block', marginBottom: 4 }}>Next steps</strong>
                                Fund your new wallet with SUI (keep at least 0.5 SUI for gas) and the tokens you want to track, or USDC to deploy into the basket. Each automated rebalance draws gas from the SUI balance and charges the standard 0.50% execution fee on the traded amount. Then connect it via the Utility dashboard to view your portfolio.
                                You can also import the private key into <strong style={{ color: C.ink }}>Slush</strong> to access it manually at any time.
                            </div>

                            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                <Link href="/utility" style={{ ...BTN_GHOST, textDecoration: 'none' }}>
                                    Go to Utility dashboard
                                </Link>
                                <button onClick={() => { setPhase('intro'); setAcknowledged(false); setPolicyId(''); setCredentialId(''); setWalletAddress(''); setKeypair(null); }}
                                    style={{ ...BTN_GHOST, fontSize: 13 }}>
                                    Create another wallet
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ── ERROR ── */}
                    {phase === 'error' && (
                        <div className="state-card" style={{ borderRadius: 24, border: '1px solid rgba(255,107,138,0.30)', background: 'linear-gradient(180deg, rgba(40,10,18,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div style={{ fontSize: 15, fontWeight: 500, color: '#ffa3b6', marginBottom: 12 }}>Something went wrong</div>
                            <div style={{ ...MONO, fontSize: 12, color: C.inkDim, lineHeight: 1.6, marginBottom: 24, wordBreak: 'break-word' }}>{error}</div>
                            <button onClick={() => { setPhase('intro'); setAcknowledged(false); setError(''); }}
                                style={BTN_GHOST}>
                                Start over
                            </button>
                        </div>
                    )}

                </div>
            </section>

            <style>{`
                @keyframes pulseDot       { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.85)} }
                @keyframes pulseDotGreen  { 0%,100%{opacity:1;box-shadow:0 0 8px #4ade8c} 50%{opacity:.6;box-shadow:0 0 3px #4ade8c} }
                @keyframes spin           { to { transform: rotate(360deg) } }
                @media (max-width: 980px) {
                    .nav-logo { height: 136px !important; }
                    .nav-row  { height: 152px !important; }
                    .network-pill { display: none !important; }
                }
                @media (max-width: 700px) {
                    .intro-grid  { grid-template-columns: 1fr !important; }
                    .config-grid { grid-template-columns: 1fr !important; }
                }
                @media (max-width: 560px) {
                    .detail-grid { grid-template-columns: 1fr !important; }
                    .state-card  { padding: 24px !important; }
                }
                @media (max-width: 480px) {
                    .step-label  { font-size: 9px !important; white-space: normal !important; }
                    .action-btn  { width: 100% !important; justify-content: center !important; }
                }
            `}</style>
        </div>
    );
}
