"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import type { Deal, Pipeline, PipelineStage, Contact, Conversation } from "@/types";
import { GitBranch, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  contact: Contact;
  conversation?: Conversation | null;
}

/**
 * Inbox sidebar "Pipeline" section.
 *
 * Pipeline stage is a property of a DEAL, not the contact. This section
 * surfaces the contact's current stage (from their most-recent open deal)
 * and lets an agent move it inline — or create a lightweight deal in the
 * chosen stage if the contact has none yet, so the stage always has a
 * place to live.
 */
export function ContactPipeline({ contact, conversation }: Props) {
  const t = useTranslations("Inbox.pipeline");
  const { accountId, defaultCurrency, canSendMessages } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [pipelineId, setPipelineId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [pipeRes, dealRes] = await Promise.all([
      supabase.from("pipelines").select("*").order("created_at"),
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
    ]);
    const pipes = (pipeRes.data ?? []) as Pipeline[];
    const contactDeals = (dealRes.data ?? []) as Deal[];
    setPipelines(pipes);
    setDeals(contactDeals);

    // Default the pipeline selector to the open deal's pipeline, else the
    // first pipeline.
    const openDeal = contactDeals.find((d) => d.status === "open") ?? contactDeals[0];
    const initialPipeline = openDeal?.pipeline_id ?? pipes[0]?.id ?? "";
    setPipelineId(initialPipeline);
  }, [contact.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Load stages whenever the selected pipeline changes.
  useEffect(() => {
    if (!pipelineId) return;
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      if (!cancelled && data) setStages(data as PipelineStage[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [pipelineId]);

  // The deal whose stage this section controls: the most-recent open deal
  // in the selected pipeline, else the most-recent open deal anywhere.
  const activeDeal = useMemo(() => {
    const inPipeline = deals.filter((d) => d.pipeline_id === pipelineId && d.status === "open");
    if (inPipeline[0]) return inPipeline[0];
    return deals.find((d) => d.status === "open") ?? null;
  }, [deals, pipelineId]);

  const currentStageId = activeDeal?.stage_id ?? "";

  const handleStageChange = useCallback(
    async (newStageId: string) => {
      if (!accountId || !newStageId) return;
      setSaving(true);
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        setSaving(false);
        return;
      }

      if (activeDeal) {
        // Move the existing deal.
        const { error } = await supabase
          .from("deals")
          .update({ stage_id: newStageId })
          .eq("id", activeDeal.id);
        if (error) {
          toast.error(t("moveFailed"));
          setSaving(false);
          return;
        }
        setDeals((prev) =>
          prev.map((d) => (d.id === activeDeal.id ? { ...d, stage_id: newStageId } : d)),
        );
      } else {
        // No deal yet — create a lightweight one so the stage has a home.
        const { data, error } = await supabase
          .from("deals")
          .insert({
            account_id: accountId,
            user_id: user.id,
            pipeline_id: pipelineId,
            stage_id: newStageId,
            contact_id: contact.id,
            conversation_id: conversation?.id ?? null,
            title: contact.name || contact.phone || t("newDealTitle"),
            value: 0,
            currency: defaultCurrency,
            status: "open",
          })
          .select("*, stage:pipeline_stages(*)")
          .single();
        if (error || !data) {
          toast.error(t("createFailed"));
          setSaving(false);
          return;
        }
        setDeals((prev) => [data as Deal, ...prev]);
      }
      setSaving(false);
      toast.success(t("stageUpdated"));
    },
    [accountId, activeDeal, pipelineId, contact, conversation?.id, defaultCurrency, t],
  );

  if (pipelines.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <GitBranch className="h-3 w-3" />
        {t("title")}
      </div>

      <div className="mt-2 space-y-2">
        {pipelines.length > 1 && (
          <select
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
            disabled={!canSendMessages}
            className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <div className="relative">
          <select
            value={currentStageId}
            onChange={(e) => handleStageChange(e.target.value)}
            disabled={!canSendMessages || saving || stages.length === 0}
            className="h-8 w-full rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
          >
            <option value="">{t("noStage")}</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {saving && (
            <Loader2 className="absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>

        {!activeDeal && currentStageId === "" && (
          <p className="px-1 text-[11px] text-muted-foreground">{t("noDealHint")}</p>
        )}
      </div>
    </div>
  );
}
