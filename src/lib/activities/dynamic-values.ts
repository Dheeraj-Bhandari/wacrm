// ============================================================
// Reminder dynamic-value resolution.
//
// A reminder can pull live data from the activity's linked contact,
// deal, and conversation into its WhatsApp template params and email
// placeholders. This module owns:
//
//   - the catalogue of available keys (REMINDER_DYNAMIC_KEYS),
//   - a pure resolver that turns a ReminderValueBag into a flat
//     string map keyed by ReminderDynamicKey,
//   - resolveParamSource() which interprets a WhatsApp variable spec
//     ("lead_name" | "=literal" | "literal") against that map,
//   - interpolateTemplate() for {{placeholder}} substitution in email
//     subject/body.
//
// Kept side-effect-free and separately unit-tested. The async job of
// loading the last N messages lives in the delivery path, not here.
// ============================================================

import type { ReminderDynamicKey } from '@/types';

export const REMINDER_DYNAMIC_KEYS: ReminderDynamicKey[] = [
  'lead_name',
  'lead_phone',
  'lead_email',
  'lead_company',
  'deal_title',
  'deal_value',
  'deal_stage',
  'last_messages',
  'activity_title',
  'activity_due',
  'activity_notes',
];

/**
 * Curated source tokens a reminder variable can map to. These are the
 * ONLY things offerable in the mapping UI — built-in dynamic keys plus
 * `tag_list` (comma-joined contact tags) and `custom:<field_id>` for an
 * account custom field. Anything else is treated as a literal.
 */
export type ReminderVariableSource =
  | ReminderDynamicKey
  | 'tag_list'
  | `custom:${string}`;

/** Static (non-custom-field) source tokens, for building pickers. */
export const REMINDER_VARIABLE_SOURCES: readonly string[] = [
  ...REMINDER_DYNAMIC_KEYS,
  'tag_list',
];

/** The raw inputs available to resolve dynamic values from. */
export interface ReminderValueBag {
  contact?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    company?: string | null;
  } | null;
  deal?: {
    title?: string | null;
    value?: number | null;
    currency?: string | null;
    stageName?: string | null;
  } | null;
  activity?: {
    title?: string | null;
    notes?: string | null;
    dueAt?: string | null;
  } | null;
  /** Pre-formatted recent-conversation summary (loaded by the caller). */
  lastMessages?: string | null;
  /** Contact tag names (resolved by the caller). */
  tags?: string[] | null;
  /** Custom field values keyed by custom_field_id (resolved by caller). */
  customFields?: Record<string, string> | null;
}

/**
 * Resolve every known dynamic key to a display string. Missing data
 * resolves to '' (never undefined) so template params are always
 * fillable and an email placeholder never renders literally.
 */
export function resolveDynamicValues(bag: ReminderValueBag): Record<ReminderDynamicKey, string> {
  const c = bag.contact ?? {};
  const d = bag.deal ?? {};
  const a = bag.activity ?? {};

  const dealValue =
    d.value != null && Number.isFinite(d.value)
      ? `${d.currency ?? ''}${d.value}`.trim()
      : '';

  return {
    lead_name: str(c.name) || str(c.phone),
    lead_phone: str(c.phone),
    lead_email: str(c.email),
    lead_company: str(c.company),
    deal_title: str(d.title),
    deal_value: dealValue,
    deal_stage: str(d.stageName),
    last_messages: str(bag.lastMessages),
    activity_title: str(a.title),
    activity_due: formatDue(a.dueAt),
    activity_notes: str(a.notes),
  };
}

/**
 * Resolve a curated source token to its value from the bag. Handles the
 * built-in dynamic keys, `tag_list`, and `custom:<id>`. Returns '' when
 * the source is unknown or has no value — callers apply the mapping's
 * default fallback.
 */
export function resolveSourceValue(
  source: string,
  resolved: Record<ReminderDynamicKey, string>,
  bag: ReminderValueBag,
): string {
  if (source === 'tag_list') return (bag.tags ?? []).join(', ');
  if (source.startsWith('custom:')) {
    const id = source.slice('custom:'.length);
    return str(bag.customFields?.[id]);
  }
  if ((REMINDER_DYNAMIC_KEYS as string[]).includes(source)) {
    return resolved[source as ReminderDynamicKey] ?? '';
  }
  return '';
}

