// ============================================================
// Scheduled-broadcast drain.
//
// Called by GET /api/cron/scheduler. Finds broadcasts that were
// scheduled for a time that has now arrived and delivers them
// server-side — the browser that scheduled them is long gone.
//
// Recipients are materialized at schedule time (see the schedule
// endpoint), with their template_params frozen on each
// broadcast_recipients row, so this drain reuses the exact resume
// machinery: claim the delivery lock, plan the 'pending' recipients,
// flip to sending, fan out.
//
// Concurrency-safe: claimBroadcastDelivery is a conditional UPDATE on
// delivery_locked_at, so overlapping cron hits never double-send.
// Service-role client only.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';

/** Scheduled broadcasts started per cron invocation. */
const MAX_PER_RUN = 20;

export interface BroadcastDrainResult {
  due: number;
  started: number;
  skipped: number;
  errors: number;
}

export async function drainDueBroadcasts(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<BroadcastDrainResult> {
  const nowIso = now.toISOString();

  // Covered by idx_broadcasts_scheduled_due (migration 045).
  const { data: due, error } = await db
    .from('broadcasts')
    .select('id, account_id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error('[broadcast-scheduler] select failed:', error.message);
    return { due: 0, started: 0, skipped: 0, errors: 0 };
  }

  const rows = (due ?? []) as { id: string; account_id: string }[];
  let started = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of rows) {
    // Claim the delivery lock first. If another pass already holds it
    // (or the row isn't on this account), skip — the next cron hit
    // retries once the lock frees.
    const claimed = await claimBroadcastDelivery(db, row.account_id, row.id, now);
    if (!claimed) {
      skipped++;
      continue;
    }

    try {
      const { plan } = await planBroadcastResume(db, row.account_id, row.id, 'pending');
      await markBroadcastSending(db, row.id);
      // Deliver inline (we're already in a background cron, not a
      // request), then finalize + release regardless of outcome.
      await deliverBroadcast(db, plan);
      started++;
    } catch (err) {
      // A broadcast with no sendable recipients (all unsendable, or an
      // empty materialization) throws nothing-to-resume — settle it so
      // it doesn't stay 'scheduled'/'sending' forever.
      if (err instanceof BroadcastError && err.code === 'nothing_to_resume') {
        await finalizeBroadcastStatus(db, row.id).catch(() => {});
        skipped++;
      } else {
        errors++;
        console.error(
          '[broadcast-scheduler] delivery failed for',
          row.id,
          err instanceof Error ? err.message : err,
        );
        await finalizeBroadcastStatus(db, row.id).catch(() => {});
      }
    } finally {
      await releaseBroadcastDelivery(db, row.id);
    }
  }

  return { due: rows.length, started, skipped, errors };
}
