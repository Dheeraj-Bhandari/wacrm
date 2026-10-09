-- ============================================================
-- 046_reminder_lead_time_and_channel_tracking.sql
--
-- Three additions driven by the reminder/activity UX pass:
--
--   1. reminder_settings.lead_time_minutes — how far BEFORE an
--      activity's due time its reminder should fire (e.g. 25 = "remind
--      me 25 minutes before"). 0 = at due time. The inbox composer and
--      the scheduler use this to compute remind_at = due_at - lead_time.
--
--   2. activities.reminder_whatsapp_sent_at / reminder_email_sent_at —
--      per-channel delivery timestamps so the Activities UI can show
--      "WhatsApp reminder sent at …" / "Email reminder sent at …" on the
--      row. The single reminder_fired_at (migration 043) is the claim
--      guard; these two record which channels actually went out.
--
--   3. (bugfix enabler) nothing schema-side — the overdue-sweep lockout
--      is fixed in application code (scheduler.ts) by processing due
--      reminders for BOTH pending and overdue activities before the
--      sweep runs.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE reminder_settings
  ADD COLUMN IF NOT EXISTS lead_time_minutes INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN reminder_settings.lead_time_minutes IS
  'Minutes before an activity''s due time to fire its reminder. 0 = at due time. '
  'Applied when the activity opts into reminders without an explicit remind_at.';

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS reminder_whatsapp_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_email_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN activities.reminder_whatsapp_sent_at IS
  'When the WhatsApp reminder for this activity was successfully sent. NULL otherwise.';
COMMENT ON COLUMN activities.reminder_email_sent_at IS
  'When the email reminder for this activity was successfully sent. NULL otherwise.';

-- Broaden the scheduler''s hot-path index to include overdue activities,
-- since the fixed drain now also considers status='overdue' rows whose
-- reminder has not yet fired (the lockout bugfix).
DROP INDEX IF EXISTS idx_activities_due_reminder;
CREATE INDEX IF NOT EXISTS idx_activities_due_reminder
  ON activities(remind_at)
  WHERE status IN ('pending', 'overdue')
    AND reminder_fired_at IS NULL
    AND reminder_config IS NOT NULL;
