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
    <header className="flex h-(--top-h) shrink-0 items-center justify-between gap-3 border-b border-line bg-bg px-3 lg:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <SuiteSwitcher />
        <h1 className="atelier-title min-w-0 truncate text-sm">{title}</h1>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          role="switch"
          aria-checked={online}
          onClick={() => {
            void setOnline(!online).then(props.onRefreshProviders);
          }}
          title={online ? "En ligne : Claude et webhooks Internet autorisés. Cliquer pour repasser en local." : "Hors ligne : tout reste sur la machine. Cliquer pour activer Claude."}
          className={clsx(
            "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
            online ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-surface-2 hover:text-fg",
          )}
        >
          {online ? <Cloud className="size-3.5" aria-hidden /> : <HardDrive className="size-3.5" aria-hidden />}
          {online ? "En ligne" : "Hors ligne"}
        </button>
        <div className="mr-1 hidden md:block">
          <ProviderBadges providers={props.providers} loading={props.providersLoading} error={props.providersError} onRefresh={props.onRefreshProviders} />
        </div>
        <NotificationBell />
        <button
          type="button"
          onClick={onToggleAssistant}
          aria-pressed={assistantOpen}
          aria-label="Assistant IA"
          title="Assistant IA"
          className={clsx("grid size-[30px] place-items-center rounded-md hover:bg-surface-2 hover:text-fg", assistantOpen ? "bg-surface-3 text-fg" : "text-muted")}
        >
          <Sparkles className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre"}
          className="grid size-[30px] place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
        >
          {theme === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
        </button>
      </div>
    </header>
  );
}
