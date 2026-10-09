import { describe, it, expect } from 'vitest';
import {
  documentToBuilderSteps,
  builderStepsToDocument,
  toAutomationDocument,
  validateAutomationDocument,
  parseAutomationDocument,
  type AutomationDocument,
} from './document';

const validDoc: AutomationDocument = {
  version: 1,
  name: 'Lead qualifier',
  trigger: { type: 'keyword_match', config: { keywords: ['pricing'], match_type: 'contains' } },
  is_active: false,
  steps: [
    { type: 'send_message', config: { text: 'hi' } },
    {
      type: 'condition',
      config: { subject: 'time_of_day', operand: '18:00-09:00' },
      branches: {
        yes: [{ type: 'send_message', config: { text: 'after hours' } }],
        no: [],
      },
    },
  ],
};

describe('documentToBuilderSteps', () => {
  it('maps type/config and nests condition branches', () => {
    const steps = documentToBuilderSteps(validDoc.steps);
    expect(steps[0]).toEqual({ step_type: 'send_message', step_config: { text: 'hi' } });
    expect(steps[1].step_type).toBe('condition');
    expect(steps[1].branches?.yes?.[0]).toEqual({
      step_type: 'send_message',
      step_config: { text: 'after hours' },
    });
    expect(steps[1].branches?.no).toEqual([]);
  });

  it('does not attach branches to non-condition steps', () => {
    const steps = documentToBuilderSteps([{ type: 'add_tag', config: { tag_id: 't1' } }]);
    expect(steps[0].branches).toBeUndefined();
  });
});

describe('builderStepsToDocument (export round-trip)', () => {
  it('is the inverse of documentToBuilderSteps for the tree shape', () => {
    // Simulate a server step tree (BuilderStepNode has id + branches).
    const tree = [
      {
        id: 'a',
        step_type: 'condition',
        step_config: { subject: 'time_of_day', operand: '18:00-09:00' },
        branches: {
          yes: [
            { id: 'b', step_type: 'send_message', step_config: { text: 'x' }, branches: { yes: [], no: [] } },
          ],
          no: [],
        },
      },
    ];
    const docSteps = builderStepsToDocument(tree);
    expect(docSteps[0].type).toBe('condition');
    expect(docSteps[0].branches?.yes?.[0]).toEqual({ type: 'send_message', config: { text: 'x' } });
  });
});

describe('toAutomationDocument', () => {
  it('assembles a full document from a row + tree', () => {
    const doc = toAutomationDocument(
      {
        name: 'A',
        description: null,
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
      [],
    );
    expect(doc).toMatchObject({
      version: 1,
      name: 'A',
      trigger: { type: 'new_message_received', config: {} },
      is_active: true,
      steps: [],
    });
  });
});

describe('validateAutomationDocument', () => {
  it('accepts a valid, activatable document', () => {
    expect(validateAutomationDocument(validDoc, true)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(validateAutomationDocument(42)).toEqual([
      { path: '', message: 'document must be a JSON object' },
    ]);
  });

  it('flags an unknown trigger type', () => {
    const issues = validateAutomationDocument(
      { name: 'x', trigger: { type: 'nope' }, steps: [] },
      true,
    );
    expect(issues.some((i) => i.path === 'trigger.type')).toBe(true);
  });

  it('flags an unknown step type', () => {
    const issues = validateAutomationDocument(
      { name: 'x', trigger: { type: 'new_message_received' }, steps: [{ type: 'frobnicate' }] },
      true,
    );
    expect(issues.some((i) => i.path === 'steps[0].type')).toBe(true);
  });

  it('rejects branches on a non-condition step', () => {
    const issues = validateAutomationDocument(
      {
        name: 'x',
        trigger: { type: 'new_message_received' },
        steps: [{ type: 'send_message', config: { text: 'hi' }, branches: { yes: [], no: [] } }],
      },
      true,
    );
    expect(issues.some((i) => i.path === 'steps[0].branches')).toBe(true);
  });

  it('allows an incomplete draft when requireActivation is false', () => {
    const issues = validateAutomationDocument(
      { name: 'x', trigger: { type: 'keyword_match' }, steps: [{ type: 'add_tag', config: {} }] },
      false,
    );
    // No activation-level complaints (missing tag_id, missing keywords).
    expect(issues).toEqual([]);
  });
});

describe('parseAutomationDocument', () => {
  it('parses valid JSON', () => {
    const res = parseAutomationDocument(JSON.stringify(validDoc));
    expect(res.ok).toBe(true);
  });

  it('reports invalid JSON', () => {
    const res = parseAutomationDocument('{ not json');
    expect(res.ok).toBe(false);
  });

  it('reports a structurally invalid document', () => {
    const res = parseAutomationDocument(JSON.stringify({ steps: [] }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('name');
  });
});
