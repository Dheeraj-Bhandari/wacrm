// ============================================================
// Automation JSON document — the portable, human- and AI-friendly
// shape for importing / exporting an automation.
//
// It is deliberately NOT the DB row shape. The engine stores steps as
// an adjacency list (automation_steps rows), and the builder/API speak
// `BuilderStepInput` (nested `branches: {yes, no}`). This document is a
// thin, stable envelope over that:
//
//   { version, name, description?, trigger: {type, config}, is_active?,
//     steps: [ {type, config, branches?: {yes, no}} ] }
//
// `documentToBuilderSteps` maps it onto the existing `BuilderStepInput`
// the create/update API already accepts, so import reuses insertSteps /
// the activation validators unchanged. `builderStepsToDocument` is the
// inverse for export. Both are pure.
//
// Keeping the field names `type`/`config` (instead of the DB's
// `step_type`/`step_config`) makes a hand-written or AI-generated JSON
// read naturally; the adapter owns the translation.
// ============================================================

import type {
  AutomationStepType,
  AutomationTriggerType,
} from '@/types'
import type { BuilderStepInput, BuilderStepNode } from './steps-tree'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
  type ValidationIssue,
} from './validate'

/** Current document schema version. */
export const AUTOMATION_DOC_VERSION = 1 as const;

export interface AutomationDocStep {
  type: string;
  config?: Record<string, unknown>;
  /** Only meaningful for a `condition` step. */
  branches?: {
    yes?: AutomationDocStep[];
    no?: AutomationDocStep[];
  };
}

export interface AutomationDocument {
  version?: number;
  name: string;
  description?: string | null;
  trigger: {
    type: string;
    config?: Record<string, unknown>;
  };
  is_active?: boolean;
  steps: AutomationDocStep[];
}

// Known unions, as runtime Sets for structural validation. Kept in sync
// with the TS unions in src/types/index.ts.
const STEP_TYPES: ReadonlySet<string> = new Set<AutomationStepType>([
  'send_message',
  'send_buttons',
  'send_list',
  'send_template',
  'add_tag',
  'remove_tag',
  'assign_conversation',
  'update_contact_field',
  'create_deal',
  'wait',
  'condition',
  'send_webhook',
  'close_conversation',
]);

const TRIGGER_TYPES: ReadonlySet<string> = new Set<AutomationTriggerType>([
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'new_contact_created',
  'conversation_assigned',
  'tag_added',
  'time_based',
  'interactive_reply',
]);

// ------------------------------------------------------------
// Adapter: document <-> BuilderStepInput
// ------------------------------------------------------------

/** Map a document's steps onto the API's `BuilderStepInput[]`. */
export function documentToBuilderSteps(steps: AutomationDocStep[]): BuilderStepInput[] {
  return (steps ?? []).map((s) => {
    const out: BuilderStepInput = {
      step_type: s.type,
      step_config: s.config ?? {},
    };
    if (s.type === 'condition' && s.branches) {
      out.branches = {
        yes: documentToBuilderSteps(s.branches.yes ?? []),
        no: documentToBuilderSteps(s.branches.no ?? []),
      };
    }
    return out;
  });
}

/** Inverse: a server step tree (loadStepsTree) -> document steps. */
export function builderStepsToDocument(nodes: BuilderStepNode[]): AutomationDocStep[] {
  return (nodes ?? []).map((n) => {
    const step: AutomationDocStep = {
      type: n.step_type,
      config: n.step_config ?? {},
    };
    if (n.step_type === 'condition') {
      step.branches = {
        yes: builderStepsToDocument(n.branches?.yes ?? []),
        no: builderStepsToDocument(n.branches?.no ?? []),
      };
    }
    return step;
  });
}

