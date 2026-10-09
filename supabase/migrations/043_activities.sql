-- ============================================================
-- 043_activities.sql — Activities / tasks / reminders
--
-- The scheduling backbone for the CRM's "never miss a follow-up"
-- promise. One row per thing a user plans to do for (or about) a
-- contact: a call, a WhatsApp message, an email, a meeting, a generic
-- task, or a bare reminder. Rows with a `reminder_config` are picked up
-- by the scheduler cron (/api/cron/scheduler) at `remind_at` and turned
-- into an outbound WhatsApp template and/or email to the owning member,
-- plus an in-app notification.
--
-- Conventions mirror 006/017: IF NOT EXISTS everywhere, account_id is
-- the tenancy key, RLS via is_account_member() exactly like the deals
-- block (select = member, write = agent+). Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- accounts.timezone — the account's display timezone (IANA name,
-- e.g. "America/New_York"). NULL = treat as UTC / browser-local.
-- Scheduling itself never depends on this (every instant is stored
-- as an absolute TIMESTAMPTZ); it only groups "today" in the
-- Activities view and dashboard widget by the account's calendar day.
-- ------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN accounts.timezone IS
  'IANA timezone name for grouping activities/metrics by the account''s '
  'calendar day. NULL = UTC/browser-local. Does not affect when scheduled '
  'work fires — that is driven purely by absolute TIMESTAMPTZ instants.';

-- ============================================================
-- ACTIVITIES
--
-- `type`            — what kind of activity (call / whatsapp_message /
--                     email / task / meeting / reminder).
-- `due_at`          — when the activity is scheduled to happen.
-- `remind_at`       — when the reminder should fire (defaults to due_at
--                     client-side). NULL = never auto-remind.
-- `reminder_config` — optional delivery spec; see docs/activities-and-
--                     scheduling-design.md §2. NULL = this is a plain
--                     to-do with no auto-send.
-- `reminder_fired_at` — set by the scheduler when it delivered (or
--                     attempted) the reminder. Doubles as the claim/idempotency
--                     guard: the cron claims a row with a conditional UPDATE
--                     `... WHERE reminder_fired_at IS NULL`.
-- `reminder_error`  — last delivery error, surfaced in the UI.
-- status            — pending → done | cancelled; the scheduler flips a
--                     past-due pending row to 'overdue' so the UI and
--                     dashboard can surface it without a client-side clock.
-- ============================================================
CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Links are all nullable + SET NULL so an activity's history survives
  -- the deletion of the contact / conversation / deal it referenced
  -- (mirrors migration 004's pattern on deals / broadcast_recipients).
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  assigned_to UUID REFERENCES profiles(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'task'
    CHECK (type IN ('call', 'whatsapp_message', 'email', 'task', 'meeting', 'reminder')),
  title TEXT NOT NULL,
  notes TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  remind_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'cancelled', 'overdue')),
  reminder_config JSONB,
  reminder_fired_at TIMESTAMPTZ,
  reminder_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dashboard "today" + Activities list order by due_at within an account.
CREATE INDEX IF NOT EXISTS idx_activities_account_due
  ON activities(account_id, due_at);
-- Status filters (Today / Upcoming / Overdue / Done segments).
CREATE INDEX IF NOT EXISTS idx_activities_account_status
  ON activities(account_id, status);
-- Contact timeline (inbox sidebar section).
CREATE INDEX IF NOT EXISTS idx_activities_contact
  ON activities(contact_id) WHERE contact_id IS NOT NULL;
-- Scheduler hot path: unfired reminders that are due. Partial index keeps
-- it tiny — only rows the cron could possibly act on.
CREATE INDEX IF NOT EXISTS idx_activities_due_reminder
  ON activities(remind_at)
  WHERE status = 'pending'
    AND reminder_fired_at IS NULL
    AND reminder_config IS NOT NULL;

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;

-- RLS mirrors the deals block exactly: any member can read; agent+ writes.
DROP POLICY IF EXISTS activities_select ON activities;
CREATE POLICY activities_select ON activities FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS activities_insert ON activities;
CREATE POLICY activities_insert ON activities FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS activities_update ON activities;
CREATE POLICY activities_update ON activities FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS activities_delete ON activities;
CREATE POLICY activities_delete ON activities FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON activities;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- notifications.type — allow the scheduler to drop a 'reminder' row.
--
-- The 027 CHECK only permitted 'conversation_assigned'. The reminder
-- scheduler (service-role) inserts a notifications row when it fires a
-- reminder so it surfaces in the bell. Broaden the constraint to admit
-- 'reminder'. Rebuilt by name introspection since the 027 constraint
-- name is deterministic (notifications_type_check).
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
  END IF;
  ALTER TABLE notifications
    ADD CONSTRAINT notifications_type_check
    CHECK (type IN ('conversation_assigned', 'reminder'));
END $$;
