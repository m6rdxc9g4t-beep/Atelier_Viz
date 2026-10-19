import { SchedulesSection } from "./SchedulesSection";

/** Écran « Automatisation » : actualisations planifiées des sources et alertes sur seuil. */
export function AutomationView() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 lg:p-8">
      <SchedulesSection />
    </div>
  );
}
