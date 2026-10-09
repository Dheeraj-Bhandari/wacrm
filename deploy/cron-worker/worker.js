// Cloudflare Worker — pings the CRM scheduler on a Cron Trigger.
//
// On each scheduled tick it does a single authenticated GET to
// SCHEDULER_URL with the x-cron-secret header. The CRM drains due
// reminders + scheduled broadcasts and returns a JSON summary, which we
// log for the Worker's observability tail.
//
// Config (wrangler.toml + secret):
//   vars.SCHEDULER_URL  — e.g. https://crm.example.com/api/cron/scheduler
//   secret CRON_SECRET  — equals the app's AUTOMATION_CRON_SECRET

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ping(env));
  },

  // Also expose a manual GET so you can trigger a run from a browser or
  // curl while testing the Worker itself.
  async fetch(request, env) {
    const res = await ping(env);
    return new Response(JSON.stringify(res), {
      status: res.ok ? 200 : 502,
      headers: { 'content-type': 'application/json' },
    });
  },
};

async function ping(env) {
  if (!env.SCHEDULER_URL || !env.CRON_SECRET) {
    console.error('SCHEDULER_URL or CRON_SECRET not configured');
    return { ok: false, error: 'not configured' };
  }
  try {
    const resp = await fetch(env.SCHEDULER_URL, {
      method: 'GET',
      headers: { 'x-cron-secret': env.CRON_SECRET },
    });
    const body = await resp.text();
    if (!resp.ok) {
      console.error(`scheduler returned ${resp.status}: ${body}`);
      return { ok: false, status: resp.status, body };
    }
    console.log(`scheduler ok: ${body}`);
    return { ok: true, status: resp.status, body };
  } catch (err) {
    console.error('scheduler ping failed:', err);
    return { ok: false, error: String(err) };
  }
}
