"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import type { ComponentType } from "react";
import { format } from "date-fns";
import {
  Phone,
  MessageSquare,
  Users,
  CheckSquare,
  Bell,
  Mail,
  CalendarClock,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ActivityType } from "@/types";
import type { TodayActivitiesBundle } from "@/lib/dashboard/types";
import { createClient } from "@/lib/supabase/client";
import {
  SNOOZE_PRESETS,
  snoozeDueAt,
  rescheduleUpdate,
  type SnoozePreset,
} from "@/lib/activities/client";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";
import { Skeleton } from "./skeleton";

interface Props {
  data: TodayActivitiesBundle | null;
  loading: boolean;
  /** Called after a successful quick-reschedule so the widget can refresh. */
  onReschedule?: () => void;
}

const TYPE_ICON: Record<ActivityType, ComponentType<{ className?: string }>> = {
  call: Phone,
  whatsapp_message: MessageSquare,
  meeting: Users,
  task: CheckSquare,
  reminder: Bell,
  email: Mail,
};

export function TodaysActivities({ data, loading, onReschedule }: Props) {
  const t = useTranslations("Dashboard.todaysActivities");
  const ta = useTranslations("Activities");
  const [busyId, setBusyId] = useState<string | null>(null);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const moreCount = Math.max(0, total - items.length);

  const reschedule = useCallback(
    async (id: string, preset: SnoozePreset) => {
      setBusyId(id);
      const supabase = createClient();
      const { error } = await supabase
        .from("activities")
        .update(rescheduleUpdate(snoozeDueAt(preset)))
        .eq("id", id);
      setBusyId(null);
      if (error) {
        toast.error(ta("toastUpdateFailed"));
        return;
      }
      toast.success(ta("snoozeToast", { preset: ta(`snooze_${preset}` as never) }));
      onReschedule?.();
    },
    [onReschedule, ta],
  );

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">{t("title")}</h2>
          {total > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary tabular-nums">
              {total}
            </span>
          )}
        </div>
        <Link
          href="/activities"
          className="text-xs font-medium text-primary hover:text-primary/80"
        >
          {t("viewAll")}
        </Link>
      </header>

      {loading || !data ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="p-5">
          <EmptyState
            icon={CalendarClock}
            title={t("empty")}
            hint={t("emptyHint")}
          />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {items.map((it) => {
              const Icon = TYPE_ICON[it.type];
              const overdue = it.status === "overdue";
              const busy = busyId === it.id;
              return (
                <li key={it.id} className="px-5 py-2.5">
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full",
                        overdue
                          ? "bg-destructive/10 text-destructive"
                          : "bg-primary/10 text-primary",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>

                    {/* Row body deep-links to the Activities section. */}
                    <Link
                      href={`/activities?focus=${it.id}`}
                      className="min-w-0 flex-1"
                    >
                      <div className="flex items-center gap-2">
                        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {ta(`type_${it.type}` as never)}
                        </span>
                        <p className="truncate text-sm font-medium text-foreground">
                          {it.title}
                        </p>
                      </div>
                      {(it.contactName || it.contactPhone) && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {it.contactName}
                          {it.contactName && it.contactPhone ? " · " : ""}
                          {it.contactPhone}
                        </p>
                      )}
                    </Link>

                    <span
                      className={cn(
                        "flex-shrink-0 text-xs tabular-nums",
                        overdue ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {overdue ? t("overdue") : format(new Date(it.due_at), "HH:mm")}
                    </span>
                  </div>

                  {/* Quick-reschedule presets */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-0.5 pl-10">
                    <span className="mr-0.5 text-[10px] text-muted-foreground">
                      {ta("snoozeLabel")}:
                    </span>
                    {SNOOZE_PRESETS.map((p) => (
                      <button
                        key={p}
                        onClick={() => reschedule(it.id, p)}
                        disabled={busy}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                        title={ta("snoozeTitle", { preset: ta(`snooze_${p}` as never) })}
                      >
                        {ta(`snooze_${p}` as never)}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {moreCount > 0 && (
            <footer className="border-t border-border px-5 py-3 text-center text-xs">
              <Link href="/activities" className="font-medium text-primary hover:text-primary/80">
                {t("more", { count: moreCount })}
              </Link>
            </footer>
          )}
        </>
      )}
    </section>
  );
}
