// ============================================================
// Email sender — Resend driver.
//
// The only email transport in the app. Used by the reminder scheduler
// to deliver activity reminders by email. Deliberately pluggable and
// fail-soft: when RESEND_API_KEY / EMAIL_FROM are not configured, every
// call returns { ok: false, skipped: true } instead of throwing, so a
// reminder with an email channel degrades to "WhatsApp only" rather than
// failing the whole reminder.
//
// The Resend SDK is imported dynamically so its (heavy) dependency tree
// is only loaded in the request/worker that actually sends an email —
// not pulled into every server bundle that merely imports this module's
// types.
// ============================================================

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Optional plaintext alternative. */
  text?: string;
}

export type SendEmailResult =
  | { ok: true; id: string | null }
  /** Not sent because email is not configured — a soft skip, not a failure. */
  | { ok: false; skipped: true; error: string }
  /** Attempted and failed. */
  | { ok: false; skipped: false; error: string };

/** True when the Resend transport is configured. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

/**
 * Send a transactional email via Resend. Never throws — all failure
 * modes are returned so callers can record them (e.g. activity
 * reminder_error) and continue.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    return {
      ok: false,
      skipped: true,
      error: 'email not configured (set RESEND_API_KEY and EMAIL_FROM)',
    };
  }

  const to = input.to?.trim();
  if (!to) {
    return { ok: false, skipped: false, error: 'no recipient email address' };
  }

  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject: input.subject,
      html: input.html,
      ...(input.text ? { text: input.text } : {}),
    });
    if (error) {
      return {
        ok: false,
        skipped: false,
        error: error.message || 'Resend returned an error',
      };
    }
    return { ok: true, id: data?.id ?? null };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