/** Build an exportable document from an automation row + its step tree. */
export function toAutomationDocument(
  automation: {
    name: string;
    description?: string | null;
    trigger_type: string;
    trigger_config?: Record<string, unknown> | null;
    is_active?: boolean;
  },
  stepTree: BuilderStepNode[],
): AutomationDocument {
  return {
    version: AUTOMATION_DOC_VERSION,
    name: automation.name,
    description: automation.description ?? null,
    trigger: {
      type: automation.trigger_type,
      config: automation.trigger_config ?? {},
    },
    is_active: Boolean(automation.is_active),
    steps: builderStepsToDocument(stepTree),
  };
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

/**
 * Validate a parsed JSON object as an AutomationDocument. Returns a flat
 * list of issues (path + message); empty = valid. Combines structural
 * checks (shape, known types, branch rules) with the SAME activation
 * validators the API uses, so a document that passes here will import
 * and activate cleanly.
 *
 * `requireActivation` (default true) runs the per-step/-trigger config
 * checks. Set false to allow importing an incomplete draft.
 */
export function validateAutomationDocument(
  input: unknown,
  requireActivation = true,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [{ path: '', message: 'document must be a JSON object' }];
  }
  const doc = input as Record<string, unknown>;

  if (doc.version != null && doc.version !== AUTOMATION_DOC_VERSION) {
    issues.push({
      path: 'version',
      message: `unsupported version ${String(doc.version)} (expected ${AUTOMATION_DOC_VERSION})`,
    });
  }

  if (typeof doc.name !== 'string' || doc.name.trim() === '') {
    issues.push({ path: 'name', message: 'name is required' });
  }

  // Trigger.
  const trigger = doc.trigger as Record<string, unknown> | undefined;
  if (!trigger || typeof trigger !== 'object') {
    issues.push({ path: 'trigger', message: 'trigger is required' });
  } else {
    const tType = trigger.type;
    if (typeof tType !== 'string' || !TRIGGER_TYPES.has(tType)) {
      issues.push({
        path: 'trigger.type',
        message: `unknown trigger type: ${String(tType)}`,
      });
    } else if (requireActivation) {
      issues.push(
        ...validateTriggerForActivation(
          tType,
          (trigger.config as Record<string, unknown>) ?? {},
        ),
      );
    }
  }

  // Steps — structural pass first (unknown types / bad branch shape),
  // because the activation validator assumes well-formed step objects.
  const steps = doc.steps;
  if (!Array.isArray(steps)) {
    issues.push({ path: 'steps', message: 'steps must be an array' });
    return issues;
  }
  walkStructural(steps as unknown[], 'steps', issues);

  if (requireActivation && issues.every((i) => !i.path.startsWith('steps'))) {
    // Only run the config-level activation checks when the structure is
    // sound; otherwise the paths would be misleading. Map doc steps to
    // the shape validateStepsForActivation expects (step_type/step_config
    // + branches).
    issues.push(
      ...validateStepsForActivation(
        toActivationShape(steps as AutomationDocStep[]),
      ),
    );
  }

  return issues;
}

interface ActivationStep {
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: ActivationStep[]; no?: ActivationStep[] };
}

function toActivationShape(steps: AutomationDocStep[]): ActivationStep[] {
  return steps.map((s) => {
    const out: ActivationStep = {
      step_type: s.type,
      step_config: s.config ?? {},
    };
    if (s.type === 'condition' && s.branches) {
      out.branches = {
        yes: toActivationShape(s.branches.yes ?? []),
        no: toActivationShape(s.branches.no ?? []),
      };
    }
    return out;
  });
}

function walkStructural(steps: unknown[], path: string, issues: ValidationIssue[]): void {
  steps.forEach((raw, i) => {
    const p = `${path}[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ path: p, message: 'step must be an object' });
      return;
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.type !== 'string' || !STEP_TYPES.has(s.type)) {
      issues.push({ path: `${p}.type`, message: `unknown step type: ${String(s.type)}` });
      return;
    }
    if (s.config != null && (typeof s.config !== 'object' || Array.isArray(s.config))) {
      issues.push({ path: `${p}.config`, message: 'config must be an object' });
    }
    if (s.branches != null) {
      if (s.type !== 'condition') {
        issues.push({
          path: `${p}.branches`,
          message: 'only a condition step may have branches',
        });
      } else {
        const b = s.branches as Record<string, unknown>;
        if (b.yes != null && !Array.isArray(b.yes)) {
          issues.push({ path: `${p}.branches.yes`, message: 'yes branch must be an array' });
        } else if (Array.isArray(b.yes)) {
          walkStructural(b.yes, `${p}.branches.yes`, issues);
        }
        if (b.no != null && !Array.isArray(b.no)) {
          issues.push({ path: `${p}.branches.no`, message: 'no branch must be an array' });
        } else if (Array.isArray(b.no)) {
          walkStructural(b.no, `${p}.branches.no`, issues);
        }
      }
    }
  });
}

/** Parse a JSON string into a document, returning either the value or an error. */
export function parseAutomationDocument(
  json: string,
): { ok: true; doc: AutomationDocument } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
  const issues = validateAutomationDocument(parsed, false);
  // Only hard structural problems block parsing; activation-level issues
  // are surfaced separately so a draft can still be loaded into the builder.
  const structural = issues.filter(
    (i) => i.path === '' || i.path === 'name' || i.path.startsWith('trigger') || i.path.startsWith('steps') || i.path === 'version',
  );
  if (structural.length > 0) {
    return { ok: false, error: structural.map((i) => `${i.path || 'document'}: ${i.message}`).join('; ') };
  }
  return { ok: true, doc: parsed as AutomationDocument };
}
