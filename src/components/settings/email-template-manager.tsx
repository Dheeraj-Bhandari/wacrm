"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Mail, Pencil, Plus, Trash2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import type { EmailTemplate } from "@/types";
import {
  REMINDER_DYNAMIC_KEYS,
  interpolateTemplate,
  resolveDynamicValues,
} from "@/lib/activities/dynamic-values";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";

interface FormState {
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
}

const EMPTY: FormState = { name: "", subject: "", body_html: "", body_text: "" };

// Sample values used to render the live preview, so the user sees what a
// real reminder would look like without needing a real contact.
const PREVIEW = resolveDynamicValues({
  contact: { name: "Jane Doe", phone: "+15550102030", email: "jane@acme.com", company: "Acme Inc" },
  deal: { title: "Enterprise plan", value: 4200, currency: "$", stageName: "Negotiation" },
  activity: {
    title: "Follow-up call",
    notes: "Discuss pricing",
    dueAt: new Date().toISOString(),
  },
  lastMessages: "Them: Can you send a quote?\nUs: Absolutely, sending now.",
});

export function EmailTemplateManager() {
  const t = useTranslations("Settings.emailTemplates");
  const supabase = createClient();
  const { accountId, canSendMessages } = useAuth();

  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<EmailTemplate | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("email_templates")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false });
    if (error) {
      toast.error(t("loadFailed"));
    } else {
      setTemplates((data ?? []) as EmailTemplate[]);
    }
    setLoading(false);
  }, [accountId, supabase, t]);

  useEffect(() => {
    // fetchTemplates sets state inside an async Supabase callback, not
    // synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTemplates();
  }, [fetchTemplates]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY);
    setDialogOpen(true);
  };

  const openEdit = (tpl: EmailTemplate) => {
    setEditingId(tpl.id);
    setForm({
      name: tpl.name,
      subject: tpl.subject,
      body_html: tpl.body_html,
      body_text: tpl.body_text ?? "",
    });
    setDialogOpen(true);
  };

  const subjectPreview = useMemo(
    () => interpolateTemplate(form.subject, PREVIEW),
    [form.subject],
  );
  const bodyPreview = useMemo(
    () => interpolateTemplate(form.body_html, PREVIEW),
    [form.body_html],
  );

  const insertVariable = (key: string) => {
    setForm((f) => ({ ...f, body_html: `${f.body_html}{{${key}}}` }));
  };

  async function handleSave() {
    if (!accountId) return;
    const name = form.name.trim();
    const subject = form.subject.trim();
    const body = form.body_html.trim();
    if (!name || !subject || !body) {
      toast.error(t("requiredFields"));
      return;
    }
    setSaving(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t("notSignedIn"));
      setSaving(false);
      return;
    }

    const payload = {
      name,
      subject,
      body_html: body,
      body_text: form.body_text.trim() || null,
    };

    if (editingId) {
      const { error } = await supabase
        .from("email_templates")
        .update(payload)
        .eq("id", editingId);
      if (error) {
        toast.error(error.message.includes("duplicate") ? t("nameTaken") : t("saveFailed"));
        setSaving(false);
        return;
      }
    } else {
      const { error } = await supabase
        .from("email_templates")
        .insert({ ...payload, account_id: accountId, user_id: user.id });
      if (error) {
        toast.error(error.message.includes("duplicate") ? t("nameTaken") : t("saveFailed"));
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    setDialogOpen(false);
    toast.success(editingId ? t("saved") : t("created"));
    await fetchTemplates();
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeletingId(toDelete.id);
    const { error } = await supabase
      .from("email_templates")
      .delete()
      .eq("id", toDelete.id);
    setDeletingId(null);
    if (error) {
      toast.error(t("deleteFailed"));
      return;
    }
    toast.success(t("deleted"));
    setTemplates((prev) => prev.filter((x) => x.id !== toDelete.id));
    setToDelete(null);
  }

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t.raw("description")}
        action={
          canSendMessages ? (
            <Button onClick={openCreate} className="gap-1.5">
              <Plus className="size-4" />
              {t("new")}
            </Button>
          ) : null
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Mail className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {templates.map((tpl) => (
            <Card key={tpl.id}>
              <CardContent className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{tpl.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{tpl.subject}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(tpl)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setToDelete(tpl)}
                    disabled={deletingId === tpl.id}
                  >
                    {deletingId === tpl.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4 text-destructive" />
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? t("editTitle") : t("newTitle")}</DialogTitle>
            <DialogDescription>{t.raw("dialogDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-2">
              <Label>{t("nameLabel")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t("namePlaceholder")}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("subjectLabel")}</Label>
              <Input
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                placeholder={t.raw("subjectPlaceholder")}
              />
              {form.subject ? (
                <p className="text-xs text-muted-foreground">
                  {t("preview")}: {subjectPreview}
                </p>
              ) : null}
            </div>

            <div className="grid gap-2">
              <Label>{t("bodyLabel")}</Label>
              <Textarea
                value={form.body_html}
                onChange={(e) => setForm((f) => ({ ...f, body_html: e.target.value }))}
                placeholder={t.raw("bodyPlaceholder")}
                rows={8}
                className="font-mono text-sm"
              />
              <div className="flex flex-wrap gap-1">
                <span className="mr-1 text-xs text-muted-foreground">{t("insertVariable")}:</span>
                {REMINDER_DYNAMIC_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => insertVariable(key)}
                    className="rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                  >
                    {`{{${key}}}`}
                  </button>
                ))}
              </div>
            </div>

            {form.body_html ? (
              <div className="grid gap-2">
                <Label>{t("preview")}</Label>
                <div
                  className="rounded-lg border border-border bg-background p-3 text-sm text-foreground"
                  // Preview of the user's own template content, rendered
                  // for their eyes only in their own settings dialog.
                  dangerouslySetInnerHTML={{ __html: bodyPreview }}
                />
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label>{t("plaintextLabel")}</Label>
              <Textarea
                value={form.body_text}
                onChange={(e) => setForm((f) => ({ ...f, body_text: e.target.value }))}
                placeholder={t("plaintextPlaceholder")}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirm", { name: toDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={!!deletingId}
            >
              {deletingId ? <Loader2 className="size-4 animate-spin" /> : t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
