-- ============================================================
-- 047_reminder_multi_leadtime_and_varmap.sql
--
-- Reminder UX v3:
--
--   1. reminder_settings.lead_times_minutes INT[] — multiple lead times
--      so one activity fires several reminders (e.g. 1 day, 1 hour, and
--      15 min before). Supersedes the single lead_time_minutes (046),
--      which is kept and backfilled into the array for compatibility.
--
--   2. reminder_settings.whatsapp_variable_map JSONB — maps each WhatsApp
--      template positional variable ({{1}}, {{2}}, …) to a source
--      ("lead_name" | "custom:<id>" | "tag_list" | …) plus a default
--      fallback value. Shape: { "1": { "source": "...", "default": "..." }, … }.
--
--   3. activities.reminder_fired_offsets JSONB — the set of lead-time
--      offsets (in minutes) whose reminder has already fired for this
--      activity, so each configured offset fires exactly once. Default
--      '[]'. The legacy reminder_fired_at (043) remains as the "0-offset
--      fired / fully done" marker for older rows.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE reminder_settings
  ADD COLUMN IF NOT EXISTS lead_times_minutes INTEGER[] NOT NULL DEFAULT ARRAY[0],
  ADD COLUMN IF NOT EXISTS whatsapp_variable_map JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN reminder_settings.lead_times_minutes IS
  'Lead times (minutes before due) at which a reminder fires. Each value '
  'produces one reminder. [0] = only at due time. Supersedes lead_time_minutes.';
COMMENT ON COLUMN reminder_settings.whatsapp_variable_map IS
  'Maps WhatsApp template positional variables to a source + default. '
  'Shape: {"1":{"source":"lead_name","default":""}, ...}.';

-- Backfill the array from the single-value column where the array is
-- still at its default and a non-zero single lead time was set.
UPDATE reminder_settings
SET lead_times_minutes = ARRAY[lead_time_minutes]
WHERE lead_time_minutes IS NOT NULL
  AND lead_time_minutes <> 0
  AND lead_times_minutes = ARRAY[0];

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS reminder_fired_offsets JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN activities.reminder_fired_offsets IS
  'Lead-time offsets (minutes) whose reminder has already fired for this '
  'activity, so each configured offset fires exactly once.';
