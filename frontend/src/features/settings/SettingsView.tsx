import clsx from "clsx";
import { Cloud, HardDrive, Monitor, Moon, RefreshCw, Sun } from "lucide-react";

import { usePreferences } from "../../hooks/usePreferences";
import { useProviders } from "../../hooks/useProviders";
import { type ThemePreference, useTheme } from "../../hooks/useTheme";

/** Réglages : bascule hors ligne / en ligne et état des moteurs d'IA. */
export function SettingsView() {
  const { prefs, setOnline, error } = usePreferences();
  const providers = useProviders();
  const { preference, setPreference } = useTheme();
  const online = prefs?.online_mode ?? false;

  const toggle = async (value: boolean) => {
    await setOnline(value);
    providers.refresh();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 lg:p-8">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">Mode de fonctionnement</h2>
        <p className="mt-1 text-xs text-muted">Choisissez ce qui a le droit de quitter votre machine. Le changement est immédiat.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Mode de fonctionnement">
          {[
            {
              value: false,
              icon: HardDrive,
              title: "Hors ligne (local)",
              lines: ["Données, rapports et calculs restent sur la machine", "IA : Ollama uniquement", "Boutons webhook : adresses locales seulement"],
            },
            {
              value: true,
              icon: Cloud,
              title: "En ligne (Claude CLI)",
              lines: ["Claude disponible dans l'assistant", "Le schéma et 5 lignes d'exemple peuvent être envoyés", "Boutons webhook vers Internet autorisés"],
            },
          ].map((o) => (
            <button
              key={o.title}
              type="button"
              role="radio"
              aria-checked={online === o.value}
              onClick={() => void toggle(o.value)}
              className={clsx(
                "rounded-lg border p-4 text-left transition-colors",
                online === o.value ? "border-accent bg-accent/5 ring-1 ring-accent" : "border-border hover:bg-surface-2",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <o.icon className="size-4" aria-hidden /> {o.title}
              </span>
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {o.lines.map((l) => (
                  <li key={l}>• {l}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
        {error && <p className="mt-3 text-xs text-negative">{error}</p>}
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">Apparence</h2>
        <p className="mt-1 text-xs text-muted">
          Thème de l'application. Chaque rapport peut aussi avoir son propre thème (bouton « Thème » du Studio) : couleurs en hexadécimal, fonds transparents, bordures.
        </p>
        <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Thème de l'application">
          {(
            [
              { value: "light", label: "Clair", icon: Sun },
              { value: "dark", label: "Sombre", icon: Moon },
              { value: "system", label: "Système", icon: Monitor },
            ] as { value: ThemePreference; label: string; icon: typeof Sun }[]
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={preference === o.value}
              onClick={() => setPreference(o.value)}
              className={clsx(
                "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm",
                preference === o.value ? "border-accent bg-accent/5 font-medium ring-1 ring-accent" : "border-border hover:bg-surface-2",
              )}
            >
              <o.icon className="size-4" aria-hidden /> {o.label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Moteurs d'IA</h2>
          <button type="button" onClick={providers.refresh} aria-label="Revérifier" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
            <RefreshCw className={clsx("size-4", providers.loading && "animate-spin")} aria-hidden />
          </button>
        </div>
        <ul className="mt-3 divide-y divide-border">
          {providers.providers.map((p) => (
            <li key={p.name} className="flex items-start gap-3 py-3 text-sm">
              <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", p.available ? "bg-positive" : "bg-muted/50")} aria-hidden />
              <span className="min-w-0">
                <span className="font-medium">{p.name === "ollama" ? "Ollama (local)" : "Claude"}</span>{" "}
                <span className="text-xs text-muted">— {p.model}</span>
                <span className="block text-xs text-muted">{p.available ? "Disponible" : p.detail}</span>
                {p.name === "ollama" && p.models.length > 0 && <span className="block text-[11px] text-muted">Modèles installés : {p.models.join(", ")}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-muted">
          Claude passe par la CLI Claude Code connectée à votre abonnement (CLAUDE_MODE=cli dans backend/.env), ou par l'API avec une clé (CLAUDE_MODE=api).
        </p>
      </section>
    </div>
  );
}
