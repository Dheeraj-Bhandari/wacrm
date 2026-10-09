# Activities, Reminders & Scheduling — Design

Status: proposed. This document covers the full set of features requested:
activity/reminder system, inbox pipeline + activity controls, broadcast
scheduling, dashboard activity widget, a dedicated Activities section, email
templates, and automation JSON import/validate.

Guiding principle (per the brief): **never miss a scheduled activity for a
lead, and automate as much as possible.** Every time-based thing in the app is
driven by one durable, idempotent, service-role worker loop — the same pattern
the automation `wait` cron already uses — so nothing depends on a browser tab
staying open.

---

## 0. Cross-cutting foundation

### 0.1 One scheduler, many due-work tables

The codebase already has the right pattern: `GET /api/automations/cron`,
guarded by `x-cron-secret` (timing-safe compare against `AUTOMATION_CRON_SECRET`),
using the service-role client to drain due rows and claim each with a
conditional `UPDATE ... WHERE status='pending'`.

We add **one new cron umbrella** that drains three due-work sources in a single
scheduled hit, reusing the same secret:

- `GET /api/cron/scheduler` — drains, in order:
  1. **due activities/reminders** (`activities` where `remind_at <= now()` and not yet fired)
  2. **due scheduled broadcasts** (`broadcasts` where `status='scheduled'` and `scheduled_at <= now()`)
  3. (keeps delegating to the existing automations/flows crons? No — those stay separate endpoints; we just add this one.)

Each sub-drain is isolated in a try/catch so one failing source never blocks the
others. Returns `{ activities: n, broadcasts: n }`. All claims are atomic
conditional updates so overlapping cron invocations never double-fire.

Operational note (added to `docs/` + README): the scheduler must be pinged on a
schedule (Vercel Cron, GitHub Actions, Hostinger cron, or any external pinger),
e.g. every minute. Document the curl + header. Reminder/broadcast punctuality is
bounded by the cron interval — a 1-minute ping means activities fire within a
minute of their due time, which is the right granularity for a CRM.

### 0.2 Timezones

Store every scheduled instant as `TIMESTAMPTZ` (absolute UTC instant). The UI
collects a local date+time and converts to an ISO instant before sending. We
store the account's display timezone on `accounts.timezone` (new nullable
column, default `NULL` → treat as UTC/browser-local) so the dedicated Activities
view and dashboard "today" bucket can group by the account's day rather than the
server's. Scheduling itself never depends on the stored tz — only the absolute
instant matters for firing.

---

## 1. Data model (new migrations)

Next migration number is **043**. All migrations idempotent (`IF NOT EXISTS`,
`DROP POLICY ... / CREATE POLICY`), account-scoped, RLS mirroring the `deals`
block (select = member, insert/update/delete = agent+). `verify-schema.sql`
gets new assertions inside its single `DO` block.

### 043_activities.sql — the activity/task/reminder core

```
activities
  id              uuid pk
  account_id      uuid not null  -> accounts (tenancy)
  user_id         uuid not null  -> auth.users (author/audit)
  contact_id      uuid           -> contacts  ON DELETE SET NULL (nullable; survives contact delete)
  conversation_id uuid           -> conversations ON DELETE SET NULL (optional link)
  deal_id         uuid           -> deals ON DELETE SET NULL (optional link)
  type            text not null  CHECK IN ('call','whatsapp_message','email','task','reminder','meeting')
  title           text not null
  notes           text
  due_at          timestamptz not null         -- when the activity is scheduled for
  remind_at       timestamptz                  -- when to fire the reminder (defaults = due_at)
  status          text not null default 'pending'
                    CHECK IN ('pending','done','cancelled','overdue')
  -- reminder delivery config (optional; null = no auto-send, just a to-do):
  reminder_config jsonb          -- { whatsapp?: {...}, email?: {...} }  (see §2)
  reminder_fired_at timestamptz  -- set when the scheduler delivered the reminder (idempotency)
  reminder_error    text         -- last delivery error, surfaced in UI
  assigned_to     uuid           -> profiles ON DELETE SET NULL (who owns the activity)
  completed_at    timestamptz
  created_at / updated_at timestamptz
```

