"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  Phone,
  MessageSquare,
  Users,
  CheckSquare,
  Bell,
  Mail,
  Loader2,
  Check,
  X,
  RotateCcw,
  CalendarClock,
  User as UserIcon,
} from "lucide-react";
import type {
  Activity,
  ActivityStatus,
  ActivityType,
  Profile,
} from "@/types";
import {
  ACTIVITY_TYPES,
  effectiveStatus,
  isOpen,
  SNOOZE_PRESETS,
  snoozeDueAt,
  rescheduleUpdate,
  type SnoozePreset,
} from "@/lib/activities/client";
import { startOfLocalDay } from "@/lib/dashboard/date-utils";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<ActivityType, typeof Phone> = {
  call: Phone,
  whatsapp_message: MessageSquare,
  meeting: Users,
  task: CheckSquare,
  reminder: Bell,
  email: Mail,
};

type Segment = "today" | "upcoming" | "overdue" | "done" | "all";

type ActivityRow = Omit<Activity, "contact"> & {
  contact?: { id: string; name: string | null; phone: string | null } | null;
};

export default function ActivitiesPage() {
  return (
    <Suspense fallback={null}>
      <ActivitiesPageInner />
    </Suspense>
  );
}

function ActivitiesPageInner() {
  const t = useTranslations("Activities");
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusId = searchParams.get("focus");
  const { accountId, canSendMessages } = useAuth();

  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // contactId -> most-recent conversationId, for "open chat" links.
  const [convByContact, setConvByContact] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  // When arriving with ?focus=, show everything so the row is visible.
  const [segment, setSegment] = useState<Segment>(focusId ? "all" : "today");
  // Row whose inline reschedule picker is open, and its datetime-local value.
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState("");

  const [typeFilter, setTypeFilter] = useState<ActivityType | "">("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const supabase = createClient();
    const [actRes, profRes] = await Promise.all([
      supabase
        .from("activities")
        .select("*, contact:contacts(id, name, phone)")
        .eq("account_id", accountId)
        .order("due_at", { ascending: true }),
      supabase.from("profiles").select("*").eq("account_id", accountId),
    ]);
    const acts = (actRes.data ?? []) as ActivityRow[];
    setActivities(acts);
    setProfiles((profRes.data ?? []) as Profile[]);

    // Resolve a conversation per contact so a row can open the chat.
    const contactIds = [
      ...new Set(acts.map((a) => a.contact?.id).filter((x): x is string => !!x)),
    ];
    if (contactIds.length > 0) {
      const { data: convs } = await supabase
        .from("conversations")
        .select("id, contact_id, last_message_at")
        .in("contact_id", contactIds)
        .order("last_message_at", { ascending: false });
      const map = new Map<string, string>();
      for (const c of (convs ?? []) as { id: string; contact_id: string }[]) {
        // First (most recent) wins.
        if (!map.has(c.contact_id)) map.set(c.contact_id, c.id);
      }
      setConvByContact(map);
    }
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    // Supabase callbacks set state asynchronously, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // activities.user_id (the author) maps to profiles.user_id. Build the
  // lookup for the "created by" line.
  const creatorByUser = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) m.set(p.user_id, p.full_name || p.email || "");
    return m;
  }, [profiles]);

  const setStatus = useCallback(
    async (id: string, status: ActivityStatus) => {
      const supabase = createClient();
      setActivities((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                ...a,
                status,
                completed_at: status === "done" ? new Date().toISOString() : null,
              }
            : a,
        ),
      );
      const { error } = await supabase
        .from("activities")
        .update({
          status,
          completed_at: status === "done" ? new Date().toISOString() : null,
        })
        .eq("id", id);
      if (error) {
        toast.error(t("toastUpdateFailed"));
        load();
      }
    },
    [load, t],
  );

  // Quick-reschedule (snooze) an activity to a preset offset. Re-arms the
  // reminder so it fires again at the new due time.
  const reschedule = useCallback(
    async (id: string, preset: SnoozePreset) => {
      const supabase = createClient();
      const patch = rescheduleUpdate(snoozeDueAt(preset));
      setActivities((prev) =>
        prev.map((a) =>
          a.id === id ? ({ ...a, ...patch } as ActivityRow) : a,
        ),
      );
      setRescheduleId(null);
      const { error } = await supabase.from("activities").update(patch).eq("id", id);
      if (error) {
        toast.error(t("toastUpdateFailed"));
        load();
      } else {
        toast.success(t("snoozeToast", { preset: t(`snooze_${preset}` as never) }));
      }
    },
    [load, t],
  );

  // Reschedule to an explicit date+time chosen in the inline picker.
  const rescheduleTo = useCallback(
    async (id: string, localValue: string) => {
      if (!localValue) return;
      const supabase = createClient();
      const patch = rescheduleUpdate(new Date(localValue).toISOString());
      setActivities((prev) =>
        prev.map((a) => (a.id === id ? ({ ...a, ...patch } as ActivityRow) : a)),
      );
      setRescheduleId(null);
      setRescheduleAt("");
      const { error } = await supabase.from("activities").update(patch).eq("id", id);
      if (error) {
        toast.error(t("toastUpdateFailed"));
        load();
      } else {
        toast.success(t("rescheduleToast"));
      }
    },
    [load, t],
  );

  // Open the lead's chat in the inbox. Prefer the activity's own
  // conversation, then the contact's most-recent conversation.
  const openChat = useCallback(
    (a: ActivityRow) => {
      const convId = a.conversation_id || (a.contact?.id ? convByContact.get(a.contact.id) : null);
      if (convId) {
        router.push(`/inbox?c=${convId}`);
      } else {
        // No conversation yet — land on the inbox so the agent can start one.
        router.push("/inbox");
      }
    },
    [convByContact, router],
  );

  const filtered = useMemo(() => {
    const now = new Date();
    const todayStart = startOfLocalDay(now);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);
    const from = fromDate ? new Date(fromDate) : null;
    const to = toDate ? new Date(`${toDate}T23:59:59`) : null;

    return activities.filter((a) => {
      const eff = effectiveStatus(a, now);
      const due = new Date(a.due_at);

      if (segment === "today") {
        if (!(due >= todayStart && due < todayEnd)) return false;
        if (!isOpen(eff)) return false;
      } else if (segment === "upcoming") {
        if (!(due >= todayEnd)) return false;
        if (!isOpen(eff)) return false;
      } else if (segment === "overdue") {
        if (eff !== "overdue") return false;
      } else if (segment === "done") {
        if (a.status !== "done" && a.status !== "cancelled") return false;
      }

      if (typeFilter && a.type !== typeFilter) return false;
      if (assigneeFilter) {
        if (assigneeFilter === "__unassigned__") {
          if (a.assigned_to) return false;
        } else if (a.assigned_to !== assigneeFilter) {
          return false;
        }
      }
      if (from && due < from) return false;
      if (to && due > to) return false;

      return true;
    });
  }, [activities, segment, typeFilter, assigneeFilter, fromDate, toDate]);

  // Scroll the focused activity into view once it's rendered.
  const focusRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusId && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusId, filtered]);

  const clearFilters = useCallback(() => {
    setTypeFilter("");
    setAssigneeFilter("");
    setFromDate("");
    setToDate("");
  }, []);

  const SEGMENTS: Segment[] = ["today", "upcoming", "overdue", "done", "all"];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <CalendarClock className="h-6 w-6 text-primary" />
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {/* Segmented control */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
        {SEGMENTS.map((s) => (
          <button
            key={s}
            onClick={() => setSegment(s)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              segment === s
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t(`segment${s.charAt(0).toUpperCase()}${s.slice(1)}` as never)}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground">{t("filterType")}</label>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as ActivityType | "")}
            className="h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
          >
            <option value="">{t("allTypes")}</option>
            {ACTIVITY_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`type_${ty}` as never)}
              </option>
            ))}
          </select>
        </div>

        {profiles.length > 0 && (
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">{t("filterAssignee")}</label>
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value="">{t("allAssignees")}</option>
              <option value="__unassigned__">{t("unassigned")}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name || p.email}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground">{t("from")}</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </div>
        <div className="grid gap-1">
          <label className="text-xs text-muted-foreground">{t("to")}</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="h-8 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </div>

        {(typeFilter || assigneeFilter || fromDate || toDate) && (
          <button
            onClick={clearFilters}
            className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("clearFilters")}
          </button>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card py-16 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <ul className="divide-y divide-border">
            {filtered.map((a) => {
              const Icon = TYPE_ICON[a.type];
              const eff = effectiveStatus(a);
              const overdue = eff === "overdue";
              const closed = a.status === "done" || a.status === "cancelled";
              const focused = focusId === a.id;
              const leadName = a.contact?.name || a.contact?.phone || t("noContact");
              const createdBy = creatorByUser.get(a.user_id) || t("unknownCreator");
              const canOpenChat = Boolean(
                a.conversation_id || (a.contact?.id && convByContact.get(a.contact.id)),
              );
              return (
                <li
                  key={a.id}
                  ref={focused ? focusRef : null}
                  className={cn(
                    "flex items-start gap-3 px-4 py-3 transition-colors",
                    focused ? "bg-primary/5 ring-1 ring-inset ring-primary/40" : "hover:bg-muted/40",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full",
                      overdue
                        ? "bg-destructive/10 text-destructive"
                        : closed
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary/10 text-primary",
                    )}
                    title={t(`type_${a.type}` as never)}
                  >
                    <Icon className="h-4 w-4" />
                  </span>

                  {/* Clicking the main body opens the lead's chat. */}
                  <button
                    type="button"
                    onClick={() => openChat(a)}
                    className="min-w-0 flex-1 text-left"
                    title={canOpenChat ? t("openChat") : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t(`type_${a.type}` as never)}
                      </span>
                      <p
                        className={cn(
                          "truncate text-sm font-medium text-foreground",
                          a.status === "cancelled" && "line-through",
                        )}
                      >
                        {a.title}
                      </p>
                    </div>

                    {/* Lead + phone */}
                    <p className="mt-1 truncate text-xs text-foreground">
                      <span className="text-muted-foreground">{t("leadLabel")}:</span>{" "}
                      {leadName}
                      {a.contact?.phone ? (
                        <span className="text-muted-foreground"> · {a.contact.phone}</span>
                      ) : null}
                    </p>

                    {/* Due + creator */}
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className={overdue ? "text-destructive" : ""}>
                        {t("dueLabel")}: {format(new Date(a.due_at), "MMM d, yyyy HH:mm")}
                        {overdue ? ` · ${t("overdue")}` : ""}
                        {a.status === "done" ? ` · ${t("statusDone")}` : ""}
                        {a.status === "cancelled" ? ` · ${t("statusCancelled")}` : ""}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <UserIcon className="h-3 w-3" />
                        {t("createdBy", { name: createdBy })}
                      </span>
                    </p>

                    {/* Reminder-sent indicators */}
                    {(a.reminder_whatsapp_sent_at ||
                      a.reminder_email_sent_at ||
                      a.reminder_error) && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px]">
                        {a.reminder_whatsapp_sent_at && (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <MessageSquare className="h-3 w-3" />
                            {t("waReminderSent", {
                              when: format(new Date(a.reminder_whatsapp_sent_at), "MMM d, HH:mm"),
                            })}
                          </span>
                        )}
                        {a.reminder_email_sent_at && (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <Mail className="h-3 w-3" />
                            {t("emailReminderSent", {
                              when: format(new Date(a.reminder_email_sent_at), "MMM d, HH:mm"),
                            })}
                          </span>
                        )}
                        {a.reminder_error && (
                          <span className="text-destructive">{a.reminder_error}</span>
                        )}
                      </p>
                    )}
                  </button>

                  {canSendMessages && (
                    <div className="flex flex-shrink-0 flex-col items-end gap-1">
                      <div className="flex gap-0.5">
                      {isOpen(eff) ? (
                        <>
                          <button
                            onClick={() => setStatus(a.id, "done")}
                            className="flex h-7 w-7 items-center justify-center rounded hover:bg-background"
                            aria-label={t("markDone")}
                            title={t("markDone")}
                          >
                            <Check className="h-4 w-4 text-primary" />
                          </button>
                          <button
                            onClick={() => setStatus(a.id, "cancelled")}
                            className="flex h-7 w-7 items-center justify-center rounded hover:bg-background"
                            aria-label={t("cancelActivity")}
                            title={t("cancelActivity")}
                          >
                            <X className="h-4 w-4 text-muted-foreground" />
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setStatus(a.id, "pending")}
                          className="flex h-7 w-7 items-center justify-center rounded hover:bg-background"
                          aria-label={t("reopen")}
                          title={t("reopen")}
                        >
                          <RotateCcw className="h-4 w-4 text-muted-foreground" />
                        </button>
                      )}
                      </div>
                      {/* Quick-reschedule presets + explicit Reschedule
                          (only while actionable) */}
                      {isOpen(eff) && (
                        <>
                          <div className="flex flex-wrap items-center justify-end gap-0.5">
                            <span className="mr-0.5 self-center text-[10px] text-muted-foreground">
                              {t("snoozeLabel")}:
                            </span>
                            {SNOOZE_PRESETS.map((p) => (
                              <button
                                key={p}
                                onClick={() => reschedule(a.id, p)}
                                className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                                title={t("snoozeTitle", { preset: t(`snooze_${p}` as never) })}
                              >
                                {t(`snooze_${p}` as never)}
                              </button>
                            ))}
                            <button
                              onClick={() => {
                                if (rescheduleId === a.id) {
                                  setRescheduleId(null);
                                  return;
                                }
                                // Default the picker to +1h, local wall time.
                                const d = new Date(Date.now() + 60 * 60 * 1000);
                                d.setMinutes(0, 0, 0);
                                const pad = (n: number) => String(n).padStart(2, "0");
                                setRescheduleAt(
                                  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
                                );
                                setRescheduleId(a.id);
                              }}
                              className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                              title={t("reschedule")}
                            >
                              <CalendarClock className="h-3 w-3" />
                              {t("reschedule")}
                            </button>
                          </div>

                          {/* Inline datetime picker */}
                          {rescheduleId === a.id && (
                            <div className="flex items-center justify-end gap-1">
                              <input
                                type="datetime-local"
                                value={rescheduleAt}
                                onChange={(e) => setRescheduleAt(e.target.value)}
                                className="h-7 rounded-md border border-border bg-muted px-2 text-[11px] text-foreground outline-none focus:border-primary"
                              />
                              <button
                                onClick={() => rescheduleTo(a.id, rescheduleAt)}
                                disabled={!rescheduleAt}
                                className="rounded bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                              >
                                {t("rescheduleSave")}
                              </button>
                              <button
                                onClick={() => {
                                  setRescheduleId(null);
                                  setRescheduleAt("");
                                }}
                                className="rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
                              >
                                {t("rescheduleCancel")}
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
