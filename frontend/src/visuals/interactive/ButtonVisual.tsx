import clsx from "clsx";
import { ExternalLink, Loader2, Play, RotateCcw, SquareArrowRight } from "lucide-react";
import { useState } from "react";

import { RichText } from "../../features/assistant/RichText";
import { api } from "../../lib/api";
import { opt, type VisualProps } from "../types";
import { type ButtonAction, isSafeUrl, renderTemplate, webhookPayload } from "./actions";

const ICONS = { url: ExternalLink, webhook: Play, page: SquareArrowRight, reset: RotateCcw };

/** Bouton d'automatisation : ouvrir une URL, appeler un webhook, changer de page, réinitialiser. */
export function ButtonVisual(props: VisualProps) {
  const { visual, def, actions, editing } = props;
  const action = opt<ButtonAction>(visual, def, "action");
  const label = opt<string>(visual, def, "label");
  const variant = opt<string>(visual, def, "variant");
  const [status, setStatus] = useState<{ tone: "ok" | "error" | "pending" | "confirm"; text: string } | null>(null);
  const Icon = ICONS[action] ?? Play;
  const page = actions.pages.find((p) => p.id === actions.pageId)?.name ?? "";
  const ctx = { filters: actions.activeFilters, page, report: actions.reportName };

  const run = async (confirmed = false) => {
    if (action === "page") {
      const target = opt<string>(visual, def, "targetPage");
      if (target) actions.goToPage(target);
      return;
    }
    if (action === "reset") {
      actions.resetFilters();
      return;
    }
    const url = renderTemplate(opt<string>(visual, def, "url") ?? "", ctx);
    if (action === "url") {
      if (!isSafeUrl(url)) {
        setStatus({ tone: "error", text: "URL invalide (http, https ou mailto)." });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    // Webhook : confirmation en ligne (pas de boîte de dialogue native), puis appel via le backend.
    if (opt<boolean>(visual, def, "confirm") && !confirmed) {
      setStatus({ tone: "confirm", text: url });
      return;
    }
    setStatus({ tone: "pending", text: "Envoi…" });
    try {
      const res = await api.webhook(url, opt<"GET" | "POST">(visual, def, "method"), webhookPayload(ctx));
      setStatus({ tone: res.ok ? "ok" : "error", text: `${res.ok ? "Envoyé" : "Échec"} (HTTP ${res.status_code})` });
    } catch (err) {
      setStatus({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="flex h-full flex-col items-stretch justify-center gap-1">
      <button
        type="button"
        onClick={() => void run()}
        disabled={status?.tone === "pending"}
        className={clsx(
          "flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors disabled:opacity-60",
          variant === "primary" && "bg-accent text-accent-fg hover:brightness-110",
          variant === "secondary" && "border border-border bg-surface hover:bg-surface-2",
          variant === "ghost" && "text-accent hover:bg-surface-2",
          editing && "pointer-events-auto",
        )}
      >
        {status?.tone === "pending" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Icon className="size-4" aria-hidden />}
        <RichText text={label} />
      </button>
      {status?.tone === "confirm" && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-muted" title={status.text}>
            Appeler {status.text} ?
          </span>
          <button type="button" onClick={() => void run(true)} className="font-medium text-accent hover:underline">
            Confirmer
          </button>
          <button type="button" onClick={() => setStatus(null)} className="text-muted hover:underline">
            Annuler
          </button>
        </div>
      )}
      {status && status.tone !== "confirm" && status.tone !== "pending" && (
        <p role="status" className={clsx("truncate text-[11px]", status.tone === "ok" ? "text-positive" : "text-negative")} title={status.text}>
          {status.text}
        </p>
      )}
    </div>
  );
}

/** Zone de texte (gras **…**, puces « - »). */
export function TextVisual(props: VisualProps) {
  const { visual, def } = props;
  const size = opt<string>(visual, def, "size");
  const align = opt<string>(visual, def, "align");
  return (
    <div
      className={clsx(
        "h-full overflow-auto whitespace-pre-wrap leading-relaxed",
        { sm: "text-xs", md: "text-sm", lg: "text-lg", xl: "text-2xl font-semibold tracking-tight" }[size] ?? "text-sm",
        { left: "text-left", center: "text-center", right: "text-right" }[align] ?? "text-left",
      )}
    >
      <RichText text={opt<string>(visual, def, "text") ?? ""} />
    </div>
  );
}
