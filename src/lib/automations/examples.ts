// ============================================================
// Ready-to-use automation JSON examples.
//
// These are complete AutomationDocument objects a user can copy into
// the "Import JSON" dialog, or load straight into the builder via
// "Use this". They double as the contract/reference for the document
// schema — and as the few-shot examples an AI could learn the shape
// from when generating a flow (design doc §6.4).
//
// Every example is valid against validateAutomationDocument with
// requireActivation=false (some leave a tag_id blank for the user to
// fill), so they load cleanly even if they can't be activated as-is.
// ============================================================

import type { AutomationDocument } from './document';

export interface AutomationExample {
  /** Stable id for the examples list. */
  id: string;
  /** Short human label. */
  label: string;
  /** One-line description. */
  description: string;
  document: AutomationDocument;
}

export const AUTOMATION_EXAMPLES: AutomationExample[] = [
  {
    id: 'welcome',
    label: 'Welcome message',
    description: 'Greet a contact on their first inbound message.',
    document: {
      version: 1,
      name: 'Welcome message',
      description: 'Auto-reply to first-time contacts with a greeting.',
      trigger: { type: 'first_inbound_message', config: {} },
      is_active: false,
      steps: [
        {
          type: 'send_message',
          config: { text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly." },
        },
      ],
    },
  },
  {
    id: 'keyword_pricing',
    label: 'Pricing keyword reply',
    description: 'When a message mentions pricing, reply and hand off to an agent after a short wait.',
    document: {
      version: 1,
      name: 'Pricing enquiry',
      description: 'Reply to pricing keywords and route to a human.',
      trigger: {
        type: 'keyword_match',
        config: { keywords: ['pricing', 'quote', 'cost'], match_type: 'contains' },
      },
      is_active: false,
      steps: [
        {
          type: 'send_message',
          config: { text: 'Great — happy to help with pricing! One of our team will be right with you.' },
        },
        { type: 'wait', config: { amount: 2, unit: 'minutes' } },
        { type: 'assign_conversation', config: { mode: 'round_robin' } },
      ],
    },
  },
  {
    id: 'out_of_office',
    label: 'Out of office (condition branch)',
    description: 'Reply only outside business hours — shows a condition with a yes branch.',
    document: {
      version: 1,
      name: 'Out of office',
      description: 'Auto-reply during off-hours so nobody is left waiting.',
      trigger: { type: 'new_message_received', config: {} },
      is_active: false,
      steps: [
        {
          type: 'condition',
          config: { subject: 'time_of_day', operand: '18:00-09:00' },
          branches: {
            yes: [
              {
                type: 'send_message',
                config: {
                  text: "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
                },
              },
            ],
            no: [],
          },
        },
      ],
    },
  },
  {
    id: 'follow_up',
    label: 'Follow-up nudge',
    description: 'Wait a day, then send a gentle follow-up.',
    document: {
      version: 1,
      name: 'Follow-up reminder',
      description: 'Send a nudge if a contact goes quiet.',
      trigger: { type: 'new_message_received', config: {} },
      is_active: false,
      steps: [
        { type: 'wait', config: { amount: 1, unit: 'days' } },
        {
          type: 'send_message',
          config: { text: 'Just circling back — did you have any other questions for us? Happy to help!' },
        },
      ],
    },
  },
  {
    id: 'webhook_notify',
    label: 'Notify external webhook',
    description: 'On a new contact, POST their details to your own endpoint.',
    document: {
      version: 1,
      name: 'New contact webhook',
      description: 'Forward new contacts to an external system.',
      trigger: { type: 'new_contact_created', config: {} },
      is_active: false,
      steps: [
        {
          type: 'send_webhook',
          config: {
            url: 'https://example.com/webhooks/new-contact',
            body_template: '{"event":"new_contact","message":"{{ message.text }}"}',
          },
        },
      ],
    },
  },
];

export function getAutomationExample(id: string): AutomationExample | undefined {
  return AUTOMATION_EXAMPLES.find((e) => e.id === id);
}
