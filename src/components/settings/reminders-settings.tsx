"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, BellRing, Loader2, MessageSquare, Mail } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import type {
  CustomField,
  EmailTemplate,
  MessageTemplate,
  ReminderSettings,
  ReminderVariableMapping,
} from "@/types";
import {
  REMINDER_DYNAMIC_KEYS,
  countTemplateVariables,
} from "@/lib/activities/dynamic-values";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

interface FormState {
  default_whatsapp_template: string;
  default_whatsapp_language: string;
  default_email_template_id: string;
  notify_whatsapp_number: string;
  notify_email: string;
  whatsapp_enabled: boolean;
  email_enabled: boolean;
  lead_times_minutes: number[];
  whatsapp_variable_map: Record<string, ReminderVariableMapping>;
}

const EMPTY: FormState = {
  default_whatsapp_template: "",
  default_whatsapp_language: "en_US",
  default_email_template_id: "",
  notify_whatsapp_number: "",
  notify_email: "",
  whatsapp_enabled: true,
  email_enabled: true,
  lead_times_minutes: [0],
  whatsapp_variable_map: {},
};

/** Preset lead-time options (minutes before the activity). */
const LEAD_TIME_OPTIONS = [0, 5, 10, 15, 25, 30, 60, 120, 240, 1440] as const;

const EXAMPLE_EMAIL_TEMPLATE = {
  name: "Activity reminder",
  subject: "Reminder: {{activity_title}} with {{lead_name}}",
  body_html:
    "<p>Hi,</p>" +
    "<p>This is a reminder for your upcoming activity:</p>" +
    "<ul>" +
    "<li><strong>What:</strong> {{activity_title}}</li>" +
    "<li><strong>Lead:</strong> {{lead_name}} ({{lead_phone}})</li>" +
    "<li><strong>Company:</strong> {{lead_company}}</li>" +
    "<li><strong>Deal:</strong> {{deal_title}} — {{deal_stage}}</li>" +
    "<li><strong>Due:</strong> {{activity_due}}</li>" +
    "</ul>" +
    "<p><strong>Notes:</strong> {{activity_notes}}</p>" +
    "<p>Recent conversation:</p>" +
    "<blockquote>{{last_messages}}</blockquote>",
  body_text:
    "Reminder: {{activity_title}} with {{lead_name}} ({{lead_phone}}) — due {{activity_due}}. Notes: {{activity_notes}}",
};

const EXAMPLE_WHATSAPP_BODY =
  "Hi 👋 Reminder: you have *{{2}}* with {{1}} coming up at {{3}}. " +
  "Open your CRM to view the lead and recent conversation.";

