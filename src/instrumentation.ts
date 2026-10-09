// ============================================================
// Next.js instrumentation hook.
//
// `register()` runs once per server instance, before the server handles
// requests. We use it to start the optional in-process scheduler cron
// (activity reminders + scheduled broadcasts) when CRON_IN_PROCESS=true.
//
// Guarded to the Node.js runtime: the Edge runtime has no long-lived
// process to host an interval, and serverless/edge hosts should drive
// the scheduler with a platform cron hitting GET /api/cron/scheduler
// instead. See src/lib/cron/in-process-runner.ts for the full rationale.
// ============================================================

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startInProcessCron } = await import('@/lib/cron/in-process-runner');
    startInProcessCron();
  }
}
