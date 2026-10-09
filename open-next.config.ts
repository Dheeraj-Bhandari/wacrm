import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Minimal config: no incremental cache configured, so ISR/"use cache"
// fall back to no caching. This app is almost entirely per-request,
// server-rendered dashboard pages (Supabase auth per request), so
// there is nothing to cache at the edge anyway. Add an R2 incremental
// cache here later if you introduce ISR pages.
export default defineCloudflareConfig();
