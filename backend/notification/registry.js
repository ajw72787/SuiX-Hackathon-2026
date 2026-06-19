/**
 * SuiX Notification Service — Registry
 *
 * Owns the list of wallets the notification service watches.
 *
 * Source of truth: utility.telegram (wallet_address, policy_id, credential_id).
 *
 * On every run, syncChainEvents() polls the notification contract for new
 * events via queryEvents() with a persisted cursor, and keeps utility.telegram
 * in sync:
 *   NotificationActivated   → upsert wallet into utility.telegram
 *   NotificationCancelled   → remove wallet from utility.telegram
 *   NotificationCredentialUpdated → update credential_id
 *   (Deactivated/Reactivated do NOT change the registry — the scanner reads the
 *    live `active` flag from the policy object at scan time instead.)
 *
 * This module is completely independent of the rebalancer/scanner service.
 * It watches the NOTIFICATION contract, not the policy contract.
 *
 * Cursor key in utility.scanner_cursor: 'notification_events_cursor'
 * Events deduped via tx_digest stored in utility.chain_events.
 */

import "dotenv/config";

const CONFIG = {
  PACKAGE_ID: process.env.NOTIFICATION_PACKAGE_ID ?? "0xc09469d5816468c49d136d6f47ceb43e86560789457816652d431c76c7460ee5",
};

const CURSOR_KEY = "notification_events_cursor";

/**
 * Poll the notification contract for new events and reconcile utility.telegram.
 * Returns the number of new events processed.
 */
export async function syncChainEvents(sui, supabase) {
  console.log("[registry] Syncing notification chain events...");

  // Load already-processed tx_digests for fast dedup
  const { data: processed, error: procErr } = await supabase
    .from("chain_events")
    .select("tx_digest");

  if (procErr) {
    console.error("[registry] Failed to load processed digests:", procErr.message);
  }

  const seenDigests = new Set(
    (processed ?? []).map((r) => r.tx_digest).filter(Boolean)
  );

  // Load persisted cursor
  const { data: cursorRow } = await supabase
    .from("scanner_cursor")
    .select("value")
    .eq("key", CURSOR_KEY)
    .maybeSingle();

  let cursor = cursorRow?.value?.nextCursor ?? null;
  let totalProcessed = 0;
  let hasMore = true;

  while (hasMore) {
    let result;
    try {
      result = await sui.queryEvents({
        query: { MoveModule: { package: CONFIG.PACKAGE_ID, module: "notification" } },
        cursor,
        limit: 50,
        order: "ascending",
      });
    } catch (err) {
      console.error("[registry] queryEvents failed:", err.message);
      break;
    }

    for (const event of result.data) {
      const digest = event.id?.txDigest;
      if (digest && seenDigests.has(digest)) continue;

      try {
        await processChainEvent(event, supabase);
        if (digest) seenDigests.add(digest);
        totalProcessed++;
      } catch (err) {
        console.error("[registry] Failed to process event:", err.message);
      }
    }

    hasMore = result.hasNextPage;
    cursor = result.nextCursor ?? cursor;

    // Persist cursor once we've reached the end
    if (!result.hasNextPage && result.nextCursor) {
      await supabase
        .from("scanner_cursor")
        .upsert(
          {
            key: CURSOR_KEY,
            value: { nextCursor: result.nextCursor },
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" }
        );
    }
  }

  console.log(`[registry] Synced ${totalProcessed} new notification events`);
  return totalProcessed;
}

async function processChainEvent(event, supabase) {
  const eventType = event.type.split("::").pop();
  const fields = event.parsedJson ?? {};

  // Log every event to utility.chain_events (audit trail + dedup)
  await supabase.from("chain_events").insert({
    event_type: eventType,
    wallet_address: fields.owner ?? fields.wallet_address ?? "",
    policy_id: fields.policy_id ?? null,
    credential_id: fields.credential_id ?? null,
    raw_event: fields,
    tx_digest: event.id?.txDigest ?? null,
    checkpoint: event.checkpoint ? Number(event.checkpoint) : null,
  });

  switch (eventType) {
    case "NotificationActivated":
      await handleActivated(fields, supabase);
      break;
    case "NotificationCancelled":
      await handleCancelled(fields, supabase);
      break;
    case "NotificationCredentialUpdated":
      await handleCredentialUpdated(fields, supabase);
      break;
    default:
      // NotificationDeactivated / NotificationReactivated / OperatorRotated:
      // logged to chain_events, but the registry list is unchanged. The scanner
      // checks the live `active` flag on the policy object at scan time.
      break;
  }
}

async function handleActivated(fields, supabase) {
  if (!fields.owner || !fields.policy_id || !fields.credential_id) {
    console.warn("[registry] NotificationActivated missing fields — skipping:", fields);
    return;
  }

  const { error } = await supabase
    .from("telegram")
    .upsert(
      {
        wallet_address: fields.owner,
        policy_id: fields.policy_id,
        credential_id: fields.credential_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "wallet_address" }
    );

  if (error) {
    console.error("[registry] telegram upsert failed:", error.message);
  } else {
    console.log(`[registry] Registered ${fields.owner} (policy ${fields.policy_id})`);
  }
}

async function handleCancelled(fields, supabase) {
  if (!fields.owner) return;

  const { error } = await supabase
    .from("telegram")
    .delete()
    .eq("wallet_address", fields.owner);

  if (error) {
    console.error("[registry] telegram delete failed:", error.message);
  } else {
    console.log(`[registry] Removed ${fields.owner}`);
  }
}

async function handleCredentialUpdated(fields, supabase) {
  if (!fields.owner || !fields.credential_id) return;

  const { error } = await supabase
    .from("telegram")
    .update({
      credential_id: fields.credential_id,
      updated_at: new Date().toISOString(),
    })
    .eq("wallet_address", fields.owner);

  if (error) {
    console.error("[registry] telegram credential update failed:", error.message);
  } else {
    console.log(`[registry] Updated credential for ${fields.owner}`);
  }
}

/**
 * Return the current watch list from utility.telegram.
 * Each row: { wallet_address, policy_id, credential_id }
 */
export async function getWatchList(supabase) {
  const { data, error } = await supabase
    .from("telegram")
    .select("wallet_address, policy_id, credential_id, basket_id");

  if (error) throw new Error(`Failed to load watch list: ${error.message}`);
  return data ?? [];
}
