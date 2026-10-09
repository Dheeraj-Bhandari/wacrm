"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import type { Activity, ActivityType, Contact, Conversation } from "@/types";
import {
  ACTIVITY_TYPES,
  buildActivityInsert,
  effectiveStatus,
  isOpen,
} from "@/lib/activities/client";
import {
  CalendarClock,
  Check,
  Phone,
  MessageSquare,
  Users,
  CheckSquare,
  Bell,
  Plus,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const TYPE_ICON: Record<ActivityType, typeof Phone> = {
  call: Phone,
  whatsapp_message: MessageSquare,
  meeting: Users,
  task: CheckSquare,
  reminder: Bell,
  email: Bell,
};

interface Props {
  contact: Contact;
  conversation?: Conversation | null;
}

/** Default the due-time picker to the next round half hour, local time. */
function defaultDueLocal(): string {
  const d = new Date(Date.now() + 30 * 60 * 1000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function ContactActivities({ contact, conversation }: Props) {
  const t = useTranslations("Inbox.activities");
  const { accountId, canSendMessages } = useAuth();

  const [activities, setActivities] = useState<Activity[]>([]);
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [type, setType] = useState<ActivityType>("call");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(defaultDueLocal);
  const [remind, setRemind] = useState(true);
  const [leadTimeMinutes, setLeadTimeMinutes] = useState(0);

  const fetchActivities = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("activities")
      .select("*")
      .eq("contact_id", contact.id)
      .order("due_at", { ascending: true });
    if (data) setActivities(data as Activity[]);
  }, [contact.id]);

  useEffect(() => {
    // Supabase callback sets state asynchronously, not in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchActivities();
  }, [fetchActivities]);

  // Load the account's reminder lead time so the composer schedules the
  // reminder the right number of minutes before the activity.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("reminder_settings")
        .select("lead_time_minutes")
        .eq("account_id", accountId)
        .maybeSingle();
      if (!cancelled && data) setLeadTimeMinutes(Number(data.lead_time_minutes) || 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const resetForm = useCallback(() => {
    setType("call");
    setTitle("");
    setDue(defaultDueLocal());
    setRemind(true);
    setShowForm(false);
  }, []);

  const handleAdd = useCallback(async () => {
    if (!accountId || !title.trim() || !due) return;
    setAdding(true);
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setAdding(false);
      return;
    }

    // datetime-local is local wall time; new Date() interprets it in the
    // browser's zone and toISOString() stores the absolute instant.
    const dueIso = new Date(due).toISOString();

    const row = buildActivityInsert({
      account_id: accountId,
      user_id: user.id,
      contact_id: contact.id,
      conversation_id: conversation?.id ?? null,
      type,
      title,
      due_at: dueIso,
      // A reminder with no per-activity channel config falls back to the
      // account's reminder_settings defaults at fire time. Passing an
      // empty object opts the activity into the scheduler. The lead time
      // shifts remind_at earlier than due_at.
      reminder_config: remind ? {} : null,
      leadTimeMinutes,
    });

    const { data, error } = await supabase
      .from("activities")
      .insert(row)
      .select()
      .single();
    setAdding(false);
    if (!error && data) {
      setActivities((prev) =>
        [...prev, data as Activity].sort(
          (a, b) => +new Date(a.due_at) - +new Date(b.due_at),
        ),
      );
      resetForm();
    }
  }, [accountId, title, due, type, remind, leadTimeMinutes, contact.id, conversation?.id, resetForm]);

  const setStatus = useCallback(
    async (id: string, status: "done" | "cancelled") => {
      const supabase = createClient();
      // Optimistic.
      setActivities((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, status, completed_at: status === "done" ? new Date().toISOString() : a.completed_at }
            : a,
        ),
      );
      await supabase
        .from("activities")
        .update({
          status,
          completed_at: status === "done" ? new Date().toISOString() : null,
        })
        .eq("id", id);
    },
    [],
  );

  const { open, past } = useMemo(() => {
    const now = new Date();
    const o: Activity[] = [];
    const p: Activity[] = [];
    for (const a of activities) {
      if (isOpen(effectiveStatus(a, now))) o.push(a);
      else p.push(a);
    }
    return { open: o, past: p };
  }, [activities]);

  return (
    <div>
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <CalendarClock className="h-3 w-3" />
          {t("title")}
        </div>
        {canSendMessages && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-muted"
            aria-label={t("add")}
          >
            <Plus className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
      </div>

      {showForm && (
        <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/40 p-2">
          <div className="flex flex-wrap gap-1">
            {ACTIVITY_TYPES.map((ty) => {
              const Icon = TYPE_ICON[ty];
              return (
                <button
                  key={ty}
                  onClick={() => setType(ty)}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                    type === ty
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  {t(`type_${ty}`)}
                </button>
              );
            })}
          </div>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            className="h-8 text-xs"
          />
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
          />
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={remind}
              onChange={(e) => setRemind(e.target.checked)}
              className="h-3 w-3 accent-[var(--primary)]"
            />
            {t("remindMe")}
          </label>
          <div className="flex gap-1">
            <Button
              size="sm"
              className="h-7 flex-1 text-xs"
              onClick={handleAdd}
              disabled={!title.trim() || !due || adding}
            >
              {t("save")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={resetForm}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 space-y-2">
        {open.length === 0 && past.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">{t("empty")}</p>
        ) : null}

        {open.map((a) => (
          <ActivityRow key={a.id} a={a} t={t} onDone={() => setStatus(a.id, "done")} onCancel={() => setStatus(a.id, "cancelled")} canAct={canSendMessages} />
        ))}

        {past.length > 0 && (
          <>
            <p className="px-1 pt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("pastHeading")}
            </p>
            {past.slice(0, 10).map((a) => (
              <ActivityRow key={a.id} a={a} t={t} past canAct={false} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ActivityRow({
  a,
  t,
  onDone,
  onCancel,
  past,
  canAct,
}: {
  a: Activity;
  t: ReturnType<typeof useTranslations>;
  onDone?: () => void;
  onCancel?: () => void;
  past?: boolean;
  canAct: boolean;
}) {
  const Icon = TYPE_ICON[a.type];
  const status = effectiveStatus(a);
  return (
    <div className={`rounded-lg bg-muted px-3 py-2 ${past ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium text-foreground">{a.title}</p>
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {format(new Date(a.due_at), "MMM d, HH:mm")}
            {status === "overdue" ? ` · ${t("overdue")}` : ""}
            {a.status === "done" ? ` · ${t("done")}` : ""}
            {a.status === "cancelled" ? ` · ${t("cancelled")}` : ""}
          </p>
          {a.reminder_error ? (
            <p className="mt-0.5 text-[11px] text-destructive">{a.reminder_error}</p>
          ) : null}
        </div>
        {canAct && (
          <div className="flex shrink-0 gap-0.5">
            <button
              onClick={onDone}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-background"
              aria-label={t("markDone")}
            >
              <Check className="h-3 w-3 text-primary" />
            </button>
            <button
              onClick={onCancel}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-background"
              aria-label={t("cancelActivity")}
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
