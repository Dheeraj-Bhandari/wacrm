// ============================================================
// POST /api/whatsapp/broadcast/[id]/start
//
// Send a drafted or scheduled broadcast NOW, server-side (tab-safe).
//
//   - draft     → materialize recipients from the audience, then send.
//   - scheduled → recipients already materialized; just send now and
//                 clear the schedule.
//
// Reuses the resume machinery: claim the delivery lock, plan the
// 'pending' recipients, mark sending, fan out in after() with the
// service-role client. Responds 202 once the pass is planned.
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
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
import {
  materializeBroadcastRecipients,
  MaterializeError,
} from '@/lib/whatsapp/broadcast-materialize';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let claimedId: string | null = null;

  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`broadcast-start:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { data: bc, error: bcErr } = await supabase
      .from('broadcasts')
      .select('id, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (bcErr || !bc) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }
    if (bc.status !== 'draft' && bc.status !== 'scheduled') {
      return NextResponse.json(
        { error: `Only a draft or scheduled broadcast can be started (this one is '${bc.status}')` },
        { status: 409 },
      );
    }

    // A draft has no recipient rows yet — materialize from its audience.
    if (bc.status === 'draft') {
      try {
        await materializeBroadcastRecipients(supabase, accountId, id);
      } catch (err) {
        if (err instanceof MaterializeError) {
          // already_materialized is fine (a prior partial run); anything
          // else is a real problem.
          if (err.code !== 'already_materialized') {
            return NextResponse.json(
              { error: err.message, code: err.code },
              { status: err.code === 'not_found' ? 404 : 400 },
            );
          }
        } else {
          throw err;
        }
      }
    }

    // Claim BEFORE planning so two concurrent starts can't both fan out.
    const claimed = await claimBroadcastDelivery(supabase, accountId, id);
    if (!claimed) {
      return NextResponse.json(
        { error: 'A delivery pass is already running for this broadcast.' },
        { status: 409 },
      );
    }
    claimedId = id;

    const { plan, remaining, unsendable } = await planBroadcastResume(
      supabase,
      accountId,
      id,
      'pending',
    );

    await markBroadcastSending(supabase, id);
    // Clear any schedule now that it's sending.
    await supabase
      .from('broadcasts')
      .update({ scheduled_at: null })
      .eq('id', id)
      .eq('account_id', accountId);
    claimedId = null; // ownership passes to after()

    const admin = supabaseAdmin();
    after(async () => {
      try {
        await deliverBroadcast(admin, plan);
      } catch (err) {
        console.error(
          '[broadcast-start] delivery threw:',
          err instanceof Error ? err.message : err,
        );
        await finalizeBroadcastStatus(admin, id).catch(() => {});
      } finally {
        await releaseBroadcastDelivery(admin, id);
      }
    });

    return NextResponse.json(
      { success: true, broadcast_id: id, sending: plan.planned.length, remaining, unsendable },
      { status: 202 },
    );
  } catch (error) {
    if (claimedId) {
      await releaseBroadcastDelivery(supabaseAdmin(), claimedId).catch(() => {});
    }
    if (error instanceof BroadcastError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return toErrorResponse(error);
  }
}
