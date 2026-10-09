// ============================================================
// POST /api/whatsapp/broadcast/[id]/schedule
//
// Turn a draft broadcast into a scheduled one. Resolves the draft's
// audience_filter + template_variables into frozen recipient rows NOW
// (so the cron can send later with no browser), then flips the broadcast
// to status='scheduled' with scheduled_at set.
//
// Body: { scheduled_at: ISO-8601 string }  (must be in the future)
//
// DELETE /api/whatsapp/broadcast/[id]/schedule
//   Cancel a schedule: delete the materialized recipients and revert the
//   broadcast to 'draft'.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  materializeBroadcastRecipients,
  MaterializeError,
} from '@/lib/whatsapp/broadcast-materialize';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`broadcast-schedule:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const scheduledAtRaw = typeof body?.scheduled_at === 'string' ? body.scheduled_at : '';
    const scheduledAt = new Date(scheduledAtRaw);
    if (!scheduledAtRaw || Number.isNaN(scheduledAt.getTime())) {
      return NextResponse.json(
        { error: 'scheduled_at must be a valid ISO-8601 timestamp' },
        { status: 400 },
      );
    }
    // A small skew tolerance so "a minute from now" isn't rejected by
    // clock drift between the browser and server.
    if (scheduledAt.getTime() <= Date.now() - 30_000) {
      return NextResponse.json(
        { error: 'scheduled_at must be in the future' },
        { status: 400 },
      );
    }

    // Only a draft can be scheduled. A broadcast already sending/sent/
    // scheduled is not a draft and must not be re-materialized.
    const { data: bc, error: bcErr } = await supabase
      .from('broadcasts')
      .select('id, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (bcErr || !bc) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }
    if (bc.status !== 'draft') {
      return NextResponse.json(
        { error: `Only a draft can be scheduled (this one is '${bc.status}')` },
        { status: 409 },
      );
    }

    // Materialize recipients from the draft's audience + variables.
    try {
      await materializeBroadcastRecipients(supabase, accountId, id);
    } catch (err) {
      if (err instanceof MaterializeError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.code === 'not_found' ? 404 : 400 },
        );
      }
      throw err;
    }

    const { error: updErr } = await supabase
      .from('broadcasts')
      .update({
        status: 'scheduled',
        scheduled_at: scheduledAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      broadcast_id: id,
      scheduled_at: scheduledAt.toISOString(),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
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
    if (bc.status !== 'scheduled') {
      return NextResponse.json(
        { error: 'Only a scheduled broadcast can be unscheduled' },
        { status: 409 },
      );
    }

    // Drop the materialized recipients so the broadcast is a clean draft
    // again (a fresh schedule re-materializes from the current audience).
    await supabase.from('broadcast_recipients').delete().eq('broadcast_id', id);
    const { error: updErr } = await supabase
      .from('broadcasts')
      .update({
        status: 'draft',
        scheduled_at: null,
        total_recipients: 0,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId);
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, broadcast_id: id });
  } catch (error) {
    return toErrorResponse(error);
  }
}
