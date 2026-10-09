// ============================================================
// In-process scheduler cron (Node runtime only).
//
// Fires due activity reminders and scheduled broadcasts on a fixed
// interval from *inside* the running Node server, so a self-hosted
// deployment (`next start`, Docker, a VPS) needs no external pinger
// for near-real-time reminders. It calls the same drain functions the
// GET /api/cron/scheduler route calls, so behaviour is identical.
//
// It is OFF by default and only starts when CRON_IN_PROCESS=true, for
// two reasons:
//   1. Serverless/edge hosts (Cloudflare Workers via @opennextjs,
//      Vercel) do not keep a process alive between requests, so an
//      interval there would be unreliable — those hosts should use a
//      platform cron hitting the HTTP endpoint instead.
//   2. Running multiple server instances (horizontal scale) would run
//      the interval once per instance. The drains are safe to run
//      concurrently (each claims rows optimistically), but you usually
//      want exactly one pinger — keep it off and use an external cron
//      when you scale out.
//
// Interval is CRON_IN_PROCESS_INTERVAL_MS (default 60000 = 1 min).
// Registered from instrumentation.ts, which only runs server-side.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { drainDueReminders } from '@/lib/activities/scheduler';
import { drainDueBroadcasts } from '@/lib/whatsapp/broadcast-scheduler';

// Guard against double-registration (HMR in dev, repeated register()).
const GLOBAL_KEY = '__wacrm_in_process_cron__';

type CronGlobal = typeof globalThis & { [GLOBAL_KEY]?: { timer: NodeJS.Timeout } };

/** One scheduler tick: drain reminders + broadcasts, each isolated. */
async function tick(): Promise<void> {
  const admin = supabaseAdmin();
  const now = new Date();

  const reminders = await drainDueReminders(admin, now).catch((err) => {
    console.error('[in-process-cron] reminder drain threw:', err);
    return null;
  });
  const broadcasts = await drainDueBroadcasts(admin, now).catch((err) => {
    console.error('[in-process-cron] broadcast drain threw:', err);
    return null;
  });

  // Only log when something actually happened, to keep logs quiet.
  const claimed = reminders && 'claimed' in reminders ? reminders.claimed : 0;
  const due = broadcasts && 'due' in broadcasts ? broadcasts.due : 0;
  if (claimed || due) {
    console.log('[in-process-cron] tick', { reminders, broadcasts });
  }
}

/**
 * Start the in-process cron if enabled. Safe to call more than once —
 * it registers at most one interval per process. No-op when
 * CRON_IN_PROCESS is not "true".
 */
export function startInProcessCron(): void {
  if (process.env.CRON_IN_PROCESS !== 'true') return;

  const g = globalThis as CronGlobal;
  if (g[GLOBAL_KEY]) return; // already running

  const intervalMs = Number(process.env.CRON_IN_PROCESS_INTERVAL_MS) || 60_000;

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the event loop alive solely for the cron.
  timer.unref?.();

  g[GLOBAL_KEY] = { timer };
  console.log(`[in-process-cron] started (every ${intervalMs}ms)`);

  // Fire once shortly after boot so a reminder due at startup isn't
  // delayed a full interval.
  setTimeout(() => void tick(), 5_000).unref?.();
}
