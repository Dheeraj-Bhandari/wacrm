// ============================================================
// Client-side activity helpers.
//
// The inbox, dashboard, and the dedicated Activities section all create
// and mutate activities through the browser Supabase client (RLS-scoped,
// same architecture as contacts/deals/notes). These helpers keep the
// insert/update shapes and the "effective status" computation in one
// place so every surface behaves identically.
// ============================================================

import type { Activity, ActivityStatus, ActivityType, ReminderConfig } from '@/types';

/** Activity types offered in the inbox composer, in display order. */
export const ACTIVITY_TYPES: ActivityType[] = [
  'call',
  'whatsapp_message',
  'meeting',
  'task',
  'reminder',
];

export interface NewActivityInput {
  account_id: string;
  user_id: string;
  contact_id?: string | null;
  conversation_id?: string | null;
  deal_id?: string | null;
  type: ActivityType;
  title: string;
  notes?: string | null;
  /** ISO instant. */
  due_at: string;
  /** ISO instant; defaults to due_at minus the lead time when a reminder is requested. */
  remind_at?: string | null;
  reminder_config?: ReminderConfig | null;
  /**
   * Minutes before due_at to fire the reminder (from the account's
   * reminder_settings). Applied only when a reminder is requested and no
   * explicit remind_at was given. 0 = at due time.
   */
  leadTimeMinutes?: number;
}

/**
 * Compute the reminder instant for an activity: `due_at` shifted earlier
 * by `leadTimeMinutes`. Exported so the UI can preview "will remind at …".
 */
export function computeRemindAt(dueAtIso: string, leadTimeMinutes = 0): string {
  const due = new Date(dueAtIso).getTime();
  const ms = Math.max(0, leadTimeMinutes) * 60_000;
  return new Date(due - ms).toISOString();
}

/**
 * Normalise a composer form into an `activities` insert row. When a
 * reminder is requested but no explicit remind_at is given, it defaults
 * to due_at minus the account lead time. A null reminder_config means
 * "to-do only, no auto-send".
 */
export function buildActivityInsert(input: NewActivityInput): Record<string, unknown> {
  const wantsReminder = input.reminder_config != null;
  const defaultRemindAt = wantsReminder
    ? computeRemindAt(input.due_at, input.leadTimeMinutes ?? 0)
    : null;
  return {
    account_id: input.account_id,
    user_id: input.user_id,
    contact_id: input.contact_id ?? null,
    conversation_id: input.conversation_id ?? null,
    deal_id: input.deal_id ?? null,
    type: input.type,
    title: input.title.trim(),
    notes: input.notes?.trim() || null,
    due_at: input.due_at,
    remind_at: wantsReminder ? (input.remind_at ?? defaultRemindAt) : (input.remind_at ?? null),
    reminder_config: input.reminder_config ?? null,
    status: 'pending' as const,
  };
}

/**
 * The status to show in the UI. The scheduler flips pending→overdue
 * server-side, but between cron ticks a client can compute it locally so
 * a just-passed due time reads correctly without waiting for the sweep.
 */
export function effectiveStatus(activity: Pick<Activity, 'status' | 'due_at'>, now = new Date()): ActivityStatus {
  if (activity.status === 'pending' && new Date(activity.due_at) < now) {
    return 'overdue';
  }
  return activity.status;
}

/** True when the activity is still actionable (not done/cancelled). */
export function isOpen(status: ActivityStatus): boolean {
  return status === 'pending' || status === 'overdue';
}

/** Quick-reschedule presets offered as one-click snooze buttons. */
export type SnoozePreset = '5m' | '15m' | '30m' | '1h' | 'tomorrow';

export const SNOOZE_PRESETS: SnoozePreset[] = ['5m', '15m', '30m', '1h', 'tomorrow'];

/**
 * Compute a new due instant for a snooze preset. `5m`/`15m`/`30m`/`1h`
 * are relative to now; `tomorrow` is 9:00 AM local the next day.
 */
export function snoozeDueAt(preset: SnoozePreset, now = new Date()): string {
  const d = new Date(now);
  switch (preset) {
    case '5m':
      d.setMinutes(d.getMinutes() + 5);
      break;
    case '15m':
      d.setMinutes(d.getMinutes() + 15);
      break;
    case '30m':
      d.setMinutes(d.getMinutes() + 30);
      break;
    case '1h':
      d.setHours(d.getHours() + 1);
      break;
    case 'tomorrow':
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      break;
  }
  return d.toISOString();
}

/**
 * The DB patch to reschedule an activity to a new due time: re-arms the
 * reminder so every configured lead-time offset fires again, clears the
 * prior send/error state, and reopens the activity. Shared by the
 * Activities list, the inbox composer, the dashboard agenda, and the
 * reminder popup so "reschedule" behaves identically everywhere.
 */
export function rescheduleUpdate(dueAtIso: string): Record<string, unknown> {
  return {
    due_at: dueAtIso,
    remind_at: dueAtIso,
    status: 'pending' as const,
    reminder_fired_at: null,
    reminder_fired_offsets: [],
    reminder_whatsapp_sent_at: null,
    reminder_email_sent_at: null,
    reminder_error: null,
    completed_at: null,
  };
}