Indexes: `(account_id, due_at)`, `(account_id, status)`, `(contact_id)`, and a
partial due-reminder index `(remind_at) WHERE status='pending' AND reminder_fired_at IS NULL AND reminder_config IS NOT NULL` for the scheduler's hot path.

RLS: `activities_select` = `is_account_member(account_id)`;
insert/update/delete = `is_account_member(account_id,'agent')`.
`updated_at` trigger. A separate "claim" column is not needed — the scheduler
claims by setting `reminder_fired_at` conditionally.

### 043 also: accounts.timezone

`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS timezone TEXT;`

### 044_email_templates.sql — email templates + reminder defaults

```
email_templates
  id          uuid pk
  account_id  uuid not null -> accounts
  user_id     uuid not null -> auth.users (author)
  name        text not null
  subject     text not null          -- supports {{placeholders}}
  body_html   text not null          -- supports {{placeholders}}
  body_text   text                   -- optional plaintext alt
  created_at / updated_at
  UNIQUE(account_id, name)
```
RLS mirrors deals (select member, write agent+). `updated_at` trigger.

```
reminder_settings            -- one row per account (member reminder prefs live here)
  account_id   uuid pk -> accounts
  -- channel defaults; per-activity config can override
  default_whatsapp_template  text
  default_email_template_id  uuid -> email_templates ON DELETE SET NULL
  notify_whatsapp_number     text   -- the member/agent WhatsApp number to notify
  notify_email               text   -- the member email to notify
  updated_at
```
This is where "member configures their WhatsApp number + which template + which
email template" lives (requirement 1). The per-activity `reminder_config`
overrides these defaults when set.

### 045_scheduled_broadcast.sql — make scheduling real (no schema add needed, mostly)

`broadcasts.scheduled_at` and `status='scheduled'` already exist (migration 001),
just unused. We add:
- `broadcasts.audience_snapshot jsonb` is **not** needed — instead we
  **materialize recipient rows at schedule time** (see §4). So the only schema
  change is a scheduler claim guard: reuse the existing `delivery_locked_at`
  mutex. No new column strictly required. (If a dedicated index helps:
  `CREATE INDEX idx_broadcasts_scheduled ON broadcasts(scheduled_at) WHERE status='scheduled'`.)

---

## 2. Feature 1 — Activity reminders

**What a reminder does when it fires (scheduler):** for a due `activities` row
with `reminder_config` set and `reminder_fired_at IS NULL`:

1. Atomically claim it (`UPDATE ... SET reminder_fired_at=now() WHERE id=? AND reminder_fired_at IS NULL`).
2. Resolve dynamic values from the linked contact/deal/conversation:
   - `lead_name`, `lead_phone`, `lead_company`, `deal_title`, `deal_stage`,
     `last_messages` (last N inbound/outbound texts), `activity_title`,
     `activity_due`, plus any custom field by key.
3. **WhatsApp channel** (if configured): send the chosen approved WhatsApp
   template to `notify_whatsapp_number` (the member), with positional params
   mapped from the dynamic values the member chose. Reuses the existing
   `sendTemplateMessage` / engine send path.
4. **Email channel** (if configured): render the chosen `email_templates` row
   (interpolate `{{placeholders}}`) and send to `notify_email`.
5. Record `reminder_fired_at` / `reminder_error`. Also drop an in-app
   `notifications` row (table already exists) so the reminder shows in the bell.

