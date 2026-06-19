'use client';

import { useState, useEffect, useCallback } from 'react';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { SealClient } from '@mysten/seal';
import { useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import React from 'react';

const ConnectButton = dynamic(
    () => import('@mysten/dapp-kit').then(m => m.ConnectButton),
    { ssr: false, loading: () => <div style={{ height: 38, width: 120, borderRadius: 12, background: 'rgba(255,255,255,0.08)' }} /> }
);

const API_URL  = '/utility-api';
// Telegram linking endpoints live under /api/telegram on the backend (mounted in bot.js)
const TG_API   = process.env.NEXT_PUBLIC_TG_API_URL || '/utility-api/api/telegram';
const LOGO_URL = 'https://indigo-elaborate-bovid-600.mypinata.cloud/ipfs/bafybeihr2x6573m4bccxqed7ykvz3attt257ao6di474qxoaeyho4bkzya';

// ── Notification contract constants ──────────────────────────────────────────
const NOTIFICATION_PACKAGE_ID = '0xc09469d5816468c49d136d6f47ceb43e86560789457816652d431c76c7460ee5';
const NOTIFICATION_CONFIG_ID  = '0xecb7d250ef5537f9402b3c0221738b4c6a14e885f9c681b55b2551f7be140ddc';
const MAINNET_NOTIFICATION_KEY_SERVERS = [{
    objectId: '0xe0eb52eba9261b96e895bbb4deca10dcd64fbc626a1133017adcd5131353fd10',
    url:      'https://open.key-server.mainnet.seal.mirai.cloud',
    weight:   1,
}];

// ── Palette — matches existing utility pages exactly ─────────────────────────
const C = {
    bg0: '#05070d', ink: '#e8edf7', inkDim: '#9aa6bd', inkMute: '#5f6a82',
    line: 'rgba(148,170,210,0.12)', lineStrong: 'rgba(148,170,210,0.20)',
    brand: '#3aa1ff', brandSoft: '#7ad0ff',
    pos: '#4ade8c', warn: '#f5c14b', neg: '#ff6b8a', tg: '#26a5e4',
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
const BTN_TG: React.CSSProperties = {
    ...BTN_PRIMARY,
    border: '1px solid rgba(80,180,235,0.45)',
    background: 'linear-gradient(180deg, #2aa5e4 0%, #1c7fb8 100%)',
    boxShadow: '0 1px 0 rgba(255,255,255,0.18) inset, 0 10px 28px rgba(20,140,210,0.35)',
    textDecoration: 'none',
};
const BTN_GHOST: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '14px 22px', borderRadius: 12, fontSize: 14, fontWeight: 500,
    border: `1px solid ${C.lineStrong}`, background: 'transparent',
    color: C.ink, cursor: 'pointer', fontFamily: 'inherit',
};
const BTN_DANGER: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 10,
    padding: '12px 18px', borderRadius: 12, fontSize: 13, fontWeight: 500,
    border: '1px solid rgba(255,107,138,0.45)',
    background: 'linear-gradient(180deg, #ff5a7c 0%, #c5314e 100%)',
    color: '#fff', cursor: 'pointer', fontFamily: 'inherit',
};

// ── Icons ────────────────────────────────────────────────────────────────────
const ArrowRight = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
);
const CheckSVG = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12l4.5 4.5L20 6"/></svg>
);
const TelegramSVG = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M21.94 4.3 18.6 19.9c-.25 1.1-.91 1.38-1.84.86l-5.1-3.76-2.46 2.37c-.27.27-.5.5-1.02.5l.36-5.18 9.4-8.5c.41-.36-.09-.57-.63-.2L4.05 12.9l-5-1.57c-1.09-.34-1.11-1.09.23-1.61L20.5 2.74c.91-.34 1.7.2 1.44 1.56Z"/></svg>
);

// ── Phase machine ──────────────────────────────────────────────────────────────
type Phase =
    | 'intro'        // connect wallet + explain
    | 'connecting'   // calling link-start
    | 'waiting'      // deep link shown, polling for chat_id
    | 'linked'       // chat_id captured, ready to activate
    | 'encrypting'   // Seal-encrypting chat_id
    | 'signing'      // awaiting wallet signature
    | 'polling'      // waiting for NotificationActivated event
    | 'done'         // credential active
    | 'deactivating' // signing deactivate_and_delete
    | 'error';

