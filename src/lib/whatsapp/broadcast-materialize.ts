// ============================================================
// Server-side broadcast materialization.
//
// A broadcast "draft" persists only its audience_filter + template_
// variables (broadcasts/new wizard, handleSaveDraft) — no recipient
// rows. The dashboard wizard resolves the audience and inserts
// recipients in the browser; a scheduled or start-from-draft send has
// no browser, so this module reproduces that resolution server-side:
//
//   1. resolve the audience_filter to a set of contacts,
//   2. resolve template_variables to frozen positional params per
//      contact (so a later cron send reconstructs {{1}} without the
//      wizard's state),
//   3. insert broadcast_recipients rows and set total_recipients.
//
// Mirrors the client resolveAudience / resolveVariables logic in
// use-broadcast-sending.ts. CSV audiences are intentionally NOT
// supported here: a draft never persists the raw CSV rows, so there is
// nothing to resolve — such a broadcast must be sent from the wizard.
//
// account_id scoping: every query is filtered by account_id. Callers
// pass either the RLS-scoped SSR client (endpoints) or the service-role
// client (cron) — both are safe because the explicit account filter
// never widens past the tenant.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contact } from '@/types';

/** Stored audience filter shape (broadcasts.audience_filter). */
export interface StoredAudienceFilter {
  type?: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  excludeTagIds?: string[];
}

/** Stored variable mapping shape (broadcasts.template_variables). */
type StoredVariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

export class MaterializeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MaterializeError';
    this.code = code;
  }
}

export interface MaterializeResult {
  inserted: number;
}

const INSERT_BATCH = 200;

/**
 * Resolve a draft broadcast's audience + variables and insert its
 * recipient rows. Idempotent-ish: throws `already_materialized` if the
 * broadcast already has recipients, so callers never double-insert.
 */
export async function materializeBroadcastRecipients(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
): Promise<MaterializeResult> {
  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .select('id, audience_filter, template_variables, status')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (bErr || !broadcast) {
    throw new MaterializeError('not_found', 'Broadcast not found');
  }

  // Guard against double materialization (e.g. schedule then start).
  const { count: existing } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);
  if ((existing ?? 0) > 0) {
    throw new MaterializeError(
      'already_materialized',
      'This broadcast already has recipients',
    );
  }

  const filter = (broadcast.audience_filter ?? {}) as StoredAudienceFilter;
  if (filter.type === 'csv') {
    throw new MaterializeError(
      'csv_unsupported',
      'CSV audiences must be sent from the broadcast wizard, not scheduled from a draft',
    );
  }

  const contacts = await resolveAudience(db, accountId, filter);
  if (contacts.length === 0) {
    throw new MaterializeError('empty_audience', 'This audience matched no contacts');
  }

  const variables = (broadcast.template_variables ?? {}) as Record<
    string,
    StoredVariableMapping
  >;
  const customIndex = await fetchCustomValueIndex(
    db,
    contacts.map((c) => c.id),
  );
  const paramsByContact = new Map(
    contacts.map((c) => [c.id, resolveVariables(variables, c, customIndex.get(c.id))]),
  );

  const rows = contacts.map((c) => ({
    broadcast_id: broadcastId,
    contact_id: c.id,
    status: 'pending' as const,
    template_params: paramsByContact.get(c.id) ?? [],
  }));

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const { error: insErr } = await db.from('broadcast_recipients').insert(batch);
    if (insErr) {
      throw new MaterializeError(
        'insert_failed',
        `Failed to insert recipients: ${insErr.message}`,
      );
    }
  }

  // total_recipients is a plain column (not trigger-owned like the
  // per-status counts), so set it here to match the materialized set.
  await db
    .from('broadcasts')
    .update({ total_recipients: contacts.length, updated_at: new Date().toISOString() })
    .eq('id', broadcastId);

  return { inserted: contacts.length };
}

// ------------------------------------------------------------
// Audience resolution (server port of use-broadcast-sending.ts)
// ------------------------------------------------------------

async function resolveAudience(
  db: SupabaseClient,
  accountId: string,
  filter: StoredAudienceFilter,
): Promise<Contact[]> {
  let contacts: Contact[] = [];

  if (!filter.type || filter.type === 'all') {
    const { data } = await db.from('contacts').select('*').eq('account_id', accountId);
    contacts = (data ?? []) as Contact[];
  } else if (filter.type === 'tags' && filter.tagIds && filter.tagIds.length > 0) {
    const { data: ct } = await db
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', filter.tagIds);
    const ids = [...new Set((ct ?? []).map((r) => r.contact_id))];
    if (ids.length > 0) {
      const { data } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .in('id', ids);
      contacts = (data ?? []) as Contact[];
    }
  } else if (filter.type === 'custom_field' && filter.customField) {
    contacts = await resolveCustomFieldAudience(db, accountId, filter.customField);
  }

  // Exclude tags (contact-derived audiences only).
  if (filter.excludeTagIds && filter.excludeTagIds.length > 0 && contacts.length > 0) {
    const { data: ex } = await db
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', filter.excludeTagIds);
    const excluded = new Set((ex ?? []).map((r) => r.contact_id));
    contacts = contacts.filter((c) => !excluded.has(c.id));
  }

  return contacts;
}

async function resolveCustomFieldAudience(
  db: SupabaseClient,
  accountId: string,
  filter: NonNullable<StoredAudienceFilter['customField']>,
): Promise<Contact[]> {
  let query = db
    .from('contact_custom_values')
    .select('contact_id')
    .eq('custom_field_id', filter.fieldId);
  if (filter.operator === 'is') query = query.eq('value', filter.value);
  else if (filter.operator === 'is_not') query = query.neq('value', filter.value);
  else if (filter.operator === 'contains') query = query.ilike('value', `%${filter.value}%`);

  const { data: matches } = await query;
  const ids = [...new Set((matches ?? []).map((m) => m.contact_id))];
  if (ids.length === 0) return [];

  const { data } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .in('id', ids);
  return (data ?? []) as Contact[];
}

// ------------------------------------------------------------
// Variable resolution (server port)
// ------------------------------------------------------------

type CustomValueIndex = Map<string, Map<string, string>>;

export function resolveVariables(
  variables: Record<string, StoredVariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;
    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }
    return customValues?.get(v.value) ?? '';
  });
}

async function fetchCustomValueIndex(
  db: SupabaseClient,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await db
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);
    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}
