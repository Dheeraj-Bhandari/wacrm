// ============================================================
// Reminder delivery.
//
// Given a due `activities` row (already claimed by the scheduler), this
// resolves its dynamic values from the linked contact / deal /
// conversation and delivers the reminder over the channels configured
// on the row's `reminder_config` (falling back to the account's
// `reminder_settings` defaults). WhatsApp and email are independent:
// one failing never blocks the other, and both failing never throws —
// the result object carries per-channel outcomes so the scheduler can
// record `reminder_error` and move on.
//
// Runs server-side with the service-role client only (the scheduler has
// no user session). Account scoping is enforced by always reading the
// account_id off the activity row and querying within it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Activity,
  ReminderConfig,
  ReminderSettings,
} from '@/types';
import {
  resolveDynamicValues,
  resolveTemplateParams,
  resolveMappedParams,
  countTemplateVariables,
  interpolateTemplate,
  type ReminderValueBag,
} from './dynamic-values';
import { sendEmail } from '@/lib/email/send';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

/** How many recent messages to summarise for the `last_messages` key. */
const LAST_MESSAGES_LIMIT = 5;

export interface ChannelOutcome {
  attempted: boolean;
  ok: boolean;
  detail: string;
}

export interface ReminderDeliveryResult {
  whatsapp: ChannelOutcome;
  email: ChannelOutcome;
  /** True if at least one channel was attempted and all attempted succeeded. */
  ok: boolean;
  /** Combined error string for `reminder_error`, or null when fully ok. */
  error: string | null;
  /** ISO timestamp the WhatsApp reminder was sent, or null if not sent. */
  whatsappSentAt: string | null;
  /** ISO timestamp the email reminder was sent, or null if not sent. */
  emailSentAt: string | null;
}

const SKIPPED: ChannelOutcome = { attempted: false, ok: true, detail: 'not configured' };

/**
 * Deliver a single activity's reminder. Never throws.
 */
export async function deliverReminder(
  db: SupabaseClient,
  activity: Activity,
): Promise<ReminderDeliveryResult> {
  // Merge per-activity config with the account defaults.
  const settings = await loadReminderSettings(db, activity.account_id);
  const config = activity.reminder_config ?? {};

  const bag = await buildValueBag(db, activity);
  const resolved = resolveDynamicValues(bag);

  const whatsapp = await deliverWhatsApp(db, activity, config, settings, resolved, bag);
  const email = await deliverEmail(db, activity, config, settings, resolved, bag);

  const attemptedChannels = [whatsapp, email].filter((c) => c.attempted);
  const failures = attemptedChannels.filter((c) => !c.ok);
  const nowIso = new Date().toISOString();

  // Also drop an in-app notification for the owner so the reminder shows
  // in the bell regardless of channel outcome. Best-effort.
  await writeNotification(db, activity, resolved).catch(() => {});

  return {
    whatsapp,
    email,
    ok: attemptedChannels.length > 0 && failures.length === 0,
    error:
      failures.length > 0
        ? failures
            .map((c) => (c === whatsapp ? `whatsapp: ${c.detail}` : `email: ${c.detail}`))
            .join('; ')
        : attemptedChannels.length === 0
          ? 'no reminder channel configured'
          : null,
    whatsappSentAt: whatsapp.attempted && whatsapp.ok ? nowIso : null,
    emailSentAt: email.attempted && email.ok ? nowIso : null,
  };
}

// ------------------------------------------------------------
// Channels
// ------------------------------------------------------------

