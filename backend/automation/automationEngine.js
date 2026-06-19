/**
 * SuiX Automation Engine (v2 — shared execution engine)
 *
 * REFACTOR: this engine no longer owns any portfolio logic. Analysis, trade
 * generation, PTB construction (Cetus), and dry-run preview all come from
 * services/executionEngine.js — the exact same code path as the dashboard
 * and the manual Rebalance button. The automation path can never disagree
 * with what users see, and inherits every engine improvement automatically:
 *   - Cetus aggregator (replaces the 7K MetaAg fork)
 *   - SUI-less basket support (deploy buffer — required for suix-meme)
 *   - quoteStale execute-mode valuation (stale exits spread across deficits)
 *   - stale-token route grace (a dead token never bricks the rebalance)
 *   - missing-token exemption (small portfolios complete their index)
 *
 * What this file still owns (the only things unique to automation):
 *   - Seal decryption of the AutomationCredential (key recovery)
 *   - key/wallet identity verification
 *   - SIGNING the engine-built transaction with the recovered keypair
 *   - submission + result mapping for the scanner
 *
 * NEW SAFETY GATE: the engine's previewTransaction (dry-run) now runs BEFORE
 * the signed submission. The old 7K fork signed and submitted blind; this
 * version refuses to execute anything that fails simulation — critical for
 * unattended trading in thin pools.
 *
 * Scanner contract (unchanged): exports executeAutomatedRebalance(wallet, deps)
 * and analyzeAutomationWallet(walletAddress, basketKey) with the same shapes.
 */

import "dotenv/config";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { encodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SealClient, SessionKey } from "@mysten/seal";

import {
  analyzeWallet,
  generateTrades,
  buildRebalanceTransaction,
  previewTransaction,
  isSuiType,
  isUsdcType,
  USDC_TYPE,
  SUI_TYPE,
} from "../services/executionEngine.js";

// ── Config ────────────────────────────────────────────────────────────────────

const SUI_RPC_URL = process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443";
const NETWORK = process.env.SUI_NETWORK ?? "mainnet";

const SEAL_SESSION_TTL_MIN = 10;
const SEAL_TIMEOUT_MS = 30_000;

const DEFAULT_MAINNET_SEAL_SERVER_URL =
  "https://open.key-server.mainnet.seal.mirai.cloud";

// Seal SDK requires the JSON-RPC core client. Transaction submission happens
// via raw JSON-RPC fetch (sui_executeTransactionBlock) — the same pattern the
// create page uses — to avoid @mysten/sui export-surface differences between
// SDK versions.
const sealSuiClient = new SuiJsonRpcClient({
  url: SUI_RPC_URL,
  network: NETWORK,
});

// ── Seal: credential decryption (unchanged from v1) ───────────────────────────