// ── Step indicator (3 steps) ───────────────────────────────────────────────────
const STEPS = [
    { key: 'link',     label: 'Link Telegram' },
    { key: 'activate', label: 'Encrypt & sign' },
    { key: 'done',     label: 'Active' },
];
function stepIndexFor(phase: Phase): number {
    if (['connecting', 'waiting', 'linked'].includes(phase)) return 0;
    if (['encrypting', 'signing', 'polling'].includes(phase)) return 1;
    if (phase === 'done') return 2;
    return -1;
}
function StepDots({ current }: { current: Phase }) {
    const activeIdx  = stepIndexFor(current);
    const inProgress = ['connecting', 'encrypting', 'signing', 'polling'].includes(current);
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 48 }}>
            {STEPS.map((step, i) => {
                const isDone   = current === 'done' ? i < 2 : activeIdx > i;
                const isActive = activeIdx === i && current !== 'done';
                return (
                    <React.Fragment key={step.key}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                            <div style={{
                                width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                border: isDone ? '1px solid rgba(74,222,140,0.50)' : isActive ? '1px solid rgba(58,161,255,0.60)' : `1px solid ${C.line}`,
                                background: isDone ? 'rgba(74,222,140,0.10)' : isActive ? 'rgba(58,161,255,0.12)' : 'rgba(255,255,255,0.02)',
                                transition: 'all .35s ease',
                            }}>
                                {(current === 'done' && i === 2)
                                    ? <span style={{ color: C.pos }}><CheckSVG /></span>
                                    : isDone
                                        ? <span style={{ color: C.pos }}><CheckSVG /></span>
                                        : (isActive && inProgress)
                                            ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.brand, display: 'block', animation: 'pulseDot 1.4s infinite' }} />
                                            : <span style={{ ...MONO, fontSize: 11, color: isActive ? C.brandSoft : C.inkMute }}>{i + 1}</span>
                                }
                            </div>
                            <span className="step-label" style={{ ...MONO, fontSize: 10, letterSpacing: '0.08em', color: isDone ? '#a8f0c4' : isActive ? C.brandSoft : C.inkMute, whiteSpace: 'nowrap', textTransform: 'uppercase' }}>
                                {step.label}
                            </span>
                        </div>
                        {i < STEPS.length - 1 && (
                            <div style={{ flex: 1, height: 1, background: isDone ? 'rgba(74,222,140,0.30)' : C.line, margin: '0 8px', marginBottom: 28, transition: 'background .35s ease' }} />
                        )}
                    </React.Fragment>
                );
            })}
        </div>
    );
}

