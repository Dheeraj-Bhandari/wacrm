"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Code2,
  Copy,
  Check,
  Download,
  Upload,
  FlaskConical,
  BookOpen,
  Loader2,
  AlertCircle,
  CircleCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  parseAutomationDocument,
  type AutomationDocument,
} from "@/lib/automations/document";
import { AUTOMATION_EXAMPLES } from "@/lib/automations/examples";

interface DryRunResult {
  index: number;
  type: string;
  status: "ok" | "warn" | "error" | "skipped";
  detail: string;
}

interface Props {
  /** The current builder state as an exportable document. */
  currentDocument: AutomationDocument;
  /** Automation id when editing (enables server export). */
  automationId?: string;
  /** Load a parsed document into the builder. */
  onImport: (doc: AutomationDocument) => void;
}

export function AutomationJsonTools({ currentDocument, automationId, onImport }: Props) {
  const t = useTranslations("Automations.json");

  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [validateOpen, setValidateOpen] = useState(false);

  // Import
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  // Copy
  const [copied, setCopied] = useState(false);

  // Validate run
  const [testPhone, setTestPhone] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [live, setLive] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<DryRunResult[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const docJson = JSON.stringify(currentDocument, null, 2);

  async function handleCopy() {
    await navigator.clipboard.writeText(docJson);
    setCopied(true);
    toast.success(t("copied"));
    setTimeout(() => setCopied(false), 2000);
  }

  function handleImportParse() {
    setImportError(null);
    const parsed = parseAutomationDocument(importText);
    if (!parsed.ok) {
      setImportError(parsed.error);
      return;
    }
    onImport(parsed.doc);
    setImportOpen(false);
    setImportText("");
    toast.success(t("imported"));
  }

  function applyExample(doc: AutomationDocument) {
    onImport(doc);
    setExamplesOpen(false);
    toast.success(t("imported"));
  }

  async function handleValidateRun() {
    setRunError(null);
    setResults(null);
    setRunning(true);
    try {
      const res = await fetch("/api/automations/validate-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: currentDocument,
          test_phone: testPhone,
          message_text: testMessage || undefined,
          live,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRunError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      if (body.issues) {
        // Static validation failed — surface issues as pseudo-results.
        setResults(
          body.issues.map((it: { path: string; message: string }, i: number) => ({
            index: i + 1,
            type: it.path || "document",
            status: "error" as const,
            detail: it.message,
          })),
        );
        return;
      }
      setResults(body.results as DryRunResult[]);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              className="border-border text-muted-foreground hover:bg-muted"
            />
          }
        >
          <Code2 className="h-4 w-4" />
          <span className="hidden sm:inline">{t("menu")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-border bg-popover">
          <DropdownMenuItem onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" />
            {t("import")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleCopy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {t("copy")}
          </DropdownMenuItem>
          {automationId && (
            <DropdownMenuItem
              onClick={() =>
                window.open(`/api/automations/${automationId}/export`, "_blank")
              }
            >
              <Download className="h-4 w-4" />
              {t("export")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setExamplesOpen(true)}>
            <BookOpen className="h-4 w-4" />
            {t("examples")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setValidateOpen(true)}>
            <FlaskConical className="h-4 w-4" />
            {t("validate")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Import dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="border-border bg-popover sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("importTitle")}</DialogTitle>
            <DialogDescription>{t("importDesc")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={t.raw("importPlaceholder")}
            rows={14}
            className="font-mono text-xs"
          />
          {importError && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {importError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleImportParse} disabled={!importText.trim()}>
              {t("loadIntoBuilder")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Examples dialog */}
      <Dialog open={examplesOpen} onOpenChange={setExamplesOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("examplesTitle")}</DialogTitle>
            <DialogDescription>{t("examplesDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {AUTOMATION_EXAMPLES.map((ex) => (
              <div
                key={ex.id}
                className="rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">{ex.label}</p>
                    <p className="text-xs text-muted-foreground">{ex.description}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          JSON.stringify(ex.document, null, 2),
                        );
                        toast.success(t("copied"));
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" onClick={() => applyExample(ex.document)}>
                      {t("useThis")}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Validate-run dialog */}
      <Dialog open={validateOpen} onOpenChange={setValidateOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("validateTitle")}</DialogTitle>
            <DialogDescription>{t("validateDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1">
                <label className="text-xs text-muted-foreground">{t("testPhone")}</label>
                <Input
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="+15550102030"
                />
              </div>
              <div className="grid gap-1">
                <label className="text-xs text-muted-foreground">{t("testMessage")}</label>
                <Input
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  placeholder={t("testMessagePlaceholder")}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--primary)]"
              />
              {t("liveToggle")}
            </label>
            <Button
              onClick={handleValidateRun}
              disabled={!testPhone.trim() || running}
              className="w-full"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
              {t("runButton")}
            </Button>

            {runError && (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {runError}
              </p>
            )}

            {results && (
              <ol className="space-y-1.5">
                {results.length === 0 ? (
                  <li className="text-xs text-muted-foreground">{t("noSteps")}</li>
                ) : (
                  results.map((r) => (
                    <li
                      key={r.index}
                      className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2"
                    >
                      <span className="mt-0.5 shrink-0">
                        {r.status === "error" ? (
                          <AlertCircle className="h-4 w-4 text-destructive" />
                        ) : r.status === "warn" ? (
                          <AlertCircle className="h-4 w-4 text-amber-500" />
                        ) : (
                          <CircleCheck className="h-4 w-4 text-primary" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground">
                          {r.index}. {r.type}
                        </p>
                        <p className="break-words text-xs text-muted-foreground">
                          {r.detail}
                        </p>
                      </div>
                    </li>
                  ))
                )}
              </ol>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
