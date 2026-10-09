// ============================================================
// Step-by-step automation dry-run (n8n-style).
//
// Walks an AutomationDocument's step tree in order against a test
// contact and reports, per step, what WOULD happen — resolved message
// text, resolved template params, which condition branch is taken, how
// long a wait would be — without the live side effects. This lets a
// user validate a flow end to end before activating it, surfacing the
// exact step where something breaks (an empty template name, an invalid
// webhook URL, a condition that never matches), just like running a
// node chain in n8n.
//
// `live` is opt-in and conservative: when true, only SEND steps
// actually dispatch (to the test number); mutating steps (add_tag,
// create_deal, update_contact_field, …) are ALWAYS simulated so a dry
// run can never pollute real data. `wait` never suspends — it reports
// the delay and moves on.
//
// Runs server-side with an account-scoped client. Pure resolution
// (interpolation, param ordering) is shared with the engine's intent;
// condition evaluation does account-scoped reads through the client.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutomationDocStep } from './document';

export interface DryRunStepResult {
  /** 1-based position in the flattened walk order. */
  index: number;
  type: string;
  status: 'ok' | 'warn' | 'error' | 'skipped';
  detail: string;
}

export interface DryRunContext {
  accountId: string;
  contactId: string;
  /** Simulated inbound message text for interpolation / conditions. */
  messageText?: string;
  /** When true, send steps actually dispatch to the test number. */
  live: boolean;
}

export interface DryRunInput extends DryRunContext {
  steps: AutomationDocStep[];
  db: SupabaseClient;
}

/**
 * Interpolate {{message.text}} / {{vars.*}} placeholders. Mirrors the
 * engine's interpolate() so the preview matches a real run. Unknown
 * tokens resolve to ''.
 */
export function interpolatePreview(
  input: string,
  ctx: { messageText?: string; vars?: Record<string, unknown> },
): string {
  return String(input ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.');
    if (ns === 'message' && prop === 'text') return String(ctx.messageText ?? '');
    if (ns === 'vars' && prop) return String(ctx.vars?.[prop] ?? '');
    return '';
  });
}

/**
 * Walk the step tree, producing an ordered result list. Never throws;
 * a thrown resolver error becomes an 'error' row so the walk continues
 * (the UI shows the first break but can also show what follows).
 */
export async function dryRunSteps(input: DryRunInput): Promise<DryRunStepResult[]> {
  const results: DryRunStepResult[] = [];
  const counter = { n: 0 };
  await walk(input.steps, input, results, counter);
  return results;
}

