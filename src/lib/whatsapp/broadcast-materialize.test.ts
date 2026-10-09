import { describe, it, expect } from 'vitest';
import { resolveVariables } from './broadcast-materialize';
import type { Contact } from '@/types';

const contact = {
  id: 'c1',
  user_id: 'u1',
  account_id: 'a1',
  phone: '+15550102030',
  name: 'Jane',
  email: 'jane@acme.com',
  company: 'Acme',
  created_at: '',
  updated_at: '',
} as Contact;

describe('resolveVariables (server broadcast materialization)', () => {
  it('resolves static, field, and custom_field mappings', () => {
    const custom = new Map([['field-x', 'VIP']]);
    const out = resolveVariables(
      {
        '1': { type: 'field', value: 'name' },
        '2': { type: 'static', value: 'hello' },
        '3': { type: 'custom_field', value: 'field-x' },
      },
      contact,
      custom,
    );
    expect(out).toEqual(['Jane', 'hello', 'VIP']);
  });

  it('orders params numerically so {{10}} follows {{2}}', () => {
    const out = resolveVariables(
      {
        '1': { type: 'static', value: 'a' },
        '2': { type: 'static', value: 'b' },
        '10': { type: 'static', value: 'j' },
      },
      contact,
    );
    expect(out).toEqual(['a', 'b', 'j']);
  });

  it('blanks a missing custom value rather than emitting undefined', () => {
    const out = resolveVariables(
      { '1': { type: 'custom_field', value: 'absent' } },
      contact,
    );
    expect(out).toEqual(['']);
  });

  it('blanks an unknown built-in field', () => {
    const out = resolveVariables(
      { '1': { type: 'field', value: 'nope' } },
      contact,
    );
    expect(out).toEqual(['']);
  });
});