function buildSealServerConfigs(sealKeyServers = []) {
  const ids = sealKeyServers.length
    ? sealKeyServers
    : (process.env.SEAL_KEY_SERVERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  return ids.map((objectId) => ({
    objectId,
    url: DEFAULT_MAINNET_SEAL_SERVER_URL,
    weight: 1,
  }));
}

async function buildSealApproveTx(suiClient, packageId, configId, policyId, senderAddress) {
  const tx = new Transaction();

  tx.setSender(senderAddress);

  const idBytes = Array.from(Buffer.from(packageId.replace("0x", ""), "hex"));

  const [configObj, policyObj] = await Promise.all([
    suiClient.core.getObject({ objectId: configId }),
    suiClient.core.getObject({ objectId: policyId }),
  ]);

  const configInitialVersion =
    configObj.object.owner.Shared?.initialSharedVersion ??
    configObj.object.owner.Shared?.initial_shared_version ??
    configObj.object.version;

  const policyInitialVersion =
    policyObj.object.owner.Shared?.initialSharedVersion ??
    policyObj.object.owner.Shared?.initial_shared_version ??
    policyObj.object.version;

  tx.moveCall({
    target: `${packageId}::policy::seal_approve`,
    arguments: [
      tx.pure.vector("u8", idBytes),
      tx.sharedObjectRef({
        objectId: configId,
        initialSharedVersion: configInitialVersion,
        mutable: false,
      }),
      tx.sharedObjectRef({
        objectId: policyId,
        initialSharedVersion: policyInitialVersion,
        mutable: false,
      }),
    ],
  });

  return await tx.build({
    client: suiClient,
    onlyTransactionKind: true,
  });
}

async function decryptAutomationWallet({
  credentialId,
  policyId,
  packageId,
  configId,
  botKeypair,
  sealKeyServers,
}) {
  const backendAddress = botKeypair.getPublicKey().toSuiAddress();

  console.log("[automation] decrypt: backend wallet:", backendAddress);

  const sealClient = new SealClient({
    suiClient: sealSuiClient,
    serverConfigs: buildSealServerConfigs(sealKeyServers),
    verifyKeyServers: false,
  });

  console.log("[automation] decrypt: fetching encrypted credential...");

  const credentialObj = await sealSuiClient.core.getObject({
    objectId: credentialId,
    include: { json: true },
  });

  const encryptedBlob = credentialObj?.object?.json?.encrypted_blob;
  const onChainPolicyId = credentialObj?.object?.json?.policy_id;

  if (!encryptedBlob?.length) {
    throw new Error("encrypted_blob missing from AutomationCredential");
  }

  if (onChainPolicyId && onChainPolicyId !== policyId) {
    console.warn("[automation] warning: Supabase policy_id differs from credential policy_id", {
      supabasePolicyId: policyId,
      onChainPolicyId,
    });
  }

  const encryptedObject = new Uint8Array(encryptedBlob);

  console.log(`[automation] decrypt: encrypted blob fetched (${encryptedObject.length} bytes)`);

  console.log("[automation] decrypt: creating SessionKey...");

  const sessionKey = await SessionKey.create({
    address: backendAddress,
    packageId,
    ttlMin: SEAL_SESSION_TTL_MIN,
    signer: botKeypair,
    suiClient: sealSuiClient,
  });

  console.log("[automation] decrypt: building seal_approve PTB...");

  const txBytes = await buildSealApproveTx(
    sealSuiClient,
    packageId,
    configId,
    policyId,
    backendAddress
  );

  console.log(`[automation] decrypt: seal_approve PTB built (${txBytes.length} bytes)`);

  console.log("[automation] decrypt: requesting decryption from Seal...");

  const decryptedBytes = await Promise.race([
    sealClient.decrypt({
      data: encryptedObject,
      sessionKey,
      txBytes,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Seal decrypt timeout")), SEAL_TIMEOUT_MS)
    ),
  ]);

  if (!decryptedBytes?.length) {
    throw new Error("Seal decrypt returned no bytes");
  }

  console.log(`[automation] decrypt: success (${decryptedBytes.length} bytes recovered)`);

  const recoveredPrivateKey = encodeSuiPrivateKey(decryptedBytes, "ED25519");
  const userKeypair = Ed25519Keypair.fromSecretKey(recoveredPrivateKey);

  return {
    userKeypair,
    decryptedBytes,
  };
}

// ── Analysis passthrough (scanner-facing, dashboard mode) ─────────────────────
// The scanner calls this once per wallet per scan to decide whether anything
// needs doing. Dashboard mode (no quoteStale) keeps scans fast; the execute
// path below re-analyzes with quoteStale: true before trading.

async function analyzeAutomationWallet(walletAddress, basketKey) {
  return analyzeWallet(walletAddress, basketKey);
}

// ── Automated rebalance: decrypt → verify → engine → preview → sign → submit ──

async function executeAutomatedRebalance(wallet, deps) {
  const { botKeypair, packageId, configId, sealKeyServers } = deps;
  const { wallet_address, policy_id, credential_id, basket_id } = wallet;

  let decryptedBytes = null;

  try {
    // ── 1. Recover the automation wallet's key via Seal ────────────────────
    const { userKeypair, decryptedBytes: recoveredBytes } =
      await decryptAutomationWallet({
        credentialId: credential_id,
        policyId: policy_id,
        packageId,
        configId,
        botKeypair,
        sealKeyServers,
      });

    decryptedBytes = recoveredBytes;

    const signerAddress = userKeypair.getPublicKey().toSuiAddress();

    console.log("[automation] recovered automation wallet:", signerAddress);

    if (signerAddress.toLowerCase() !== wallet_address.toLowerCase()) {
      return {
        success: false,
        error: `key/wallet mismatch: key controls ${signerAddress}, expected ${wallet_address}`,
        txHash: null,
        trades: null,
      };
    }

    // ── 2. Shared engine: analyze in EXECUTE mode (real stale valuations) ──
    const analysis = await analyzeWallet(wallet_address, basket_id, { quoteStale: true });

    console.log("[automation] analysis:", {
      wallet_address,
      basket_id,
      status: analysis.status,
      maxDriftPct: analysis.maxDrift * 100,
      totalUsdValue: analysis.totalUsdValue,
      uninvested: analysis.uninvested,
      staleCount: analysis.staleHoldings.length,
      analysisRows: analysis.analysis.length,
    });

    if (analysis.status === "green") {
      return {
        success: true,
        skipped: true,
        reason: "balanced",
        txHash: null,
        trades: null,
      };
    }

    // ── 3. Shared engine: generate trades ──────────────────────────────────
    const trades = generateTrades(analysis);

    console.log("[automation] generated trades:");
    console.dir(trades, { depth: null });

    if (!trades.length) {
      return {
        success: true,
        skipped: true,
        reason: "no trades",
        txHash: null,
        trades: null,
      };
    }

    // ── 4. Shared engine: build the Cetus PTB (base64, sender = wallet) ────
    let txBase64;
    try {
      txBase64 = await buildRebalanceTransaction(wallet_address, trades);
    } catch (buildErr) {
      // Dust-only / all-skipped builds are a clean skip, not a failure
      if (buildErr.message?.includes("dust") || buildErr.message?.includes("balanced") ||
          buildErr.message?.includes("No executable swaps")) {
        return {
          success: true,
          skipped: true,
          reason: buildErr.message,
          txHash: null,
          trades: null,
        };
      }
      throw buildErr;
    }

    // ── 5. SAFETY GATE: dry-run before signing — never submit blind ────────
    const preview = await previewTransaction(txBase64);
    if (!preview.success) {
      console.log(`[automation] dry-run failed — NOT executing: ${preview.error}`);
      return {
        success: false,
        skipped: false,
        error: `simulation_failed: ${preview.error}`,
        txHash: null,
        trades: trades.map((t) => ({
          from: t.from_symbol,
          to: t.to_symbol,
          usd: t.usd_amount,
          from_units: t.from_units,
        })),
      };
    }

    // ── 6. Sign with the recovered keypair and submit via raw RPC ──────────
    const txBytes = new Uint8Array(Buffer.from(txBase64, "base64"));
    const senderSig = await userKeypair.signTransaction(txBytes);

    console.log("[automation] submitting signed rebalance...");

    const submitRes = await fetch(SUI_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sui_executeTransactionBlock",
        params: [
          txBase64,
          [senderSig.signature],
          { showEffects: true, showEvents: true },
          "WaitForLocalExecution",
        ],
      }),
    });

    const submitJson = await submitRes.json();
    if (submitJson.error) {
      throw new Error(`sui_executeTransactionBlock failed: ${submitJson.error.message}`);
    }

    const result = submitJson.result;

    const success = result?.effects?.status?.status === "success";

    console.log(`[automation] execution ${success ? "succeeded" : "FAILED"} — digest: ${result?.digest ?? "n/a"}`);

    return {
      success,
      skipped: false,
      txHash: result?.digest ?? null,
      trades: trades.map((t) => ({
        from: t.from_symbol,
        to: t.to_symbol,
        usd: t.usd_amount,
        from_units: t.from_units,
      })),
      error: success ? null : result?.effects?.status?.error,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      txHash: null,
      trades: null,
    };
  } finally {
    if (decryptedBytes) {
      decryptedBytes.fill(0);
      decryptedBytes = null;
      console.log("[automation] decrypted key bytes wiped from memory");
    }
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
// Scanner imports executeAutomatedRebalance + analyzeAutomationWallet.
// Shared-engine helpers are re-exported for compatibility with any other
// consumer of the old module surface.

export {
  executeAutomatedRebalance,
  analyzeAutomationWallet,
  decryptAutomationWallet,
  generateTrades as generateAutomationTrades,
  isSuiType,
  isUsdcType,
  USDC_TYPE,
  SUI_TYPE,
};