async function deliverWhatsApp(
  db: SupabaseClient,
  activity: Activity,
  config: ReminderConfig,
  settings: ReminderSettings | null,
  resolved: Record<string, string>,
  bag: ReminderValueBag,
): Promise<ChannelOutcome> {
  const wa = config.whatsapp;
  // A reminder uses WhatsApp when the activity opts in (has wa config) OR
  // the account has WhatsApp reminders enabled with a default template.
  const templateName =
    wa?.template_name || (settings?.whatsapp_enabled ? settings?.default_whatsapp_template : null);
  if (!templateName) return SKIPPED;

  const to = (wa?.to || settings?.notify_whatsapp_number || '').trim();
  if (!to) return { attempted: true, ok: false, detail: 'no recipient number configured' };

  const sanitized = sanitizePhoneForMeta(to);
  if (!isValidE164(sanitized)) {
    return { attempted: true, ok: false, detail: `invalid recipient number: ${to}` };
  }

  const { data: cfg, error: cfgErr } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', activity.account_id)
    .maybeSingle();
  if (cfgErr || !cfg) {
    return { attempted: true, ok: false, detail: 'WhatsApp not configured for this account' };
  }

  // Resolve the template's ACTUAL approved language + body rather than
  // trusting the language saved on reminder_settings — those drift (a
  // user picks "en" while Meta approved the template as "en_US"), which
  // Meta rejects with (#132001) "Template name does not exist in the
  // translation". Look the row up by name; prefer an explicit
  // per-reminder language, then the real stored language, then the saved
  // default, then en_US.
  const { data: tmplRow } = await db
    .from('message_templates')
    .select('language, status, body_text')
    .eq('account_id', activity.account_id)
    .eq('name', templateName)
    .order('status', { ascending: true }) // deterministic if duplicates
    .limit(1)
    .maybeSingle();

  const language =
    wa?.language ||
    (tmplRow?.language as string | undefined) ||
    settings?.default_whatsapp_language ||
    'en_US';

  // Params: prefer the account's variable MAP (positional {{1}}..{{n}}
  // each mapped to a curated source + default). Fall back to any legacy
  // per-reminder `variables` spec. The template body determines how many
  // params Meta expects — sending the wrong count is a hard reject.
  const count = countTemplateVariables(String(tmplRow?.body_text ?? ''));
  let params: string[];
  if (count > 0 && settings?.whatsapp_variable_map) {
    params = resolveMappedParams(
      settings.whatsapp_variable_map,
      count,
      resolved as never,
      bag,
    ).params;
  } else {
    params = resolveTemplateParams(wa?.variables, resolved as never);
  }

  try {
    const r = await sendTemplateMessage({
      phoneNumberId: cfg.phone_number_id as string,
      accessToken: decrypt(cfg.access_token as string),
      to: sanitized,
      templateName,
      language,
      params,
    });
    return { attempted: true, ok: true, detail: `sent (${r.messageId})` };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function deliverEmail(
  db: SupabaseClient,
  activity: Activity,
  config: ReminderConfig,
  settings: ReminderSettings | null,
  resolved: Record<string, string>,
  bag: ReminderValueBag,
): Promise<ChannelOutcome> {
  const em = config.email;
  const templateId =
    em?.template_id || (settings?.email_enabled ? settings?.default_email_template_id : null);
  if (!templateId) return SKIPPED;

  const to = (em?.to || settings?.notify_email || '').trim();
  if (!to) return { attempted: true, ok: false, detail: 'no recipient email configured' };

  const { data: tmpl, error: tmplErr } = await db
    .from('email_templates')
    .select('subject, body_html, body_text')
    .eq('id', templateId)
    .eq('account_id', activity.account_id)
    .maybeSingle();
  if (tmplErr || !tmpl) {
    return { attempted: true, ok: false, detail: 'email template not found' };
  }

  const subject = interpolateTemplate(String(tmpl.subject ?? ''), resolved as never, bag);
  const html = interpolateTemplate(String(tmpl.body_html ?? ''), resolved as never, bag);
  const text = tmpl.body_text
    ? interpolateTemplate(String(tmpl.body_text), resolved as never, bag)
    : undefined;

  const result = await sendEmail({ to, subject, html, text });
  if (result.ok) return { attempted: true, ok: true, detail: `sent (${result.id ?? 'ok'})` };
  // A soft skip (transport not configured) is reported but not treated
  // as a hard failure of the channel the user asked for — surface it.
  return { attempted: true, ok: false, detail: result.error };
}

// ------------------------------------------------------------
// Data gathering
// ------------------------------------------------------------

async function buildValueBag(
  db: SupabaseClient,
  activity: Activity,
): Promise<ReminderValueBag> {
  const bag: ReminderValueBag = {
    activity: {
      title: activity.title,
      notes: activity.notes ?? null,
      dueAt: activity.due_at,
    },
  };

  if (activity.contact_id) {
    const { data: contact } = await db
      .from('contacts')
      .select('name, phone, email, company')
      .eq('id', activity.contact_id)
      .eq('account_id', activity.account_id)
      .maybeSingle();
    if (contact) {
      bag.contact = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
    }

    // Tags (names) for the `tag_list` source.
    const { data: tagRows } = await db
      .from('contact_tags')
      .select('tags(name)')
      .eq('contact_id', activity.contact_id);
    bag.tags = (tagRows ?? [])
      .map((r) => {
        const tg = (r as { tags?: { name?: string } | { name?: string }[] | null }).tags;
        const t = Array.isArray(tg) ? tg[0] : tg;
        return t?.name ?? null;
      })
      .filter((n): n is string => !!n);

    // Custom field values keyed by custom_field_id for `custom:<id>`.
    const { data: cvRows } = await db
      .from('contact_custom_values')
      .select('custom_field_id, value')
      .eq('contact_id', activity.contact_id);
    const customFields: Record<string, string> = {};
    for (const r of (cvRows ?? []) as { custom_field_id: string; value: string | null }[]) {
      customFields[r.custom_field_id] = r.value ?? '';
    }
    bag.customFields = customFields;
  }

  if (activity.deal_id) {
    const { data: deal } = await db
      .from('deals')
      .select('title, value, currency, stage:pipeline_stages(name)')
      .eq('id', activity.deal_id)
      .eq('account_id', activity.account_id)
      .maybeSingle();
    if (deal) {
      const stage = Array.isArray(deal.stage) ? deal.stage[0] : deal.stage;
      bag.deal = {
        title: deal.title,
        value: deal.value,
        currency: deal.currency,
        stageName: (stage as { name?: string } | null)?.name ?? null,
      };
    }
  }

  // last_messages summary — only load when there's a conversation to
  // read, to keep the common (no-conversation) reminder cheap.
  if (activity.conversation_id) {
    bag.lastMessages = await loadLastMessages(db, activity.conversation_id);
  }

  return bag;
}

async function loadLastMessages(
  db: SupabaseClient,
  conversationId: string,
): Promise<string> {
  const { data } = await db
    .from('messages')
    .select('sender_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(LAST_MESSAGES_LIMIT);
  const rows = (data ?? []) as {
    sender_type: string;
    content_text: string | null;
  }[];
  // Oldest-first for a natural read, prefixed by direction.
  return rows
    .reverse()
    .map((m) => {
      const who = m.sender_type === 'customer' ? 'Them' : 'Us';
      const text = (m.content_text ?? '').trim();
      return text ? `${who}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

async function loadReminderSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<ReminderSettings | null> {
  const { data } = await db
    .from('reminder_settings')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as ReminderSettings | null) ?? null;
}

async function writeNotification(
  db: SupabaseClient,
  activity: Activity,
  resolved: Record<string, string>,
): Promise<void> {
  // Deliver to the activity's owner (assigned_to's user, or the author).
  // assigned_to references profiles(id); resolve its user_id.
  let recipientUserId = activity.user_id;
  if (activity.assigned_to) {
    const { data: prof } = await db
      .from('profiles')
      .select('user_id')
      .eq('id', activity.assigned_to)
      .eq('account_id', activity.account_id)
      .maybeSingle();
    if (prof?.user_id) recipientUserId = prof.user_id as string;
  }

  const lead = resolved.lead_name || resolved.lead_phone || '';
  await db.from('notifications').insert({
    account_id: activity.account_id,
    user_id: recipientUserId,
    type: 'reminder',
    contact_id: activity.contact_id,
    conversation_id: activity.conversation_id ?? null,
    title: `Reminder: ${activity.title}`,
    body: lead ? `For ${lead}` : null,
  });
}