export function RemindersSettings() {
  const t = useTranslations("Settings.reminders");
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();

  const [form, setForm] = useState<FormState>(EMPTY);
  const [initial, setInitial] = useState<FormState>(EMPTY);
  const [waTemplates, setWaTemplates] = useState<MessageTemplate[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [settingsRes, waRes, emailRes, cfRes] = await Promise.all([
      supabase.from("reminder_settings").select("*").eq("account_id", accountId).maybeSingle(),
      supabase
        .from("message_templates")
        .select("*")
        .eq("account_id", accountId)
        .eq("status", "APPROVED")
        .order("name"),
      supabase.from("email_templates").select("*").eq("account_id", accountId).order("name"),
      supabase.from("custom_fields").select("*").eq("account_id", accountId).order("field_name"),
    ]);

    setWaTemplates((waRes.data ?? []) as MessageTemplate[]);
    setEmailTemplates((emailRes.data ?? []) as EmailTemplate[]);
    setCustomFields((cfRes.data ?? []) as CustomField[]);

    const row = settingsRes.data as ReminderSettings | null;
    const leadTimes =
      Array.isArray(row?.lead_times_minutes) && row!.lead_times_minutes.length > 0
        ? row!.lead_times_minutes
        : row?.lead_time_minutes != null
          ? [Number(row.lead_time_minutes) || 0]
          : [0];
    const next: FormState = row
      ? {
          default_whatsapp_template: row.default_whatsapp_template ?? "",
          default_whatsapp_language: row.default_whatsapp_language ?? "en_US",
          default_email_template_id: row.default_email_template_id ?? "",
          notify_whatsapp_number: row.notify_whatsapp_number ?? "",
          notify_email: row.notify_email ?? "",
          whatsapp_enabled: row.whatsapp_enabled,
          email_enabled: row.email_enabled,
          lead_times_minutes: [...new Set(leadTimes)].sort((a, b) => a - b),
          whatsapp_variable_map: (row.whatsapp_variable_map ?? {}) as Record<
            string,
            ReminderVariableMapping
          >,
        }
      : EMPTY;
    setForm(next);
    setInitial(next);
    setLoading(false);
  }, [accountId, supabase]);

  useEffect(() => {
    // load sets state inside an async Supabase callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  // The selected WhatsApp template's body + how many positional vars it
  // needs. Drives the mapping UI + the "map these" warning.
  const selectedWaTemplate = useMemo(
    () => waTemplates.find((tpl) => tpl.name === form.default_whatsapp_template) ?? null,
    [waTemplates, form.default_whatsapp_template],
  );
  const waVarCount = useMemo(
    () => countTemplateVariables(selectedWaTemplate?.body_text ?? ""),
    [selectedWaTemplate],
  );

  // Curated source options for the mapping dropdowns: built-ins + tags +
  // every account custom field.
  const sourceOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      ...REMINDER_DYNAMIC_KEYS.map((k) => ({ value: k, label: k })),
      { value: "tag_list", label: "tag_list" },
      ...customFields.map((cf) => ({
        value: `custom:${cf.id}`,
        label: `custom: ${cf.field_name}`,
      })),
    ];
    return opts;
  }, [customFields]);

  // Which required params are still unmapped (for the warning).
  const unmappedIndices = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i <= waVarCount; i++) {
      const m = form.whatsapp_variable_map[String(i)];
      if (!m?.source && !m?.default) out.push(i);
    }
    return out;
  }, [waVarCount, form.whatsapp_variable_map]);

  function setVarMap(index: number, patch: Partial<ReminderVariableMapping>) {
    setForm((f) => {
      const key = String(index);
      const current = f.whatsapp_variable_map[key] ?? { source: "", default: "" };
      return {
        ...f,
        whatsapp_variable_map: {
          ...f.whatsapp_variable_map,
          [key]: { ...current, ...patch },
        },
      };
    });
  }

  function toggleLeadTime(minutes: number) {
    setForm((f) => {
      const has = f.lead_times_minutes.includes(minutes);
      let next = has
        ? f.lead_times_minutes.filter((m) => m !== minutes)
        : [...f.lead_times_minutes, minutes];
      if (next.length === 0) next = [0]; // never empty
      return { ...f, lead_times_minutes: [...new Set(next)].sort((a, b) => a - b) };
    });
  }

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    // Prune the variable map to only the params the template needs.
    const prunedMap: Record<string, ReminderVariableMapping> = {};
    for (let i = 1; i <= waVarCount; i++) {
      const m = form.whatsapp_variable_map[String(i)];
      if (m && (m.source || m.default)) prunedMap[String(i)] = m;
    }
    const payload = {
      account_id: accountId,
      default_whatsapp_template: form.default_whatsapp_template || null,
      default_whatsapp_language: form.default_whatsapp_language || "en_US",
      default_email_template_id: form.default_email_template_id || null,
      notify_whatsapp_number: form.notify_whatsapp_number.trim() || null,
      notify_email: form.notify_email.trim() || null,
      whatsapp_enabled: form.whatsapp_enabled,
      email_enabled: form.email_enabled,
      // Keep the legacy single column in sync with the smallest offset.
      lead_time_minutes: Math.min(...form.lead_times_minutes),
      lead_times_minutes: form.lead_times_minutes,
      whatsapp_variable_map: prunedMap,
    };
    const { error } = await supabase
      .from("reminder_settings")
      .upsert(payload, { onConflict: "account_id" });
    setSaving(false);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    setInitial({ ...form, whatsapp_variable_map: prunedMap });
    setForm((f) => ({ ...f, whatsapp_variable_map: prunedMap }));
    toast.success(t("saved"));
  }

  const [seedingEmail, setSeedingEmail] = useState(false);
  async function seedExampleEmailTemplate() {
    if (!accountId) return;
    setSeedingEmail(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setSeedingEmail(false);
      toast.error(t("notSignedIn"));
      return;
    }
    const existing = emailTemplates.find(
      (tpl) => tpl.name.toLowerCase() === EXAMPLE_EMAIL_TEMPLATE.name.toLowerCase(),
    );
    let id = existing?.id ?? "";
    if (!existing) {
      const { data, error } = await supabase
        .from("email_templates")
        .insert({ ...EXAMPLE_EMAIL_TEMPLATE, account_id: accountId, user_id: user.id })
        .select()
        .single();
      if (error || !data) {
        setSeedingEmail(false);
        toast.error(t("seedEmailFailed"));
        return;
      }
      id = data.id as string;
      setEmailTemplates((prev) => [...prev, data as EmailTemplate]);
    }
    setForm((f) => ({ ...f, default_email_template_id: id, email_enabled: true }));
    setSeedingEmail(false);
    toast.success(t("seedEmailDone"));
  }

  async function copyWhatsappBody() {
    await navigator.clipboard.writeText(EXAMPLE_WHATSAPP_BODY);
    toast.success(t("waBodyCopied"));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const disabled = !canEditSettings;

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      {/* Lead times — pick several; one reminder fires per selected time */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <BellRing className="size-4 text-primary" />
            {t("leadTimeTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("leadTimeMultiDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {LEAD_TIME_OPTIONS.map((m) => {
              const active = form.lead_times_minutes.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleLeadTime(m)}
                  disabled={disabled}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === 0 ? t("leadTimeAtDue") : t("leadTimeBefore", { minutes: m })}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t("leadTimeMultiHint")}</p>
        </CardContent>
      </Card>

      {/* WhatsApp reminders */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <MessageSquare className="size-4 text-primary" />
              {t("whatsappTitle")}
            </CardTitle>
            <Switch
              checked={form.whatsapp_enabled}
              onCheckedChange={(v) =>
                setForm((f) => ({ ...f, whatsapp_enabled: Boolean(v) }))
              }
              disabled={disabled}
            />
          </div>
          <CardDescription className="text-muted-foreground">
            {t("whatsappDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("notifyNumber")}</Label>
            <Input
              value={form.notify_whatsapp_number}
              onChange={(e) =>
                setForm((f) => ({ ...f, notify_whatsapp_number: e.target.value }))
              }
              placeholder="+15550102030"
              disabled={disabled || !form.whatsapp_enabled}
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("defaultTemplate")}</Label>
            <select
              value={form.default_whatsapp_template}
              onChange={(e) =>
                setForm((f) => ({ ...f, default_whatsapp_template: e.target.value }))
              }
              disabled={disabled || !form.whatsapp_enabled}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              <option value="">{t("noTemplate")}</option>
              {waTemplates.map((tpl) => (
                <option key={tpl.id} value={tpl.name}>
                  {tpl.name} ({tpl.language})
                </option>
              ))}
            </select>
            {waTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noApprovedTemplates")}</p>
            ) : null}
          </div>

          {/* Variable mapping — shown only when the chosen template has
              positional variables. Each {{N}} maps to a curated source
              with an optional default fallback. */}
          {form.whatsapp_enabled && selectedWaTemplate && waVarCount > 0 && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-foreground">
                {t("mapVarsTitle", { count: waVarCount })}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("mapVarsDesc")}</p>
              <div className="mt-2 space-y-2">
                {Array.from({ length: waVarCount }, (_, i) => i + 1).map((idx) => {
                  const m = form.whatsapp_variable_map[String(idx)] ?? {};
                  return (
                    <div key={idx} className="flex flex-wrap items-center gap-2">
                      <span className="w-10 shrink-0 rounded bg-muted px-1.5 py-1 text-center text-xs font-mono text-foreground">
                        {`{{${idx}}}`}
                      </span>
                      <select
                        value={m.source ?? ""}
                        onChange={(e) => setVarMap(idx, { source: e.target.value })}
                        disabled={disabled}
                        className="h-8 flex-1 rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
                      >
                        <option value="">{t("mapVarChoose")}</option>
                        {sourceOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <Input
                        value={m.default ?? ""}
                        onChange={(e) => setVarMap(idx, { default: e.target.value })}
                        placeholder={t("mapVarDefault")}
                        disabled={disabled}
                        className="h-8 w-32 text-xs"
                      />
                    </div>
                  );
                })}
              </div>
              {unmappedIndices.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t("mapVarsWarning", { list: unmappedIndices.join(", ") })}
                </p>
              )}
            </div>
          )}

          {/* Ready-to-use WhatsApp template content. */}
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="text-xs font-medium text-foreground">{t("waExampleTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("waExampleDesc")}</p>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-[11px] text-foreground">
              {EXAMPLE_WHATSAPP_BODY}
            </pre>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={copyWhatsappBody}
              disabled={disabled}
            >
              {t("waExampleCopy")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Email reminders */}
      <Card className="mb-4">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Mail className="size-4 text-primary" />
              {t("emailTitle")}
            </CardTitle>
            <Switch
              checked={form.email_enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, email_enabled: Boolean(v) }))}
              disabled={disabled}
            />
          </div>
          <CardDescription className="text-muted-foreground">
            {t("emailDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("notifyEmail")}</Label>
            <Input
              type="email"
              value={form.notify_email}
              onChange={(e) => setForm((f) => ({ ...f, notify_email: e.target.value }))}
              placeholder="you@company.com"
              disabled={disabled || !form.email_enabled}
            />
          </div>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("defaultEmailTemplate")}</Label>
            <select
              value={form.default_email_template_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, default_email_template_id: e.target.value }))
              }
              disabled={disabled || !form.email_enabled}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              <option value="">{t("noTemplate")}</option>
              {emailTemplates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
            {emailTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noEmailTemplates")}</p>
            ) : null}
          </div>

          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="text-xs font-medium text-foreground">{t("emailExampleTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("emailExampleDesc")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={seedExampleEmailTemplate}
              disabled={disabled || !form.email_enabled || seedingEmail}
            >
              {seedingEmail ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("emailExampleCreate")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Available variables — the curated set reminders can resolve. */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm text-foreground">
            <BellRing className="size-4 text-primary" />
            {t("variablesTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("variablesCuratedDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("varGroupBuiltin")}
            </p>
            <div className="flex flex-wrap gap-1">
              {REMINDER_DYNAMIC_KEYS.map((key) => (
                <span
                  key={key}
                  className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
                >
                  {`{{${key}}}`}
                </span>
              ))}
              <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
                {`{{tag_list}}`}
              </span>
            </div>
          </div>
          {customFields.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("varGroupCustom")}
              </p>
              <div className="flex flex-wrap gap-1">
                {customFields.map((cf) => (
                  <span
                    key={cf.id}
                    className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
                    title={cf.field_name}
                  >
                    {`{{custom:${cf.id}}}`}
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={disabled || !dirty || saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : t("save")}
        </Button>
      </div>
    </section>
  );
}