async function walk(
  steps: AutomationDocStep[],
  input: DryRunInput,
  results: DryRunStepResult[],
  counter: { n: number },
): Promise<void> {
  for (const step of steps) {
    counter.n += 1;
    const index = counter.n;
    try {
      if (step.type === 'condition') {
        const taken = await evaluateConditionPreview(step.config ?? {}, input);
        results.push({
          index,
          type: 'condition',
          status: 'ok',
          detail: `branch = ${taken ? 'yes' : 'no'}`,
        });
        const branch = taken ? step.branches?.yes : step.branches?.no;
        await walk(branch ?? [], input, results, counter);
        continue;
      }

      const r = await simulateStep(step, input);
      results.push({ index, type: step.type, status: r.status, detail: r.detail });
    } catch (err) {
      results.push({
        index,
        type: step.type,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function simulateStep(
  step: AutomationDocStep,
  input: DryRunInput,
): Promise<{ status: DryRunStepResult['status']; detail: string }> {
  const cfg = step.config ?? {};
  switch (step.type) {
    case 'send_message': {
      const text = interpolatePreview(String(cfg.text ?? ''), { messageText: input.messageText });
      if (!text.trim()) return { status: 'error', detail: 'message text is empty' };
      if (input.live) {
        const sent = await liveSendText(input, text);
        return sent;
      }
      return { status: 'ok', detail: `would send: "${truncate(text)}"` };
    }
    case 'send_template': {
      const name = String(cfg.template_name ?? '');
      if (!name) return { status: 'error', detail: 'template name is required' };
      const vars = cfg.variables as Record<string, string> | undefined;
      const params = vars
        ? Object.keys(vars)
            .sort((a, b) => {
              const na = Number(a);
              const nb = Number(b);
              if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
              return a.localeCompare(b);
            })
            .map((k) => String(vars[k]))
        : [];
      if (input.live) {
        const sent = await liveSendTemplate(input, name, String(cfg.language ?? 'en_US'), params);
        return sent;
      }
      return {
        status: 'ok',
        detail: `would send template "${name}"${params.length ? ` with [${params.join(', ')}]` : ''}`,
      };
    }
    case 'send_buttons':
    case 'send_list':
      return { status: 'ok', detail: `would send interactive (${step.type})` };
    case 'wait': {
      const amount = Number(cfg.amount);
      const unit = String(cfg.unit ?? '');
      if (!Number.isFinite(amount) || amount <= 0) {
        return { status: 'error', detail: 'wait amount must be > 0' };
      }
      return { status: 'ok', detail: `would wait ${amount} ${unit} (not simulated in dry run)` };
    }
    case 'add_tag':
    case 'remove_tag': {
      if (!cfg.tag_id) return { status: 'error', detail: 'tag is required' };
      return { status: 'ok', detail: `would ${step.type === 'add_tag' ? 'add' : 'remove'} tag ${cfg.tag_id}` };
    }
    case 'assign_conversation':
      return { status: 'ok', detail: `would assign (${cfg.mode ?? 'round_robin'})` };
    case 'update_contact_field': {
      if (!cfg.field) return { status: 'error', detail: 'field is required' };
      const value = interpolatePreview(String(cfg.value ?? ''), { messageText: input.messageText });
      return { status: 'ok', detail: `would set ${cfg.field} = "${truncate(value)}"` };
    }
    case 'create_deal': {
      if (!cfg.pipeline_id || !cfg.stage_id) {
        return { status: 'error', detail: 'pipeline and stage are required' };
      }
      return { status: 'ok', detail: `would create deal "${cfg.title ?? ''}"` };
    }
    case 'send_webhook': {
      const url = String(cfg.url ?? '');
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { status: 'error', detail: 'webhook URL must be http(s)' };
        }
      } catch {
        return { status: 'error', detail: 'webhook URL is not valid' };
      }
      return { status: 'ok', detail: `would POST to ${url}` };
    }
    case 'close_conversation':
      return { status: 'ok', detail: 'would close the conversation' };
    default:
      return { status: 'error', detail: `unknown step type: ${step.type}` };
  }
}

// ------------------------------------------------------------
// Condition evaluation (account-scoped reads; mirrors engine.ts)
// ------------------------------------------------------------

async function evaluateConditionPreview(
  cfg: Record<string, unknown>,
  input: DryRunInput,
): Promise<boolean> {
  const subject = String(cfg.subject ?? '');
  switch (subject) {
    case 'tag_presence': {
      const operand = cfg.operand as string | undefined;
      if (!operand) return false;
      const { count } = await input.db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', input.contactId)
        .eq('tag_id', operand);
      return (count ?? 0) > 0;
    }
    case 'contact_field': {
      const operand = cfg.operand as string | undefined;
      if (!operand) return false;
      const { data } = await input.db
        .from('contacts')
        .select(operand)
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle();
      const v = (data as Record<string, unknown> | null)?.[operand];
      return v != null && String(v) === String(cfg.value ?? '');
    }
    case 'message_content': {
      const text = (input.messageText ?? '').toLowerCase();
      return text.includes(String(cfg.value ?? '').toLowerCase());
    }
    case 'time_of_day': {
      const [from, to] = String(cfg.operand ?? '').split('-');
      if (!from || !to) return false;
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
    }
    default:
      return false;
  }
}

// ------------------------------------------------------------
// Live send (opt-in). Reuses the engine send path against the test
// contact's own conversation.
// ------------------------------------------------------------

async function resolveTestConversationId(input: DryRunInput): Promise<string | null> {
  const { data } = await input.db
    .from('conversations')
    .select('id')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function liveSendText(
  input: DryRunInput,
  text: string,
): Promise<{ status: DryRunStepResult['status']; detail: string }> {
  const conversationId = await resolveTestConversationId(input);
  if (!conversationId) {
    return { status: 'warn', detail: 'no conversation for the test number yet; simulated instead' };
  }
  const { engineSendText } = await import('./meta-send');
  const { whatsapp_message_id } = await engineSendText({
    accountId: input.accountId,
    userId: await resolveAnyUser(input),
    conversationId,
    contactId: input.contactId,
    text,
  });
  return { status: 'ok', detail: `sent live (${whatsapp_message_id})` };
}

async function liveSendTemplate(
  input: DryRunInput,
  templateName: string,
  language: string,
  params: string[],
): Promise<{ status: DryRunStepResult['status']; detail: string }> {
  const conversationId = await resolveTestConversationId(input);
  if (!conversationId) {
    return { status: 'warn', detail: 'no conversation for the test number yet; simulated instead' };
  }
  const { engineSendTemplate } = await import('./meta-send');
  const { whatsapp_message_id } = await engineSendTemplate({
    accountId: input.accountId,
    userId: await resolveAnyUser(input),
    conversationId,
    contactId: input.contactId,
    templateName,
    language,
    params,
  });
  return { status: 'ok', detail: `template sent live (${whatsapp_message_id})` };
}

/** Any account member's user_id, for the audit column on a live send. */
async function resolveAnyUser(input: DryRunInput): Promise<string> {
  const { data } = await input.db
    .from('profiles')
    .select('user_id')
    .eq('account_id', input.accountId)
    .limit(1)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? '';
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
