// ============================================================
// GET /api/cron/scheduler
//
// The umbrella scheduled endpoint. Point an external scheduler
// (Hostinger cron / GitHub Actions / a Node cron pinger) at it on a
// short interval, e.g. every minute:
//
//   curl -s -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
//        https://crm.example.com/api/cron/scheduler
//
// It drains two due-work sources in one hit, each isolated so one
// failing source never blocks the other:
//   1. due activity reminders (activities.remind_at <= now)
//   2. due scheduled broadcasts (broadcasts.scheduled_at <= now)
//
// Shares AUTOMATION_CRON_SECRET with the automations/flows crons.
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { checkCronSecret } from '@/lib/cron/auth';
import { drainDueReminders } from '@/lib/activities/scheduler';
import { drainDueBroadcasts } from '@/lib/whatsapp/broadcast-scheduler';

// Delivery fan-out can run long; never cache.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = checkCronSecret(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const admin = supabaseAdmin();
  const now = new Date();

  // Each drain is independently guarded: a thrown error in one is logged
  // and reported, never aborting the other.
  const reminders = await drainDueReminders(admin, now).catch((err) => {
    console.error('[scheduler] reminder drain threw:', err);
    return { error: err instanceof Error ? err.message : String(err) };
  });

  const broadcasts = await drainDueBroadcasts(admin, now).catch((err) => {
    console.error('[scheduler] broadcast drain threw:', err);
    return { error: err instanceof Error ? err.message : String(err) };
  });

  return NextResponse.json({ reminders, broadcasts });
}