**Email transport.** The repo currently has **no email/SMTP integration.** I'll
add a small pluggable sender `src/lib/email/send.ts` with an SMTP driver
configured via env (`SMTP_HOST/PORT/USER/PASS/FROM`). If SMTP env is absent,
email reminders are skipped with a clear `reminder_error` ("email not
configured") rather than failing — WhatsApp still fires. **This is the one new
external dependency** (`nodemailer`). See the open question in §9.

**`reminder_config` shape:**
```jsonc
{
  "whatsapp": {
    "to": "+1555...",                 // member number (defaults from reminder_settings)
    "template_name": "lead_reminder",
    "language": "en_US",
    "variables": { "1": "lead_name", "2": "deal_title", "3": "last_messages" } // value = dynamic key
  },
  "email": {
    "to": "agent@acme.com",
    "template_id": "<email_templates.id>"
  }
}
```

**UI (Settings → Reminders, new section):** member number, default WhatsApp
template picker (from approved `message_templates`), default email template
picker, and a preview of available dynamic variables. **UI (Settings → Email
templates, new section):** CRUD cloned from `TemplateManager`, with a
`{{placeholder}}` helper + live preview.

---

## 3. Features 2 & 3 — Inbox activity + pipeline controls

All client-side via the browser Supabase client + RLS, matching the existing
inbox architecture (no server actions in that path).

**ContactSidebar — two new sections** (below NOTES, same visual pattern):

- **Pipeline**: shows the contact's current stage (derived from their most-recent
  open deal) and a stage `<select>`. Changing it: if the contact has an open
  deal, `UPDATE deals SET stage_id` (reuses `handleDealMoved` logic); if none,
  create a lightweight deal (title defaults to contact name, value 0, account's
  default currency) in the chosen pipeline/stage so the stage has somewhere to
  live. A pipeline picker appears when the account has >1 pipeline.
- **Activities**: a "schedule" composer — type (call / WhatsApp message / task /
  meeting), title, due date+time, optional "remind me" toggle (sets
  `reminder_config` from account defaults), and a list of upcoming + past
  activities for this contact with done/cancel actions. Insert pattern mirrors
  `handleAddNote` (include `account_id`, `user_id`, `contact_id`,
  `conversation_id`). Scheduling a WhatsApp message activity with reminder set
  means the scheduler will fire the configured template at `due_at`.

**ConversationList — pipeline stage filter:** extend `CONVERSATION_SELECT` to
embed `contact:contacts(..., deals(stage_id,status))`, add `selectedStageId`
state + a "Stage" dropdown (populated from `pipeline_stages`), and a clause in
the `filtered` useMemo (and `matchesContactFilters`) — exactly like the existing
tag/company filters. "Set stage from here" is covered by the sidebar Pipeline
section, which is visible on the same screen.

---

## 4. Feature 4 — Broadcast start-from-draft + scheduled send

Both reuse the server-driven `createBroadcast`/`deliverBroadcast`/resume
machinery (tab-safe), **not** the client wizard loop.

**Materialize at commit time.** When a user "schedules" or "starts" a draft, we
resolve the audience server-side and insert `broadcast_recipients` rows with
frozen `template_params` immediately (status stays `scheduled` or flips to
`sending`). This is essential: the cron runs with no browser context, so the
recipient set + per-recipient `{{N}}` params must already be persisted.

New endpoints (require `agent`):
- `POST /api/whatsapp/broadcast/[id]/schedule` — body `{ scheduled_at }`. Resolves
  audience from the draft's `audience_filter`, inserts recipient rows (frozen
  params), sets `status='scheduled'`, `scheduled_at`. Validates the time is in
  the future.
- `POST /api/whatsapp/broadcast/[id]/start` — "send a drafted/scheduled broadcast
  now." Claims the delivery lock, flips to `sending`, `after(deliverBroadcast)`.
  (For a draft with no recipients yet, materialize first.)

New cron sub-drain (in `/api/cron/scheduler`): select `status='scheduled' AND
scheduled_at <= now()`, claim via `claimBroadcastDelivery`, plan from recipient
rows (reusing `planBroadcastResume`-style logic), `deliverBroadcast`.

**UI:**
- `step4-schedule-send.tsx` gains a real date/time picker: "Send now" |
  "Schedule for later" (date+time) | "Save as draft".
