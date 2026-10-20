import clsx from "clsx";
import { Cloud, HardDrive, Moon, Sparkles, Sun } from "lucide-react";

import { usePreferences } from "../../hooks/usePreferences";
import type { Theme } from "../../hooks/useTheme";
import type { ProviderStatus } from "../../types/ai";
import { ProviderBadges } from "../ai/ProviderBadges";
import { NotificationBell } from "../../features/automation/NotificationBell";
import { SuiteSwitcher } from "./SuiteSwitcher";

interface TopbarProps {
  title: string;
  theme: Theme;
  onToggleTheme: () => void;
  providers: ProviderStatus[];
  providersLoading: boolean;
  providersError: string | null;
  onRefreshProviders: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
}

export function Topbar(props: TopbarProps) {
  const { title, theme, onToggleTheme, assistantOpen, onToggleAssistant } = props;
  const { prefs, setOnline } = usePreferences();
  const online = prefs?.online_mode ?? false;

  return (
    <header className="atelier-glass flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
      <div className="flex min-w-0 items-center gap-2">
        <SuiteSwitcher />
        <h1 className="atelier-title min-w-0 truncate text-sm font-semibold">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={online}
          onClick={() => {
            void setOnline(!online).then(props.onRefreshProviders);
          }}
          title={online ? "En ligne : Claude et webhooks Internet autorisés. Cliquer pour repasser en local." : "Hors ligne : tout reste sur la machine. Cliquer pour activer Claude."}
          className={clsx(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
            online ? "border-accent-ink/40 bg-accent-soft text-accent-ink" : "border-border text-muted hover:text-fg",
          )}
        >
          {online ? <Cloud className="size-3.5" aria-hidden /> : <HardDrive className="size-3.5" aria-hidden />}
          {online ? "En ligne" : "Hors ligne"}
        </button>
        <div className="hidden md:block">
          <ProviderBadges providers={props.providers} loading={props.providersLoading} error={props.providersError} onRefresh={props.onRefreshProviders} />
        </div>
        <NotificationBell />
        <button
          type="button"
          onClick={onToggleAssistant}
          aria-pressed={assistantOpen}
          aria-label="Assistant IA"
          title="Assistant IA"
          className={clsx("rounded-md p-2 hover:bg-surface-2 hover:text-fg", assistantOpen ? "text-accent-ink" : "text-muted")}
        >
          <Sparkles className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre"}
          className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg"
        >
          {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </button>
      </div>
    </header>
  );
}