/**
 * Interpret a single WhatsApp template variable spec against resolved
 * dynamic values:
 *   - a leading "=" forces a literal ("=Hello" → "Hello"),
 *   - an exact known dynamic key resolves to its value,
 *   - anything else is treated as a literal string.
 */
export function resolveParamSource(
  spec: string,
  resolved: Record<ReminderDynamicKey, string>,
): string {
  if (spec.startsWith('=')) return spec.slice(1);
  if ((REMINDER_DYNAMIC_KEYS as string[]).includes(spec)) {
    return resolved[spec as ReminderDynamicKey] ?? '';
  }
  return spec;
}

/**
 * Build the positional param array ({{1}}, {{2}}, …) for a WhatsApp
 * template from a `variables` map whose keys are the numeric index as a
 * string and whose values are param specs. Numeric-aware sort keeps
 * {{1}} before {{10}} — matching the broadcast + automation senders.
 */
export function resolveTemplateParams(
  variables: Record<string, string> | undefined,
  resolved: Record<ReminderDynamicKey, string>,
): string[] {
  if (!variables) return [];
  return Object.keys(variables)
    .sort((x, y) => {
      const nx = Number(x);
      const ny = Number(y);
      if (Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny;
      return x.localeCompare(y);
    })
    .map((k) => resolveParamSource(variables[k], resolved));
}

export interface MappedParam {
  index: number;
  value: string;
  /** True when the source resolved empty and the default was used. */
  usedDefault: boolean;
}

/**
 * Resolve the positional WhatsApp params from a variable MAP
 * ({ "1": {source, default}, … }) against the resolved values + bag.
 * `count` is how many params the template actually needs ({{1}}..{{count}});
 * missing indices resolve to '' / their default. Returns both the ordered
 * value array and per-index metadata (for "defaulted" warnings).
 */
export function resolveMappedParams(
  map: Record<string, { source?: string; default?: string }> | undefined,
  count: number,
  resolved: Record<ReminderDynamicKey, string>,
  bag: ReminderValueBag,
): { params: string[]; details: MappedParam[] } {
  const details: MappedParam[] = [];
  const params: string[] = [];
  for (let i = 1; i <= count; i++) {
    const m = map?.[String(i)];
    const source = m?.source ?? '';
    const fallback = m?.default ?? '';
    const raw = source ? resolveSourceValue(source, resolved, bag) : '';
    const value = raw !== '' ? raw : fallback;
    params.push(value);
    details.push({ index: i, value, usedDefault: raw === '' });
  }
  return { params, details };
}

/**
 * Substitute {{key}} placeholders in a string using resolved dynamic
 * values. Supports the built-in keys plus `tag_list` and `custom:<id>`
 * (if a bag is supplied). Unknown keys are left blank. Whitespace inside
 * the braces is tolerated: {{ lead_name }} works too.
 */
export function interpolateTemplate(
  input: string,
  resolved: Record<ReminderDynamicKey, string>,
  bag?: ReminderValueBag,
): string {
  // Token chars include ':' and '-' so custom:<uuid> (UUIDs contain
  // hyphens) and tag_list resolve, not just \w names.
  return input.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_, raw) => {
    const key = String(raw).trim();
    if ((REMINDER_DYNAMIC_KEYS as string[]).includes(key)) {
      return resolved[key as ReminderDynamicKey] ?? '';
    }
    if (bag && (key === 'tag_list' || key.startsWith('custom:'))) {
      return resolveSourceValue(key, resolved, bag);
    }
    return '';
  });
}

/**
 * Extract the distinct placeholder tokens used in a string, in order of
 * first appearance. Powers the Settings "map these variables" prompt +
 * the "unknown placeholder" warning for email templates.
 */
export function extractPlaceholders(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of input.matchAll(/\{\{\s*([\w.:-]+)\s*\}\}/g)) {
    const key = m[1].trim();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Highest positional index referenced in a WhatsApp template body
 * ({{1}}, {{2}}, …). 0 when the body has no variables.
 */
export function countTemplateVariables(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

function formatDue(dueAt?: string | null): string {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return '';
  // Stable, locale-neutral display: "2026-10-09 14:30 UTC". The UI can
  // reformat; reminders just need an unambiguous human string.
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
