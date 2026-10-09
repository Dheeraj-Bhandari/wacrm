import { describe, it, expect } from 'vitest';
import {
  resolveDynamicValues,
  resolveParamSource,
  resolveTemplateParams,
  resolveSourceValue,
  resolveMappedParams,
  countTemplateVariables,
  extractPlaceholders,
  interpolateTemplate,
  type ReminderValueBag,
} from './dynamic-values';

const bag: ReminderValueBag = {
  contact: { name: 'Aabid', phone: '+15550001111', email: 'a@x.com', company: 'Acme' },
  deal: { title: 'Big deal', value: 1200, currency: '$', stageName: 'Negotiation' },
  activity: { title: 'Call back', notes: 'ring at noon', dueAt: '2026-10-09T14:30:00.000Z' },
  lastMessages: 'Them: hi\nUs: hello',
};

describe('resolveDynamicValues', () => {
  it('maps every key from a fully-populated bag', () => {
    const r = resolveDynamicValues(bag);
    expect(r.lead_name).toBe('Aabid');
    expect(r.lead_phone).toBe('+15550001111');
    expect(r.lead_email).toBe('a@x.com');
    expect(r.lead_company).toBe('Acme');
    expect(r.deal_title).toBe('Big deal');
    expect(r.deal_value).toBe('$1200');
    expect(r.deal_stage).toBe('Negotiation');
    expect(r.last_messages).toBe('Them: hi\nUs: hello');
    expect(r.activity_title).toBe('Call back');
    expect(r.activity_notes).toBe('ring at noon');
    expect(r.activity_due).toBe('2026-10-09 14:30 UTC');
  });

  it('falls back lead_name to phone when name is absent', () => {
    const r = resolveDynamicValues({ contact: { phone: '+100' } });
    expect(r.lead_name).toBe('+100');
  });

  it('resolves missing data to empty strings, never undefined', () => {
    const r = resolveDynamicValues({});
    expect(r.lead_name).toBe('');
    expect(r.deal_value).toBe('');
    expect(r.activity_due).toBe('');
    expect(Object.values(r).every((v) => typeof v === 'string')).toBe(true);
  });

  it('omits a non-finite deal value', () => {
    const r = resolveDynamicValues({ deal: { value: NaN, currency: '$' } });
    expect(r.deal_value).toBe('');
  });
});

describe('resolveParamSource', () => {
  const resolved = resolveDynamicValues(bag);

  it('resolves a known dynamic key', () => {
    expect(resolveParamSource('lead_name', resolved)).toBe('Aabid');
  });

  it('treats a leading = as a forced literal', () => {
    expect(resolveParamSource('=lead_name', resolved)).toBe('lead_name');
    expect(resolveParamSource('=Hello there', resolved)).toBe('Hello there');
  });

  it('treats an unknown token as a literal', () => {
    expect(resolveParamSource('just text', resolved)).toBe('just text');
  });
});

describe('resolveTemplateParams', () => {
  const resolved = resolveDynamicValues(bag);

  it('orders params numerically (not lexicographically)', () => {
    const vars: Record<string, string> = {
      '1': 'lead_name',
      '2': 'deal_title',
      '10': '=tenth',
    };
    expect(resolveTemplateParams(vars, resolved)).toEqual(['Aabid', 'Big deal', 'tenth']);
  });

  it('returns [] for undefined variables', () => {
    expect(resolveTemplateParams(undefined, resolved)).toEqual([]);
  });
});

describe('interpolateTemplate', () => {
  const resolved = resolveDynamicValues(bag);

  it('substitutes known placeholders and tolerates whitespace', () => {
    expect(interpolateTemplate('Hi {{lead_name}} re {{ deal_title }}', resolved)).toBe(
      'Hi Aabid re Big deal',
    );
  });

  it('blanks unknown placeholders', () => {
    expect(interpolateTemplate('x {{nope}} y', resolved)).toBe('x  y');
  });
});

const bagWithExtras: ReminderValueBag = {
  ...bag,
  tags: ['VIP', 'ev_potential'],
  customFields: { 'cf-city': 'Pune', 'cf-empty': '' },
};

describe('resolveSourceValue', () => {
  const resolved = resolveDynamicValues(bagWithExtras);

  it('resolves a built-in dynamic key', () => {
    expect(resolveSourceValue('lead_name', resolved, bagWithExtras)).toBe('Aabid');
  });

  it('joins tags for tag_list', () => {
    expect(resolveSourceValue('tag_list', resolved, bagWithExtras)).toBe('VIP, ev_potential');
  });

  it('resolves a custom field by id', () => {
    expect(resolveSourceValue('custom:cf-city', resolved, bagWithExtras)).toBe('Pune');
  });

  it('returns empty for an unknown source', () => {
    expect(resolveSourceValue('nope', resolved, bagWithExtras)).toBe('');
    expect(resolveSourceValue('custom:missing', resolved, bagWithExtras)).toBe('');
  });
});

describe('resolveMappedParams', () => {
  const resolved = resolveDynamicValues(bagWithExtras);

  it('maps positional params and applies defaults when source is empty', () => {
    const map = {
      '1': { source: 'lead_name', default: 'there' },
      '2': { source: 'custom:cf-empty', default: 'N/A' },
      '3': { source: 'tag_list' },
    };
    const { params, details } = resolveMappedParams(map, 3, resolved, bagWithExtras);
    expect(params).toEqual(['Aabid', 'N/A', 'VIP, ev_potential']);
    // Param 2's source resolved empty, so the default was used.
    expect(details[1].usedDefault).toBe(true);
    expect(details[0].usedDefault).toBe(false);
  });

  it('fills missing indices with empty/default', () => {
    const { params } = resolveMappedParams({}, 2, resolved, bagWithExtras);
    expect(params).toEqual(['', '']);
  });
});

describe('countTemplateVariables', () => {
  it('returns the highest positional index', () => {
    expect(countTemplateVariables('Hi {{1}}, see {{3}} and {{2}}')).toBe(3);
  });
  it('returns 0 for no variables', () => {
    expect(countTemplateVariables('plain text')).toBe(0);
  });
});

describe('extractPlaceholders', () => {
  it('returns distinct placeholders in order', () => {
    expect(extractPlaceholders('{{lead_name}} {{deal_title}} {{lead_name}}')).toEqual([
      'lead_name',
      'deal_title',
    ]);
  });
  it('supports custom: and tag_list tokens', () => {
    expect(extractPlaceholders('{{custom:abc}} {{tag_list}}')).toEqual([
      'custom:abc',
      'tag_list',
    ]);
  });
});

describe('interpolateTemplate with bag', () => {
  const resolved = resolveDynamicValues(bagWithExtras);
  it('resolves tag_list and custom tokens when a bag is passed', () => {
    expect(
      interpolateTemplate('Tags: {{tag_list}} City: {{custom:cf-city}}', resolved, bagWithExtras),
    ).toBe('Tags: VIP, ev_potential City: Pune');
  });
});
