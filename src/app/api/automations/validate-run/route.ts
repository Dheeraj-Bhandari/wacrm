// ============================================================
// POST /api/automations/validate-run
//
// n8n-style step-by-step validation of an automation against a test
// WhatsApp number. Static-validates the document, resolves/creates a
// sandbox contact for the test phone, then dry-runs the step tree and
// returns an ordered per-step report so the user can see exactly where
// a flow would break before activating it.
//
// Body:
//   { document?, automation_id?, test_phone, message_text?, live? }
//
// Exactly one of `document` or `automation_id` is required. `live`
// (default false) only lets SEND steps actually dispatch to the test
// number; mutating steps are always simulated.
//
// Requires the `agent` role — a live run puts real messages on a real
// phone, same gate as the manual engine entrypoint.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { loadStepsTree } from '@/lib/automations/steps-tree';
import {
  builderStepsToDocument,
  validateAutomationDocument,
  type AutomationDocStep,
  type AutomationDocument,
} from '@/lib/automations/document';
import { dryRunSteps } from '@/lib/automations/dry-run';
import { findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`automation-validate:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

    const testPhone = typeof body.test_phone === 'string' ? body.test_phone : '';
    const sanitized = parseInternationalPhone(testPhone);
    if (!sanitized) {
      return NextResponse.json(
        { error: 'test_phone must be an international number with a leading + and country code' },
        { status: 400 },
      );
    }
    const live = body.live === true;
    const messageText = typeof body.message_text === 'string' ? body.message_text : undefined;

    const admin = supabaseAdmin();

    // Resolve the steps either from a pasted document or an existing automation.
    let steps: AutomationDocStep[];
    if (body.document) {
      const issues = validateAutomationDocument(body.document, true);
      if (issues.length > 0) {
        return NextResponse.json({ valid: false, issues }, { status: 200 });
      }
      steps = (body.document as AutomationDocument).steps;
    } else if (typeof body.automation_id === 'string') {
      const { data: automation, error } = await admin
        .from('automations')
        .select('id')
        .eq('id', body.automation_id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (error || !automation) {
        return NextResponse.json({ error: 'Automation not found' }, { status: 404 });
      }
      const tree = await loadStepsTree(body.automation_id);
      steps = builderStepsToDocument(tree);
    } else {
      return NextResponse.json(
        { error: 'provide either document or automation_id' },
        { status: 400 },
      );
    }

    // Resolve/create the sandbox contact for the test number.
    const auditUserId = await resolveAuditUserId(admin, accountId);
    const { id: contactId } = await findOrCreateContact(admin, accountId, auditUserId, {
      phone: testPhone,
    });

    const results = await dryRunSteps({
      db: admin,
      accountId,
      contactId,
      messageText,
      live,
      steps,
    });

    const hasError = results.some((r) => r.status === 'error');
    return NextResponse.json({
      valid: !hasError,
      live,
      test_contact_id: contactId,
      results,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
