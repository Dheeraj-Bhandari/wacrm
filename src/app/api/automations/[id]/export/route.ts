// ============================================================
// GET /api/automations/[id]/export
//
// Return a portable AutomationDocument (JSON) for an automation — the
// shape the "Import JSON" dialog and the examples use. Account-scoped
// read; any member may export (mirrors the automations_select policy).
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { loadStepsTree } from '@/lib/automations/steps-tree';
import { toAutomationDocument } from '@/lib/automations/document';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { accountId } = await getCurrentAccount();
    const { id } = await params;

    const admin = supabaseAdmin();
    const { data: automation, error } = await admin
      .from('automations')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error || !automation) {
      return NextResponse.json({ error: 'Automation not found' }, { status: 404 });
    }

    const stepTree = await loadStepsTree(id);
    const document = toAutomationDocument(automation, stepTree);

    return NextResponse.json({ document });
  } catch (error) {
    return toErrorResponse(error);
  }
}
