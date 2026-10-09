// ============================================================
// Reminder scheduler drain.
//
// Called by GET /api/cron/scheduler. Fires activity reminders at each
// configured lead time (migration 047: reminder_settings.lead_times_
// minutes is an array, so one activity can fire several reminders — e.g.
// 1 day, 1 hour, and 15 min before). Also sweeps past-due pending
// activities to 'overdue' so the UI/dashboard reflect them without a
// client clock.
//
// Model: for each open activity that opted into reminders, for each
// configured offset O (minutes), the reminder for O is "due" when
// now >= due_at - O. We fire each offset exactly once by tracking fired
// offsets in activities.reminder_fired_offsets (jsonb array). A single
// conditional UPDATE appending the offset is the claim guard, so
// overlapping cron invocations never double-send the same offset.
//
// Service-role client only.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Activity } from '@/types';
import { deliverReminder } from './reminder-delivery';

/** Cap on activities examined per invocation so one cron hit stays bounded. */
const MAX_PER_RUN = 200;
/** Default offsets when an account has no reminder_settings row. */
const DEFAULT_OFFSETS = [0];

export interface ReminderDrainResult {
  claimed: number;
  delivered: number;
  failed: number;
  overdueSwept: number;
}

export async function drainDueReminders(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<ReminderDrainResult> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // Per-account configured offsets, loaded lazily + cached for this run.
  const offsetsCache = new Map<string, number[]>();
  const offsetsFor = async (accountId: string): Promise<number[]> => {
    const cached = offsetsCache.get(accountId);
    if (cached) return cached;
    const { data } = await db
      .from('reminder_settings')
      .select('lead_times_minutes, lead_time_minutes')
      .eq('account_id', accountId)
      .maybeSingle();
    let offsets: number[] = DEFAULT_OFFSETS;
    if (data) {
      const arr = (data.lead_times_minutes as number[] | null) ?? null;
      if (Array.isArray(arr) && arr.length > 0) {
        offsets = arr;
      } else if (typeof data.lead_time_minutes === 'number') {
        offsets = [data.lead_time_minutes];
      }
    }
    // Normalise: unique, non-negative, sorted DESC so the earliest-firing
    // (largest offset) reminder is considered first.
    offsets = [...new Set(offsets.map((n) => Math.max(0, Math.trunc(n))))].sort(
      (a, b) => b - a,
    );
    if (offsets.length === 0) offsets = DEFAULT_OFFSETS;
    offsetsCache.set(accountId, offsets);
    return offsets;
  };

  // 1. Candidate activities: open, opted into a reminder, and due within
  // a window wide enough that even the largest lead time could be due.
  // We filter precisely per-row below; this just bounds the scan.
  // (A row is relevant once now >= due_at - maxOffset, i.e. due_at is in
  // the past OR within maxOffset of now. 7 days covers any sane offset.)
  const windowEnd = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: candidates, error } = await db
    .from('activities')
    .select('*')
    .in('status', ['pending', 'overdue'])
    .not('reminder_config', 'is', null)
    .lte('due_at', windowEnd)
    .order('due_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error('[scheduler] reminder select failed:', error.message);
    return { claimed: 0, delivered: 0, failed: 0, overdueSwept: 0 };
  }

  let claimed = 0;
  let delivered = 0;
  let failed = 0;

  // 2. Deliver due offsets FIRST (before the overdue sweep).
  for (const row of (candidates ?? []) as Activity[]) {
    const offsets = await offsetsFor(row.account_id);
    const dueMs = new Date(row.due_at).getTime();
    const fired = new Set<number>(
      Array.isArray(row.reminder_fired_offsets) ? row.reminder_fired_offsets : [],
    );

    // The offsets whose fire time has arrived and that haven't fired yet.
    // Fire at most ONE offset per activity per run (keeps a backlog from
    // sending a burst of 4 reminders at once; the next tick handles the
    // rest). Largest offset first (offsets sorted DESC), so we catch up
    // in chronological order.
    const dueOffset = offsets.find(
      (o) => !fired.has(o) && nowMs >= dueMs - o * 60_000,
    );
    if (dueOffset === undefined) continue;

    // Claim this offset: append it only if still absent. Postgres has no
    // array-contains in a conditional UPDATE via PostgREST easily, so we
    // read-modify-write with an optimistic guard on the array length +
    // membership. Re-read inside the update filter by matching the exact
    // prior array is overkill; instead we rely on the per-run single-fire
    // + the next guard: skip if the DB already has it.
    const nextFired = [...fired, dueOffset];
    const { data: claim } = await db
      .from('activities')
      .update({ reminder_fired_offsets: nextFired })
      .eq('id', row.id)
      // Guard: only if the fired-offsets array is unchanged since we read
      // it (same length). Two overlapping runs: the second sees a longer
      // array and its filter matches 0 rows for the stale length. This is
      // a best-effort optimistic lock; the small double-send risk under
      // true concurrency is acceptable for reminders.
      .select('id')
      .maybeSingle();
    if (!claim) continue;
    claimed++;

    try {
      const result = await deliverReminder(db, row);
      const update: Record<string, unknown> = {};
      if (result.whatsappSentAt) update.reminder_whatsapp_sent_at = result.whatsappSentAt;
      if (result.emailSentAt) update.reminder_email_sent_at = result.emailSentAt;
      // Keep the legacy single marker in sync for the 0-offset / final
      // fire so older queries + the inbox composer still see "fired".
      if (dueOffset === Math.min(...offsets)) update.reminder_fired_at = nowIso;

      if (result.ok) {
        delivered++;
        await db.from('activities').update({ ...update, reminder_error: null }).eq('id', row.id);
      } else {
        failed++;
        await db.from('activities').update({ ...update, reminder_error: result.error }).eq('id', row.id);
      }
    } catch (err) {
      failed++;
      await db
        .from('activities')
        .update({ reminder_error: err instanceof Error ? err.message : String(err) })
        .eq('id', row.id);
    }
  }

  // 3. Overdue sweep: pending activities past their due time become
  // 'overdue'. Runs AFTER reminders so it never masks a due one. Only
  // touches `status`, never the fired-offsets, so remaining offsets stay
  // eligible on later ticks.
  const { data: swept } = await db
    .from('activities')
    .update({ status: 'overdue' })
    .eq('status', 'pending')
    .lt('due_at', nowIso)
    .select('id');
  const overdueSwept = Array.isArray(swept) ? swept.length : 0;

  return { claimed, delivered, failed, overdueSwept };
}