- Broadcast **detail page**: for `draft`/`scheduled` broadcasts, add
  **"Send now"** and (for drafts) **"Schedule"** buttons; for `scheduled`, show
  the scheduled time + a **"Cancel schedule"** (revert to draft) / **"Reschedule"**.
- Broadcast **list page**: the `scheduled` badge already exists; show
  `scheduled_at`.

Edge cases covered: schedule in the past → reject; audience empty at
materialize → clear error; cancel a scheduled broadcast → delete recipient rows,
revert to draft; double-start → delivery lock 409; drafts not round-trippable
into the wizard today → the start/schedule actions work directly off the stored
`audience_filter` + `template_variables` so no wizard round-trip is needed.

---

## 5. Feature 5 — Dashboard widget + dedicated Activities section

**Dashboard "Today's activities" widget** (`src/components/dashboard/todays-activities.tsx`):
new loader `loadTodayActivities(db)` in `queries.ts` — `activities` where
`due_at` within the account's today, `status IN ('pending','overdue')`, ordered
by `due_at`. Shows count by type + the next few, with a **"View all →"** link to
`/activities`. Also a dashboard metric "Activities due today".

**New sidebar section `Activities`** (`/activities`): new nav item
(`labelKey:'activities'`, icon `CalendarClock`) in `sidebar.tsx` + `header.tsx`,
i18n keys in all four catalogues. New route
`src/app/(dashboard)/activities/page.tsx` (client component): a filterable list
of all activities with filters for **date range**, **type**, **status**, **pipeline
stage**, **assignee**, and a quick "Today / Upcoming / Overdue / Done" segmented
control. Each row: contact link, type icon, title, due time, reminder status,
and done/cancel/reschedule actions. An "overdue" sweep (activities past due and
still pending) is reflected by computing status at read time and by the
scheduler flipping `pending→overdue` when `due_at < now()`.

---

## 6. Feature 6 — Automation JSON import / examples / validate

### 6.1 Canonical JSON shape

The automation already round-trips through `BuilderStepInput[]` (nested
`branches:{yes,no}` form). The import/export JSON is exactly an automation
document:
```jsonc
{
  "version": 1,
  "name": "Lead qualifier",
  "description": "...",
  "trigger": { "type": "keyword_match", "config": { "keywords": ["pricing"], "match_type": "contains" } },
  "is_active": false,
  "steps": [
    { "type": "send_message", "config": { "text": "Hi {{message.text}}" } },
    { "type": "condition", "config": { "subject": "time_of_day", "operand": "18:00-09:00" },
      "branches": { "yes": [ { "type": "send_message", "config": { "text": "After hours" } } ], "no": [] } }
  ]
}
```
A small adapter maps this friendly shape to the existing `BuilderStepInput`
(`type→step_type`, `config→step_config`, `trigger.type/config→trigger_type/trigger_config`),
so the server reuses `insertSteps`/`replaceSteps` unchanged.

### 6.2 Export + example library

- Export: `GET /api/automations/[id]/export` returns the document above
  (built from `loadStepsTree`). A "Copy JSON" button in the builder.
- Examples: extend `src/lib/automations/examples.ts` with several ready-to-use
  documents (welcome, out-of-office, lead qualifier, follow-up, keyword menu,
  reminder-on-no-reply). A "Examples" dialog shows each with a "Copy" + "Use
  this" button.

### 6.3 Import (paste JSON → automation)

- Builder gains an "Import JSON" dialog: paste → parse → **schema-validate** →
  either load into the builder (editable) or POST directly. Validation uses a
  new pure `validateAutomationDocument(doc)` returning `ValidationIssue[]`
  (reuses `validateTriggerForActivation` + `validateStepsForActivation` plus
  structural checks: unknown keys, bad branch shape, condition-only branching,
  type/config presence). This is also the groundwork for "AI builds the JSON"
  later — the schema + validator are the contract.

### 6.4 Step-by-step validation against a test number (n8n-style)