// ════════════════════════════════════════════════════════════════════════════
export default function NotificationsSetup() {
    useEffect(() => { document.title = 'SuiX — Telegram Notifications'; }, []);

    const currentAccount = useCurrentAccount();
    const connected      = !!currentAccount?.address;
    const userAddress    = currentAccount?.address;
    const { mutate: signAndExecuteTransaction } = useSignAndExecuteTransaction();

    const [phase,         setPhase]         = useState<Phase>('intro');
    const [error,         setError]         = useState('');
    const [statusMsg,     setStatusMsg]     = useState('');

    // linking
    const [linkToken,     setLinkToken]     = useState('');
    const [botUrl,        setBotUrl]        = useState('');
    const [chatId,        setChatId]        = useState('');

    // result
    const [policyId,      setPolicyId]      = useState('');
    const [credentialId,  setCredentialId]  = useState('');

    // basket the user wants drift notifications for
    const [selectedBasket, setSelectedBasket] = useState('suix-5');
    const [baskets, setBaskets] = useState<{ basket_key: string; name: string }[]>([]);

    const shortWallet = userAddress ? `${userAddress.slice(0, 6)}…${userAddress.slice(-4)}` : '';

    // ── On connect: detect an existing notification credential ───────────────────
    const loadExisting = useCallback(async (address: string) => {
        try {
            const res = await fetch('https://fullnode.mainnet.sui.io', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1,
                    method: 'suix_getOwnedObjects',
                    params: [address, {
                        filter: { StructType: `${NOTIFICATION_PACKAGE_ID}::notification::NotificationCredential` },
                        options: { showContent: true },
                    }],
                }),
            });
            const json = await res.json();
            const data = json.result?.data;
            if (!data || data.length === 0) return;
            const obj = data[0].data;
            setCredentialId(obj.objectId);
            setPolicyId(obj.content?.fields?.policy_id ?? '');
            setPhase('done');
        } catch { /* silent — treat as no existing credential */ }
    }, []);

    useEffect(() => {
        if (userAddress && phase === 'intro') loadExisting(userAddress);
    }, [userAddress, phase, loadExisting]);

    // Load baskets for the picker
    useEffect(() => {
        fetch(`${API_URL}/api/baskets`)
            .then(r => r.json())
            .then(d => setBaskets((d.baskets || []).filter((b: any) => ['suix-5', 'suix-10', 'suix-meme'].includes(b.basket_key))))
            .catch(() => {});
    }, []);

    // ── Step 1: start linking — mint token, show deep link, begin polling ────────
    async function handleConnectTelegram() {
        if (!userAddress) return;
        setError('');
        setPhase('connecting');
        try {
            const res = await fetch(`${TG_API}/link-start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ wallet_address: userAddress, basket_id: selectedBasket }),
            });
            const data = await res.json();
            if (!data.token || !data.bot_url) throw new Error(data.error || 'Could not start linking');
            setLinkToken(data.token);
            setBotUrl(data.bot_url);
            setPhase('waiting');
        } catch (e: any) {
            setError(e?.message ?? 'Could not start Telegram linking');
            setPhase('error');
        }
    }

    // ── Poll link-status while waiting ──────────────────────────────────────────
    useEffect(() => {
        if (phase !== 'waiting' || !linkToken) return;
        let cancelled = false;

        const iv = setInterval(async () => {
            try {
                const res  = await fetch(`${TG_API}/link-status?token=${linkToken}`);
                const data = await res.json();
                if (cancelled) return;
                if (data.chat_id) {
                    setChatId(String(data.chat_id));
                    setPhase('linked');
                    clearInterval(iv);
                } else if (data.expired) {
                    clearInterval(iv);
                    setError('That link expired. Tap Connect Telegram to get a fresh one.');
                    setPhase('error');
                }
            } catch { /* keep polling */ }
        }, 2500);

        const to = setTimeout(() => {
            if (!cancelled) {
                clearInterval(iv);
                setError('Timed out waiting for Telegram. Tap Connect Telegram to try again.');
                setPhase('error');
            }
        }, 180_000);

        return () => { cancelled = true; clearInterval(iv); clearTimeout(to); };
    }, [phase, linkToken]);

    // ── Step 2: encrypt chat_id + activate on-chain ─────────────────────────────
    async function handleActivate() {
        if (!userAddress || !chatId) return;
        setError('');

        const signTx = (tx: Transaction): Promise<{ digest: string }> =>
            new Promise((resolve, reject) =>
                signAndExecuteTransaction({ transaction: tx }, { onSuccess: resolve as any, onError: reject })
            );

        try {
            // 2a — Seal-encrypt the chat_id in-browser
            setPhase('encrypting');
            setStatusMsg('Encrypting your chat ID with Seal…');

            const dataBytes = new TextEncoder().encode(String(chatId));

            const sealSuiClient = new SuiJsonRpcClient({
                url:     'https://fullnode.mainnet.sui.io',
                network: 'mainnet' as any,
            });
            const sealClient = new SealClient({
                suiClient:        sealSuiClient as any,
                serverConfigs:    MAINNET_NOTIFICATION_KEY_SERVERS,
                verifyKeyServers: false,
            });

            const { encryptedObject } = await sealClient.encrypt({
                threshold: 1,
                packageId: NOTIFICATION_PACKAGE_ID,
                id:        NOTIFICATION_CONFIG_ID,
                data:      dataBytes,
            });
            const blobArray = Array.from(encryptedObject);

            // 2b — activate_notification (signed by the connected wallet)
            setPhase('signing');
            setStatusMsg('Sign in your wallet to store the encrypted credential…');

            const tx = new Transaction();
            tx.moveCall({
                target: `${NOTIFICATION_PACKAGE_ID}::notification::activate_notification`,
                arguments: [
                    tx.object(NOTIFICATION_CONFIG_ID),
                    tx.pure.vector('u8', blobArray),
                    tx.object('0x6'),
                ],
            });
            tx.setGasBudget(50_000_000);

            const result = await signTx(tx);

            // 2c — poll for NotificationActivated to get policy + credential IDs
            setPhase('polling');
            setStatusMsg('Confirming on-chain…');

            let pId = '', cId = '';
            for (let attempt = 0; attempt < 12; attempt++) {
                await new Promise(r => setTimeout(r, 1500));
                try {
                    const txBlock: any = await sealSuiClient.getTransactionBlock({
                        digest:  result.digest,
                        options: { showEvents: true },
                    });
                    const ev = (txBlock.events || []).find((e: any) => e.type?.includes('NotificationActivated'));
                    if (ev?.parsedJson) {
                        pId = ev.parsedJson.policy_id;
                        cId = ev.parsedJson.credential_id;
                        break;
                    }
                } catch { /* retry */ }
            }
            if (!pId || !cId) throw new Error('NotificationActivated event not found — check the transaction on Suivision.');

            // 2d — finalize: write the durable utility.telegram row (wallet,
            // policy, credential, basket) and delete the transient linking row.
            try {
                await fetch(`${TG_API}/link-complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token:         linkToken,
                        wallet_address: userAddress,
                        policy_id:     pId,
                        credential_id: cId,
                    }),
                });
            } catch { /* registry will reconcile */ }

            setPolicyId(pId);
            setCredentialId(cId);
            setChatId(''); // drop from memory
            setPhase('done');

        } catch (e: any) {
            setError(e?.message ?? String(e));
            setPhase('error');
        }
    }

    // ── Deactivate + delete ─────────────────────────────────────────────────────
    async function handleDeactivate() {
        if (!userAddress || !policyId || !credentialId) return;
        setPhase('deactivating');
        setError('');
        try {
            const tx = new Transaction();
            tx.moveCall({
                target: `${NOTIFICATION_PACKAGE_ID}::notification::deactivate_and_delete`,
                arguments: [
                    tx.object(NOTIFICATION_CONFIG_ID),
                    tx.object(policyId),
                    tx.object(credentialId),
                    tx.object('0x6'),
                ],
            });
            tx.setGasBudget(20_000_000);
            await new Promise<void>((resolve, reject) =>
                signAndExecuteTransaction({ transaction: tx }, { onSuccess: () => resolve(), onError: reject })
            );
            await new Promise(r => setTimeout(r, 3000)); // let chain settle before re-scan
            setPolicyId(''); setCredentialId(''); setLinkToken(''); setBotUrl(''); setChatId('');
            setPhase('intro');
        } catch (e: any) {
            setError(e?.message ?? String(e));
            setPhase('error');
        }
    }

    function resetFlow() {
        setError(''); setStatusMsg('');
        setLinkToken(''); setBotUrl(''); setChatId('');
        setPhase('intro');
    }

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

                    {/* Header */}
                    <div style={{ marginBottom: 56 }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '6px 14px', borderRadius: 999, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.025)', fontSize: 11, color: C.inkMute, ...MONO, letterSpacing: '0.10em', marginBottom: 20 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.tg, display: 'inline-block', animation: 'pulseDotTg 2.4s infinite' }} />
                            STATE · 02 · TELEGRAM ALERTS
                        </div>
                        <h1 style={{ fontSize: 'clamp(36px,5vw,64px)', lineHeight: 0.96, letterSpacing: '-0.04em', fontWeight: 500, margin: '0 0 16px', maxWidth: '18ch' }}>
                            <span style={{ background: 'linear-gradient(180deg,#ffffff 0%,#cfdeef 55%,#7a93b8 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'block' }}>
                                Get notified when
                            </span>
                            <em style={{ fontFamily: "'Fraunces', serif", fontStyle: 'italic', fontWeight: 300, background: 'linear-gradient(120deg,#9fd1ff 0%,#3aa1ff 50%,#1561d6 100%)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', display: 'block' }}>
                                your index drifts.
                            </em>
                        </h1>
                        <p style={{ fontSize: 15, lineHeight: 1.6, color: C.inkDim, maxWidth: '54ch', margin: 0 }}>
                            Link Telegram and SuiX will message you when your portfolio drifts past tolerance or needs attention. We never store your contact details — your Telegram chat ID is encrypted in your browser and stored on-chain in your own wallet. We only ever read public on-chain data.
                        </p>
                    </div>

                    {showSteps && <StepDots current={phase} />}

                    {/* ── INTRO ── */}
                    {phase === 'intro' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div className="intro-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 36 }}>
                                {[
                                    { title: 'Connect your wallet', body: 'Use the same dedicated wallet you rebalance from. The credential is stored in this wallet — you stay in control.' },
                                    { title: 'Link Telegram once', body: 'Tap to open our bot and press Start. We capture only your chat ID — never your @handle or any personal info.' },
                                    { title: 'Encrypted in your wallet', body: 'Your chat ID is Seal-encrypted in your browser and stored on-chain. Nothing about you is kept on our servers.' },
                                    { title: 'Revoke any time', body: 'Deactivating deletes the credential from your wallet on-chain. One signature, done.' },
                                ].map(({ title, body }) => (
                                    <div key={title} style={{ borderRadius: 16, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', padding: '20px 22px' }}>
                                        <div style={{ fontSize: 14, fontWeight: 500, color: C.ink, marginBottom: 6 }}>{title}</div>
                                        <div style={{ fontSize: 13, color: C.inkDim, lineHeight: 1.55 }}>{body}</div>
                                    </div>
                                ))}
                            </div>

                            {!connected ? (
                                <div style={{ borderRadius: 16, border: '1px solid rgba(58,161,255,0.22)', background: 'rgba(58,161,255,0.05)', padding: '24px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
                                    <div>
                                        <div style={{ fontSize: 15, fontWeight: 500, color: C.ink, marginBottom: 4 }}>Connect your wallet to continue</div>
                                        <div style={{ fontSize: 13, color: C.inkDim, maxWidth: '46ch', lineHeight: 1.5 }}>Notifications attach to the wallet you connect. Use your dedicated SuiX Utility wallet.</div>
                                    </div>
                                    <div style={{ borderRadius: 10, overflow: 'hidden' }}><ConnectButton /></div>
                                </div>
                            ) : (
                                <>
                                    {/* Basket picker — which basket to get drift alerts for */}
                                    <div style={{ borderRadius: 16, border: `1px solid ${C.lineStrong}`, background: 'rgba(20,28,46,0.45)', padding: '22px 24px', marginBottom: 20 }}>
                                        <div style={{ ...MONO, fontSize: 11, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6 }}>Notify me about</div>
                                        <div style={{ fontSize: 14, color: C.inkDim, marginBottom: 16, lineHeight: 1.5 }}>
                                            Which basket should we watch for drift in <span style={{ ...MONO, color: C.brandSoft }}>{shortWallet}</span>?
                                        </div>
                                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                            {(baskets.length > 0 ? baskets : [{ basket_key: 'suix-5', name: 'SUIX-5' }, { basket_key: 'suix-10', name: 'SUIX-10' }]).map(b => (
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

                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                                        <div style={{ ...MONO, fontSize: 12, color: C.inkMute }}>
                                            Wallet · <span style={{ color: C.brandSoft }}>{shortWallet}</span> · Basket · <span style={{ color: C.brandSoft }}>{selectedBasket.toUpperCase()}</span>
                                        </div>
                                        <button className="action-btn" onClick={handleConnectTelegram} style={BTN_TG}>
                                            <TelegramSVG /> Connect Telegram <ArrowRight />
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {/* ── CONNECTING ── */}
                    {phase === 'connecting' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 48, textAlign: 'center' }}>
                            <div style={{ width: 44, height: 44, borderRadius: '50%', border: `2px solid ${C.tg}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', margin: '0 auto 20px' }} />
                            <div style={{ fontSize: 15, color: C.inkDim }}>Generating your secure Telegram link…</div>
                        </div>
                    )}

                    {/* ── WAITING (open Telegram + poll) ── */}
                    {phase === 'waiting' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid rgba(80,180,235,0.30)`, background: 'linear-gradient(180deg, rgba(14,30,42,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
                                <span style={{ color: C.tg }}><TelegramSVG /></span>
                                <div style={{ fontSize: 16, fontWeight: 500, color: C.ink }}>Open Telegram and press Start</div>
                            </div>
                            <p style={{ fontSize: 14, color: C.inkDim, lineHeight: 1.6, margin: '0 0 24px', maxWidth: '54ch' }}>
                                Tap the button below to open <span style={{ color: C.brandSoft }}>@SuiX_Utility_Notification_bot</span>, then press <strong style={{ color: C.ink }}>Start</strong>. This page will update automatically once you're linked — then come back here to finish.
                            </p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                                <a className="action-btn" href={botUrl} target="_blank" rel="noreferrer" style={BTN_TG}>
                                    <TelegramSVG /> Open Telegram <ArrowRight />
                                </a>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: C.inkMute }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.tg, display: 'inline-block', animation: 'pulseDot 1.4s infinite' }} />
                                    Waiting for you to press Start…
                                </div>
                            </div>
                            <div style={{ marginTop: 24 }}>
                                <button onClick={resetFlow} style={{ ...BTN_GHOST, padding: '8px 14px', fontSize: 12 }}>Cancel</button>
                            </div>
                        </div>
                    )}

                    {/* ── LINKED (ready to activate) ── */}
                    {phase === 'linked' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, border: '1px solid rgba(74,222,140,0.30)', background: 'rgba(74,222,140,0.07)', fontSize: 14, color: '#a8f0c4', marginBottom: 28 }}>
                                <CheckSVG /> Telegram connected — ready to activate.
                            </div>
                            <div style={{ borderRadius: 14, border: `1px solid ${C.line}`, background: 'rgba(5,7,13,0.55)', padding: '18px 20px', ...MONO, fontSize: 12, color: C.inkDim, lineHeight: 1.75, marginBottom: 28 }}>
                                <div style={{ display: 'flex', gap: 10 }}><span style={{ color: C.brandSoft }}>›</span><span>Encrypt your chat ID via Seal <span style={{ color: C.inkMute }}>· in-browser, never transmitted</span></span></div>
                                <div style={{ display: 'flex', gap: 10 }}><span style={{ color: C.brandSoft }}>›</span><span>Store the encrypted credential in your wallet <span style={{ color: C.inkMute }}>· you sign once</span></span></div>
                                <div style={{ display: 'flex', gap: 10 }}><span style={{ color: C.brandSoft }}>›</span><span>Nothing about you stored on our servers</span></div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <button className="action-btn" onClick={handleActivate} style={BTN_PRIMARY}>Encrypt &amp; activate <ArrowRight /></button>
                            </div>
                        </div>
                    )}

                    {/* ── IN PROGRESS (encrypting / signing / polling) ── */}
                    {['encrypting', 'signing', 'polling'].includes(phase) && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 48 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                {[
                                    { p: 'encrypting', label: 'Encrypting your chat ID',           sub: 'In-browser via Seal — never transmitted' },
                                    { p: 'signing',    label: 'Storing credential in your wallet', sub: statusMsg || 'Sign the transaction in your wallet' },
                                    { p: 'polling',    label: 'Confirming on-chain',               sub: statusMsg },
                                ].map(({ p, label, sub }, i) => {
                                    const phases   = ['encrypting', 'signing', 'polling'];
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
                                                {(isActive || isDone) && sub && <div style={{ fontSize: 12, color: C.inkMute, marginTop: 4 }}>{sub}</div>}
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
                                    <div style={{ fontSize: 18, fontWeight: 500, color: '#a8f0c4' }}>Telegram notifications active</div>
                                    <div style={{ fontSize: 13, color: C.inkDim, marginTop: 2 }}>Your chat ID is Seal-encrypted in your wallet. SuiX will DM you when your index drifts or needs attention.</div>
                                </div>
                            </div>

                            <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 28 }}>
                                {[
                                    { label: 'WALLET',        val: shortWallet },
                                    { label: 'BOT',           val: '@SuiX_Utility_Notification_bot' },
                                    { label: 'BASKET',        val: selectedBasket.toUpperCase() },
                                    { label: 'POLICY ID',     val: policyId ? `${policyId.slice(0, 12)}…${policyId.slice(-8)}` : '—' },
                                    { label: 'CREDENTIAL ID', val: credentialId ? `${credentialId.slice(0, 12)}…${credentialId.slice(-8)}` : '—' },
                                ].map(({ label, val }) => (
                                    <div key={label} style={{ borderRadius: 12, border: `1px solid ${C.line}`, background: 'rgba(255,255,255,0.02)', padding: '14px 16px' }}>
                                        <div style={{ ...MONO, fontSize: 10, color: C.inkMute, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
                                        <div style={{ ...MONO, fontSize: 13, color: '#cfe2ff', wordBreak: 'break-all' }}>{val}</div>
                                    </div>
                                ))}
                            </div>

                            <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
                                <Link href="/utility" style={{ ...BTN_GHOST, textDecoration: 'none' }}>Go to Utility dashboard</Link>
                                <button onClick={handleDeactivate} style={BTN_DANGER}>Deactivate &amp; delete</button>
                            </div>
                        </div>
                    )}

                    {/* ── DEACTIVATING ── */}
                    {phase === 'deactivating' && (
                        <div className="state-card" style={{ borderRadius: 24, border: `1px solid ${C.lineStrong}`, background: 'linear-gradient(180deg, rgba(20,28,46,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 48, textAlign: 'center' }}>
                            <div style={{ width: 44, height: 44, borderRadius: '50%', border: `2px solid ${C.neg}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite', margin: '0 auto 20px' }} />
                            <div style={{ fontSize: 15, color: C.inkDim }}>Deactivating and deleting your credential…</div>
                        </div>
                    )}

                    {/* ── ERROR ── */}
                    {phase === 'error' && (
                        <div className="state-card" style={{ borderRadius: 24, border: '1px solid rgba(255,107,138,0.30)', background: 'linear-gradient(180deg, rgba(40,10,18,0.55) 0%, rgba(10,15,28,0.55) 100%)', backdropFilter: 'blur(20px)', padding: 40 }}>
                            <div style={{ fontSize: 15, fontWeight: 500, color: '#ffa3b6', marginBottom: 12 }}>Something went wrong</div>
                            <div style={{ ...MONO, fontSize: 12, color: C.inkDim, lineHeight: 1.6, marginBottom: 24, wordBreak: 'break-word' }}>{error}</div>
                            <button onClick={resetFlow} style={BTN_GHOST}>Start over</button>
                        </div>
                    )}

                </div>
            </section>

            <style>{`
                @keyframes pulseDot      { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(.85)} }
                @keyframes pulseDotTg    { 0%,100%{opacity:1;box-shadow:0 0 8px #26a5e4} 50%{opacity:.6;box-shadow:0 0 3px #26a5e4} }
                @keyframes spin          { to { transform: rotate(360deg) } }
                @media (max-width: 980px) {
                    .nav-logo { height: 136px !important; }
                    .nav-row  { height: 152px !important; }
                    .network-pill { display: none !important; }
                }
                @media (max-width: 700px) {
                    .intro-grid { grid-template-columns: 1fr !important; }
                }
                @media (max-width: 560px) {
                    .state-card { padding: 24px !important; }
                    .detail-grid { grid-template-columns: 1fr !important; }
                }
                @media (max-width: 480px) {
                    .action-btn { width: 100% !important; justify-content: center !important; box-sizing: border-box !important; }
                    .step-label { font-size: 9px !important; letter-spacing: 0.04em !important; white-space: normal !important; text-align: center !important; max-width: 52px !important; }
                }
            `}</style>
        </div>
    );
}
