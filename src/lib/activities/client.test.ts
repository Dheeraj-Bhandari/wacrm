import { describe, it, expect } from 'vitest';
import { buildActivityInsert, computeRemindAt, effectiveStatus, isOpen } from './client';
import type { Activity } from '@/types';

describe('buildActivityInsert', () => {
  const base = {
    account_id: 'acc',
    user_id: 'usr',
    contact_id: 'c1',
    type: 'call' as const,
    title: '  Ring Jane  ',
    due_at: '2026-10-10T10:00:00.000Z',
  };

  it('trims title/notes and defaults links to null', () => {
    const row = buildActivityInsert(base);
    expect(row.title).toBe('Ring Jane');
    expect(row.conversation_id).toBeNull();
    expect(row.deal_id).toBeNull();
    expect(row.status).toBe('pending');
  });

  it('defaults remind_at to due_at when a reminder is requested', () => {
    const row = buildActivityInsert({ ...base, reminder_config: {} });
    expect(row.remind_at).toBe(base.due_at);
    expect(row.reminder_config).toEqual({});
  });

  it('leaves remind_at null for a plain to-do', () => {
    const row = buildActivityInsert(base);
    expect(row.remind_at).toBeNull();
    expect(row.reminder_config).toBeNull();
  });

  it('honours an explicit remind_at over the lead-time default', () => {
    const row = buildActivityInsert({
      ...base,
      reminder_config: {},
      remind_at: '2026-10-10T09:30:00.000Z',
      leadTimeMinutes: 25,
    });
    expect(row.remind_at).toBe('2026-10-10T09:30:00.000Z');
  });

  it('subtracts the lead time from due_at for the default remind_at', () => {
    const row = buildActivityInsert({ ...base, reminder_config: {}, leadTimeMinutes: 25 });
    // 10:00 due - 25 min = 09:35
    expect(row.remind_at).toBe('2026-10-10T09:35:00.000Z');
  });
});

describe('computeRemindAt', () => {
  it('shifts the instant earlier by the lead time', () => {
    expect(computeRemindAt('2026-10-10T10:00:00.000Z', 25)).toBe('2026-10-10T09:35:00.000Z');
  });

  it('returns due_at unchanged for 0 lead time', () => {
    expect(computeRemindAt('2026-10-10T10:00:00.000Z', 0)).toBe('2026-10-10T10:00:00.000Z');
  });

  it('clamps negative lead times to 0', () => {
    expect(computeRemindAt('2026-10-10T10:00:00.000Z', -5)).toBe('2026-10-10T10:00:00.000Z');
  });
});

describe('effectiveStatus', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const mk = (status: Activity['status'], due: string): Pick<Activity, 'status' | 'due_at'> => ({
    status,
    due_at: due,
  });

  it('reports a past-due pending activity as overdue', () => {
    expect(effectiveStatus(mk('pending', '2026-10-10T11:00:00.000Z'), now)).toBe('overdue');
  });

  it('leaves a future pending activity pending', () => {
    expect(effectiveStatus(mk('pending', '2026-10-10T13:00:00.000Z'), now)).toBe('pending');
  });

  it('never reclassifies a done/cancelled activity', () => {
    expect(effectiveStatus(mk('done', '2026-10-10T11:00:00.000Z'), now)).toBe('done');
    expect(effectiveStatus(mk('cancelled', '2026-10-10T11:00:00.000Z'), now)).toBe('cancelled');
  });
});

describe('isOpen', () => {
  it('treats pending and overdue as open', () => {
    expect(isOpen('pending')).toBe(true);
    expect(isOpen('overdue')).toBe(true);
    expect(isOpen('done')).toBe(false);
    expect(isOpen('cancelled')).toBe(false);
  });
});