New endpoint `POST /api/automations/validate-run` (require `agent`), body
`{ document | automation_id, test_phone }`:
1. Static validate the document (structural + activation rules).
2. Resolve/create a sandbox contact for `test_phone` (within the account).
3. **Dry-run walk** the step tree in order, evaluating each step:
   - `send_*` → actually send to the test number (opt-in "live send to my test
     number") OR simulate (default): report the resolved text/template/params
     without sending.
   - `wait` → report "would wait N units" (no suspension).
   - `condition` → evaluate against the test contact and report which branch,
     then descend.
   - mutating steps (`add_tag`, `create_deal`, `update_contact_field`, …) →
     simulate by default (report intended effect) to avoid polluting data;
     a "live" toggle lets them actually run against the sandbox contact.
   Returns an ordered list of `{ step, status: ok|warn|error, detail }` — the UI
   renders it as a step timeline exactly like n8n's per-node run, so the user
   sees where a flow would break before activating.

This requires a small, safe refactor of `engine.ts`: extract the per-step
resolution (interpolate text, resolve template params, evaluate condition) into
pure helpers the validator can call without the live side effects. The live
engine keeps its existing behavior.

---

## 7. i18n, types, tests

- New namespaces in all four `messages/*.json`: `Activities`, `Settings.reminders`,
  `Settings.emailTemplates`, plus `Sidebar.activities`, broadcast scheduling
  strings under `Broadcasts`, dashboard `todaysActivities`.
- New types in `src/types/index.ts`: `Activity`, `ActivityType`, `ActivityStatus`,
  `EmailTemplate`, `ReminderSettings`, `ReminderConfig`, automation document types.
- Unit tests (Vitest, matching existing style) for the pure logic: dynamic-value
  resolver, reminder due-selection, automation document validator + adapter,
  scheduled-broadcast materialization, activity overdue computation. No UI tests
  (repo has none).

## 8. Delivery order

1. Migrations 043–045 + verify-schema assertions + types.
2. Scheduler cron umbrella + email sender + reminder delivery (Feature 1 backend).
3. Settings: Email templates + Reminders sections (Feature 1 frontend).
4. Inbox: Pipeline + Activities sidebar sections + stage filter (Features 2,3).
5. Broadcast schedule/start endpoints + cron sub-drain + UI (Feature 4).
6. Dashboard widget + /activities section (Feature 5).
7. Automation JSON import/export/examples/validate-run (Feature 6).
8. typecheck + lint + build + tests.

## 9. Decisions (confirmed)

1. **Email transport: Resend.** `src/lib/email/send.ts` uses the Resend SDK,
   configured via `RESEND_API_KEY` + `EMAIL_FROM`. When unset, email reminders
   are a clean no-op (recorded as a reminder_error) and WhatsApp still fires.
2. **Cron: external pinger.** The app exposes `GET /api/cron/scheduler`
   (guarded by `AUTOMATION_CRON_SECRET`). A Node/cron pinger hits it on a
   schedule; punctuality = ping interval. See `.env.local.example`.
3. **Delivery: feature by feature**, verifying typecheck + lint + tests + build
   between each.

## 10. Progress

- [x] Foundation: migrations 043–045, verify-schema assertions, types, env docs.
- [x] Feature 1 — Activity reminders: email sender (Resend), dynamic-value
      resolver, reminder delivery (WhatsApp + email + in-app notification),
      scheduler cron, Settings → Email templates + Reminders. Verified.
- [ ] Features 2 & 3 — Inbox activity + pipeline controls.
- [x] Features 2 & 3 — Inbox pipeline-stage filter + contact-sidebar Pipeline &
      Activities sections. Verified.
- [x] Feature 4 — Broadcast start-from-draft + scheduled send: server
      materializer, schedule/start/cancel endpoints, cron drain, wizard +
      detail + list UI. Verified.
- [x] Feature 5 — Dashboard "Today's Agenda" widget + dedicated /activities
      section with segment + filters. Verified.
- [x] Feature 6 — Automation JSON import/export/examples + n8n-style
      step-by-step validate-run against a test number. Verified.
- [x] v3 refinements (§11): multiple lead times, template variable mapping,
      curated variables, quick-reschedule presets, richer dashboard rows,
      in-process + GitHub Actions cron, WhatsApp language fix. Verified.

---

## 11. v3 additions (reminders & scheduling refinements)

A second pass refined the reminder system around real-world use. Everything
below is implemented and verified. Migration number advances to **047**.

### 11.1 Multiple reminder lead times (one activity → several reminders)

Previously a reminder had a single lead time (`reminder_settings.lead_time_minutes`,
one `remind_at`). Now an account configures **a set** of lead times and each
activity fires one reminder per offset.

- **Schema** (migration `047_reminder_multi_leadtime_and_varmap.sql`):
  - `reminder_settings.lead_times_minutes INT[]` default `ARRAY[0]` — e.g.
    `{1440, 60, 15}` = 1 day, 1 hour, and 15 minutes before due. Backfilled from
    the legacy `lead_time_minutes` (now `@deprecated`, kept in sync as the min).
  - `activities.reminder_fired_offsets JSONB` default `[]` — the offsets already
    fired for this activity, so each lead time fires exactly once.
- **Scheduler** (`src/lib/activities/scheduler.ts`, `drainDueReminders`): selects
  open reminder activities due within a 7-day window, computes each account's
  offsets, and fires **one due, unfired offset per activity per run** (an offset
  is due when `now >= due_at − offset·60s`). It appends the offset to
  `reminder_fired_offsets` as an optimistic claim, records the per-channel sent
  timestamps, and keeps the legacy `reminder_fired_at` synced on the smallest
  offset for backward compatibility. The overdue sweep still runs afterward.
- **Settings UI** (`reminders-settings.tsx`): lead times are a multi-select pill
  group (0 / 5 / 10 / 15 / 25 / 30 / 60 / 120 / 240 / 1440 min); the set is never
  allowed to be empty. Saved to `lead_times_minutes` (plus the legacy scalar).

### 11.2 Template variable mapping (WhatsApp positional + email named)

When the selected template has dynamic variables, Settings now prompts the user
to map each to a real source with a default fallback, instead of sending blanks.

- **WhatsApp** templates use positional params (`{{1}}`, `{{2}}`, …). The count
  comes from `countTemplateVariables(body_text)`. The map lives on
  `reminder_settings.whatsapp_variable_map JSONB` as
  `{ "1": { source, default? }, ... }`.
- **Email** templates use **named** `{{placeholder}}` tokens interpolated
  directly — no explicit map needed; sources are resolved by name at send time.
- **Unmapped behaviour**: if a param has no source, the configured `default` is
  sent and the UI shows a warning so it's never silently blank.
- Resolution lives in `src/lib/activities/dynamic-values.ts`:
  `resolveSourceValue`, `resolveMappedParams`, `countTemplateVariables`,
  `extractPlaceholders`, and an `interpolateTemplate` whose token regex allows
  `:` and `-` so `custom:<uuid>` sources work.

### 11.3 Curated available variables

The variable picker is driven by `REMINDER_VARIABLE_SOURCES` — real sources, not
free text:

- **Built-ins**: lead name, lead phone, lead company, deal title, deal stage,
  **pipeline/deal value**, last inbound/outbound messages, activity title,
  activity due time.
- **Tags**: the contact's tag list (`tag_list`).
- **Custom fields**: every account custom field, fetched from the DB and offered
  as `custom:<field_id>`.

The `ReminderValueBag` carries `tags` and `customFields`; `buildValueBag` loads
`contact_tags(tags(name))` and `contact_custom_values` so these resolve at send
time.

### 11.4 Quick-reschedule (snooze) presets

One-click reschedule everywhere an activity appears: the **Activities** list
rows, the in-app **reminder popup**, and the dashboard **Today's Agenda** rows.
Presets: **+5m, +15m, +30m, +1h, Tomorrow** (tomorrow = 9:00 AM local).

The shared helpers live in `src/lib/activities/client.ts`:
`SNOOZE_PRESETS`, `snoozeDueAt(preset)`, and `rescheduleUpdate(dueIso)` — the
latter re-arms the reminder (clears `reminder_fired_at`, `reminder_fired_offsets`,
the per-channel sent timestamps, and `reminder_error`, resets status to
`pending`) so every configured lead-time offset fires again at the new time.
Using one helper keeps reschedule behaviour identical across all three surfaces.

### 11.5 Richer dashboard "Today's Agenda" rows

`loadTodayActivities` now also returns `contactPhone`, and
`todays-activities.tsx` renders a type badge, the lead name **and phone**, the
due time (or an "overdue" marker), and the snooze preset buttons from §11.4.

### 11.6 Near-real-time reminders without manual curl

Reminders are **time-based**, not event-based: an activity becomes due by the
passage of time, so *something* has to poll. Two complementary mechanisms:

- **In-app popup** (`reminder-popup.tsx`) polls the signed-in user's own due
  reminders client-side every 30s, so a logged-in user sees the popup even with
  no server cron running. This is why a reminder can surface in the UI but the
  WhatsApp/email message not send until the server scheduler runs.
- **Server delivery** (WhatsApp + email) only happens when `GET
  /api/cron/scheduler` runs. Options, in order of preference for the hosting
  model:
  1. **In-process cron (self-hosted Node).** Set `CRON_IN_PROCESS=true` and the
     server pings itself every `CRON_IN_PROCESS_INTERVAL_MS` (default 60s) via
     `instrumentation.ts` → `src/lib/cron/in-process-runner.ts`. Best for
     `next start` / Docker / a VPS. **Off by default**; do not use on
     serverless/edge (no long-lived process) or with multiple instances.
  2. **Cloudflare Worker Cron Trigger** (`deploy/cron-worker/`). A tiny
     Worker (`worker.js` + `wrangler.toml`) pings the endpoint on a cron
     trigger — **1-minute granularity**, the most punctual free option. The
     secret is a Worker secret (`wrangler secret put CRON_SECRET`), the URL a
     public var. Deploy with `npx wrangler deploy`. Best choice if you already
     use Cloudflare.
  3. **AWS EventBridge Scheduler.** A one-off schedule (rate `1 minute`) with a
     **Universal target → `aws-sdk:lambda:invoke`** fronting a 10-line Lambda
     that `fetch`es the endpoint with the header — or, simpler, point an
     EventBridge API Destination at the URL with a connection that injects the
     `x-cron-secret` header. 1-minute granularity. Best choice if the box is
     already on AWS (as this EC2 deploy is). Setup steps in `docs/deploy-ec2.md`.
  4. **GitHub Actions** (`.github/workflows/scheduler-cron.yml`) pings the
     deployed endpoint every 5 minutes (GitHub's minimum; runs are best-effort).
     Needs repo secrets `SCHEDULER_URL` + `AUTOMATION_CRON_SECRET`. Works for any
     host; good zero-infra fallback.
  5. **Platform/host cron** (Vercel Cron, Hostinger cron, etc.) hitting the same
     endpoint with the `x-cron-secret` header.

On **localhost** there is no external pinger, so either set `CRON_IN_PROCESS=true`
in `.env.local` or hit the endpoint manually:

```bash
curl -s -H "x-cron-secret: $AUTOMATION_CRON_SECRET" \
     http://localhost:3000/api/cron/scheduler
```

Reminder punctuality is bounded by whichever interval you choose.

### 11.7 WhatsApp template language fix (#132001)

An earlier delivery failure was Meta error `#132001` (template name/language
mismatch): the saved `default_whatsapp_language` didn't match the template's
actual approved language. `reminder-delivery.ts` now looks the real language up
from `message_templates` by template name at send time rather than trusting the
saved default, so the reminder sends in the language Meta approved.
