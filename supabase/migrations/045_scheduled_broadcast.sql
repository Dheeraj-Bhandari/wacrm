-- ============================================================
-- 045_scheduled_broadcast.sql — activate scheduled broadcasts
--
-- `broadcasts.scheduled_at` and the status value 'scheduled' have
-- existed since migration 001 but were never written or read by any
-- code. The scheduled-broadcast feature wires them up:
--
--   - A user schedules a draft → recipient rows are materialized with
--     frozen template_params (so the cron can send with no browser
--     context), status flips to 'scheduled', scheduled_at is set.
--   - /api/cron/scheduler selects broadcasts where status='scheduled'
--     AND scheduled_at <= now(), claims the delivery lock, and delivers.
--
-- No new columns are needed (scheduled_at + delivery_locked_at from 038
-- cover it). This migration only adds the partial index the cron's due
-- selection relies on.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_due
  ON broadcasts(scheduled_at)
  WHERE status = 'scheduled';
