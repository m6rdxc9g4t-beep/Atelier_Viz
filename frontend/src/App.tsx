import { Suspense, lazy, useState } from "react";

import { Sidebar } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { AssistantPanel } from "./features/assistant/AssistantPanel";
import { AutomationView } from "./features/automation/AutomationView";
import { DataView } from "./features/data/DataView";
import { ReportsHome } from "./features/reports/ReportsHome";
import { SettingsView } from "./features/settings/SettingsView";
import { useDatasets } from "./hooks/useDatasets";
import { useDataVersions } from "./hooks/useDataVersions";
import { useProviders } from "./hooks/useProviders";
import { useTheme } from "./hooks/useTheme";
import { useRoute } from "./lib/router";
import { useStudio } from "./studio/store";

// Le Studio (graphiques, cartes, grille) est chargé à la demande : accueil et page Données s'ouvrent plus vite.
const StudioPage = lazy(() => import("./studio/StudioPage").then((m) => ({ default: m.StudioPage })));

const TITLES = { reports: "Rapports", data: "Données", automation: "Automatisation", settings: "Réglages" } as const;

export default function App() {
  const route = useRoute();
  const { theme, toggle } = useTheme();
  const providers = useProviders();
  const datasets = useDatasets();
  // Actualisations planifiées : les visuels ouverts se rechargent quand un jeu change.
  useDataVersions();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const studioReport = useStudio((s) => s.report);
  const inStudio = route.name === "studio";

  // Dans le Studio, l'assistant reçoit le jeu de données du rapport ; ailleurs, celui de la page Données.
  const studioDatasetId = studioReport?.dataset_id ?? studioReport?.pages.flatMap((p) => p.visuals).find((v) => v.dataset_id)?.dataset_id;
  const assistantDataset = inStudio
    ? (datasets.datasets.find((d) => d.id === studioDatasetId) ?? null)
    : datasets.selected;

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar route={route} compact={inStudio} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          title={TITLES[inStudio ? "reports" : route.name]}
          theme={theme}
          onToggleTheme={toggle}
          providers={providers.providers}
          providersLoading={providers.loading}
          providersError={providers.error}
          onRefreshProviders={() => providers.refresh(true)}
          assistantOpen={assistantOpen}
          onToggleAssistant={() => setAssistantOpen((o) => !o)}
        />
        <main className="min-h-0 flex-1 overflow-y-auto">
          {route.name === "studio" && (
            <Suspense fallback={null}>
              <StudioPage reportId={route.id} />
            </Suspense>
          )}
          {route.name === "reports" && <ReportsHome />}
          {route.name === "data" && (
            <div className="h-full p-4 lg:p-6">
              <DataView state={datasets} />
            </div>
          )}
          {route.name === "automation" && <AutomationView />}
          {route.name === "settings" && <SettingsView />}
        </main>
      </div>
      {assistantOpen && <AssistantPanel dataset={assistantDataset} onClose={() => setAssistantOpen(false)} />}
    </div>
  );
}
