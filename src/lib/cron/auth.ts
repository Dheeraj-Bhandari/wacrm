// ============================================================
// Shared cron-secret auth.
//
// All scheduled endpoints (/api/automations/cron, /api/flows/cron,
// /api/cron/scheduler) authenticate the same way: a shared secret in
// the `x-cron-secret` header, compared timing-safe against the
// AUTOMATION_CRON_SECRET env var. This centralises that check so the
// comparison stays constant-time and consistent across endpoints.
// ============================================================

import { timingSafeEqual } from 'node:crypto';

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Validate the cron secret on an incoming request. Returns a discriminated
 * result the route maps to a response:
 *   - 503 when the secret is not configured on the server,
 *   - 401 when the presented secret is missing or wrong.
 */
export function checkCronSecret(request: Request): CronAuthResult {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return { ok: false, status: 503, error: 'cron not configured' };
  }
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}
