"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  BellRing,
  Phone,
  MessageSquare,
  Users,
  CheckSquare,
  Bell,
  Mail,
  X,
  Check,
  CalendarClock,
  Loader2,
} from "lucide-react";
import type { Activity, ActivityType } from "@/types";
import { Button } from "@/components/ui/button";
import {
  SNOOZE_PRESETS,
  snoozeDueAt,
  rescheduleUpdate,
  type SnoozePreset,
} from "@/lib/activities/client";

const TYPE_ICON: Record<ActivityType, typeof Phone> = {
  call: Phone,
  whatsapp_message: MessageSquare,
  meeting: Users,
  task: CheckSquare,
  reminder: Bell,
  email: Mail,
};

/** How often to check for newly-due reminders. */
const POLL_MS = 30_000;

type DueActivity = Activity & {
  contact?: { id: string; name: string | null; phone: string | null } | null;
};

/**
 * In-app reminder popup. Headless mount (dashboard shell) that polls the
 * current user's own activities for ones whose reminder time has
 * arrived and are still open, then surfaces a stacked popup with
 * Cancel / Reschedule / Done actions.
 *
 * Polling (not realtime) is deliberate: a reminder becomes due by the
 * passage of time, not by a DB write, so a time-based poll catches it
 * even when the server-side scheduler cron isn't running (e.g. local
 * dev). Dismissed ids are remembered for the tab's lifetime so the
 * popup doesn't re-nag every poll.
 */
