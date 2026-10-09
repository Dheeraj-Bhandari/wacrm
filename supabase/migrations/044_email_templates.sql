-- ============================================================
-- 044_email_templates.sql — Email templates + per-account reminder prefs
--
-- Two tables:
--   email_templates   — reusable email bodies (subject + HTML/text),
--                        with {{placeholder}} interpolation at send time.
--                        Managed under Settings → Email templates.
--   reminder_settings — one row per account holding the member's default
--                        reminder channels: which WhatsApp template to
--                        send, which email template to use, and where to
--                        send them (member WhatsApp number + email).
--                        Per-activity reminder_config (migration 043)
--                        overrides these defaults when present.
--
-- Idempotent — safe to re-run. account_id tenancy + is_account_member
-- RLS, same shape as the settings-class tables in 017.
-- ============================================================

-- ============================================================
-- EMAIL_TEMPLATES
-- ============================================================
CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One template name per account (so pickers and the reminder default
-- reference are unambiguous).
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_account_name
  ON email_templates(account_id, lower(name));

ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;

-- Settings-class, but templates are used by agents composing reminders,
-- so writes are agent+ (consistent with activities, not admin-only like
-- WhatsApp templates which touch the Meta integration).
DROP POLICY IF EXISTS email_templates_select ON email_templates;
CREATE POLICY email_templates_select ON email_templates FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS email_templates_insert ON email_templates;
CREATE POLICY email_templates_insert ON email_templates FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS email_templates_update ON email_templates;
CREATE POLICY email_templates_update ON email_templates FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS email_templates_delete ON email_templates;
CREATE POLICY email_templates_delete ON email_templates FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON email_templates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON email_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- REMINDER_SETTINGS — one row per account (PK = account_id).
-- ============================================================
CREATE TABLE IF NOT EXISTS reminder_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Default WhatsApp template (name + language) fired for reminders.
  default_whatsapp_template TEXT,
  default_whatsapp_language TEXT DEFAULT 'en_US',
  -- Default email template to render for reminders.
  default_email_template_id UUID REFERENCES email_templates(id) ON DELETE SET NULL,
  -- Where reminders are delivered — the member/agent's own channels.
  notify_whatsapp_number TEXT,
  notify_email TEXT,
  -- Master switches so an account can keep config but pause delivery.
  whatsapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE reminder_settings ENABLE ROW LEVEL SECURITY;

-- Settings-class: readable by any member, writable by admin+ (it carries
-- account-wide delivery config, same tier as whatsapp_config).
DROP POLICY IF EXISTS reminder_settings_select ON reminder_settings;
CREATE POLICY reminder_settings_select ON reminder_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS reminder_settings_insert ON reminder_settings;
CREATE POLICY reminder_settings_insert ON reminder_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS reminder_settings_update ON reminder_settings;
CREATE POLICY reminder_settings_update ON reminder_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS reminder_settings_delete ON reminder_settings;
CREATE POLICY reminder_settings_delete ON reminder_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON reminder_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON reminder_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