export function ReminderPopup() {
  const { user, profile } = useAuth();
  const router = useRouter();
  const t = useTranslations("Activities.popup");

  const [due, setDue] = useState<DueActivity[]>([]);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Ids the user explicitly dismissed/acted on this session, so a poll
  // doesn't bring them back.
  const dismissed = useRef<Set<string>>(new Set());

  // activities.user_id is the author's auth user id; activities.assigned_to
  // is the profiles.id of the assignee. Match either so a reminder reaches
  // whoever owns it.
  const authUserId = user?.id ?? null;
  const profileId = profile?.id ?? null;

  const poll = useCallback(async () => {
    if (!authUserId) return;
    const supabase = createClient();
    const nowIso = new Date().toISOString();
    // Own activities (author or assignee) that opted into a reminder,
    // are still open, and whose reminder time has arrived.
    const { data } = await supabase
      .from("activities")
      .select("*, contact:contacts(id, name, phone)")
      .in("status", ["pending", "overdue"])
      .not("reminder_config", "is", null)
      .lte("remind_at", nowIso)
      .order("remind_at", { ascending: true })
      .limit(20);
    const rows = (data ?? []) as DueActivity[];
    // Only the current user's reminders (author or assignee). RLS already
    // scopes to the account; this narrows to "mine" so teammates don't
    // get each other's popups.
    const mine = rows.filter(
      (a) => a.user_id === authUserId || (profileId && a.assigned_to === profileId),
    );
    setDue(mine.filter((a) => !dismissed.current.has(a.id)));
  }, [authUserId, profileId]);

  useEffect(() => {
    if (!authUserId) return;
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [authUserId, poll]);

  const dismiss = useCallback((id: string) => {
    dismissed.current.add(id);
    setDue((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const markDone = useCallback(
    async (a: DueActivity) => {
      setBusyId(a.id);
      const supabase = createClient();
      const { error } = await supabase
        .from("activities")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .eq("id", a.id);
      setBusyId(null);
      if (error) {
        toast.error(t("updateFailed"));
        return;
      }
      toast.success(t("markedDone"));
      dismiss(a.id);
    },
    [dismiss, t],
  );

  const cancel = useCallback(
    async (a: DueActivity) => {
      setBusyId(a.id);
      const supabase = createClient();
      const { error } = await supabase
        .from("activities")
        .update({ status: "cancelled" })
        .eq("id", a.id);
      setBusyId(null);
      if (error) {
        toast.error(t("updateFailed"));
        return;
      }
      toast.success(t("cancelled"));
      dismiss(a.id);
    },
    [dismiss, t],
  );

  const confirmReschedule = useCallback(
    async (a: DueActivity) => {
      if (!rescheduleAt) return;
      setBusyId(a.id);
      const supabase = createClient();
      // New due time (local wall time -> absolute instant). Reset the
      // reminder so the scheduler can fire it again at the new time;
      // keep status pending.
      const dueIso = new Date(rescheduleAt).toISOString();
      const { error } = await supabase
        .from("activities")
        .update(rescheduleUpdate(dueIso))
        .eq("id", a.id);
      setBusyId(null);
      if (error) {
        toast.error(t("updateFailed"));
        return;
      }
      toast.success(t("rescheduled"));
      setRescheduleId(null);
      setRescheduleAt("");
      dismiss(a.id);
    },
    [rescheduleAt, dismiss, t],
  );

  // One-click snooze to a preset offset; re-arms the reminder.
  const snooze = useCallback(
    async (a: DueActivity, preset: SnoozePreset) => {
      setBusyId(a.id);
      const supabase = createClient();
      const { error } = await supabase
        .from("activities")
        .update(rescheduleUpdate(snoozeDueAt(preset)))
        .eq("id", a.id);
      setBusyId(null);
      if (error) {
        toast.error(t("updateFailed"));
        return;
      }
      toast.success(t("rescheduled"));
      dismiss(a.id);
    },
    [dismiss, t],
  );

  const openChat = useCallback(
    (a: DueActivity) => {
      if (a.conversation_id) router.push(`/inbox?c=${a.conversation_id}`);
      else router.push("/inbox");
    },
    [router],
  );

  if (due.length === 0) return null;

  // Show up to 3 at once; the rest wait for the next poll after these
  // are dealt with.
  const visible = due.slice(0, 3);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {visible.map((a) => {
        const Icon = TYPE_ICON[a.type] ?? Bell;
        const leadName = a.contact?.name || a.contact?.phone || "";
        const busy = busyId === a.id;
        const isRescheduling = rescheduleId === a.id;
        return (
          <div
            key={a.id}
            className="pointer-events-auto rounded-xl border border-border bg-card p-3 shadow-lg animate-in slide-in-from-right-4 fade-in-50"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <BellRing className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground">{t("title")}</p>
                <button
                  type="button"
                  onClick={() => openChat(a)}
                  className="mt-0.5 block w-full text-left"
                >
                  <span className="flex items-center gap-1.5">
                    <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium text-foreground">
                      {a.title}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {leadName ? `${leadName} · ` : ""}
                    {format(new Date(a.due_at), "MMM d, HH:mm")}
                  </span>
                </button>
              </div>
              <button
                type="button"
                onClick={() => dismiss(a.id)}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-muted"
                aria-label={t("dismiss")}
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>

            {isRescheduling ? (
              <div className="mt-2 space-y-2">
                <input
                  type="datetime-local"
                  value={rescheduleAt}
                  onChange={(e) => setRescheduleAt(e.target.value)}
                  className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary"
                />
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    className="h-7 flex-1 text-xs"
                    onClick={() => confirmReschedule(a)}
                    disabled={!rescheduleAt || busy}
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    {t("saveReschedule")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      setRescheduleId(null);
                      setRescheduleAt("");
                    }}
                  >
                    {t("back")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2 space-y-1.5">
              {/* Quick snooze presets */}
              <div className="flex flex-wrap items-center gap-0.5">
                <span className="mr-0.5 text-[10px] text-muted-foreground">
                  {t("snoozeLabel")}:
                </span>
                {SNOOZE_PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => snooze(a, p)}
                    disabled={busy}
                    className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                  >
                    {t(`snooze_${p}` as never)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => markDone(a)}
                  disabled={busy}
                >
                  <Check className="h-3 w-3" />
                  {t("done")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setRescheduleId(a.id);
                    // Default the picker to +1h from now, local wall time.
                    const d = new Date(Date.now() + 60 * 60 * 1000);
                    d.setMinutes(0, 0, 0);
                    const pad = (n: number) => String(n).padStart(2, "0");
                    setRescheduleAt(
                      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
                    );
                  }}
                  disabled={busy}
                >
                  <CalendarClock className="h-3 w-3" />
                  {t("reschedule")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => cancel(a)}
                  disabled={busy}
                >
                  <X className="h-3 w-3" />
                  {t("cancel")}
                </Button>
              </div>
              </div>
            )}
          </div>
        );
      })}
      {due.length > visible.length && (
        <p className="pointer-events-none text-center text-[11px] text-muted-foreground">
          {t("more", { count: due.length - visible.length })}
        </p>
      )}
    </div>
  );
}
