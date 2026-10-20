import { beforeEach, describe, expect, it } from "vitest";

import type { BuildResponse, ProposedVisual } from "../types/builder";
import type { Report } from "../types/report";
import {
  type BuildEntry,
  MAX_ENTRIES,
  addableIndexes,
  createdByIndex,
  currentEntry,
  emptySession,
  mapRepaired,
  newRequest,
  placedCount,
  placement,
  previousEntries,
  recordAdded,
  recordResult,
  showEntry,
  useAIBuilder,
  visualIds,
} from "./aiBuilder";

const visual = (title: string): ProposedVisual => ({ type: "column", title, roles: { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] }, options: {} });

const result = (...titles: string[]): BuildResponse => ({ visuals: titles.map(visual), explanation: "", provider: "anthropic", model: "sonnet", warnings: [] });

const entry = (id: string, prompt = `demande ${id}`, ...titles: string[]): BuildEntry => ({
  id,
  prompt,
  at: 0,
  datasetId: "ds",
  result: result(...(titles.length ? titles : ["A"])),
  added: {},
});

const report = (...ids: string[]): Report =>
  ({ id: "r", name: "R", pages: [{ id: "p1", name: "Page 1", visuals: ids.map((id) => ({ id })) }] }) as unknown as Report;

describe("« Créer avec l'IA » : historique de la session", () => {
  it("une génération devient le résultat affiché et la tête de l'historique", () => {
    let s = recordResult(emptySession(), entry("e1"));
    s = recordResult(s, entry("e2"));
    expect(currentEntry(s)?.id).toBe("e2");
    expect(s.entries.map((e) => e.id)).toEqual(["e2", "e1"]);
    // Les demandes précédentes = tout sauf le résultat affiché.
    expect(previousEntries(s).map((e) => e.id)).toEqual(["e1"]);
    expect(s.pending).toBeNull();
  });

  it("« Nouvelle demande » vide la demande et le résultat affiché, l'historique reste", () => {
    let s = recordResult({ ...emptySession(), draft: "CA par région", error: "x" }, entry("e1"));
    s = newRequest(s);
    expect(s.draft).toBe("");
    expect(s.error).toBeNull();
    expect(currentEntry(s)).toBeNull();
    expect(previousEntries(s).map((e) => e.id)).toEqual(["e1"]);
  });

  it("réafficher une demande passée remet son texte dans la zone de demande", () => {
    let s = recordResult(recordResult(emptySession(), entry("e1", "Top 5 des produits")), entry("e2"));
    s = showEntry(s, "e1");
    expect(currentEntry(s)?.id).toBe("e1");
    expect(s.draft).toBe("Top 5 des produits");
    expect(previousEntries(s).map((e) => e.id)).toEqual(["e2"]);
    expect(showEntry(s, "inconnu")).toBe(s);
  });

  it(`garde au plus ${MAX_ENTRIES} demandes`, () => {
    let s = emptySession();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) s = recordResult(s, entry(`e${i}`));
    expect(s.entries).toHaveLength(MAX_ENTRIES);
    expect(s.entries[0]?.id).toBe(`e${MAX_ENTRIES + 4}`);
  });
});

describe("« Créer avec l'IA » : ajouté, retiré, réajout", () => {
  it("l'état se déduit du rapport : Ctrl+Z rend la proposition de nouveau ajoutable", () => {
    let s = recordResult(emptySession(), entry("e1", "x", "A", "B"));
    expect(placement(currentEntry(s)!, 0, visualIds(report()))).toBe("new");
    s = recordAdded(s, "e1", { 0: ["v1"] });
    const e = currentEntry(s)!;
    expect(placement(e, 0, visualIds(report("v1")))).toBe("placed");
    expect(addableIndexes(e, visualIds(report("v1")))).toEqual([1]);
    expect(placedCount(e, visualIds(report("v1")))).toBe(1);
    // Ctrl+Z : le visuel n'est plus dans le rapport.
    expect(placement(e, 0, visualIds(report()))).toBe("removed");
    expect(addableIndexes(e, visualIds(report()))).toEqual([0, 1]);
    // Ctrl+Y : de nouveau là.
    expect(placement(e, 0, visualIds(report("v1")))).toBe("placed");
  });

  it("un réajout ajoute un nouvel identifiant sans oublier les précédents", () => {
    let s = recordResult(emptySession(), entry("e1"));
    s = recordAdded(s, "e1", { 0: ["v1"] });
    s = recordAdded(s, "e1", { 0: ["v2"] });
    const e = currentEntry(s)!;
    expect(e.added[0]).toEqual(["v1", "v2"]);
    expect(placement(e, 0, visualIds(report("v2")))).toBe("placed");
    // Seule l'entrée visée change.
    s = recordResult(s, entry("e2"));
    expect(recordAdded(s, "e2", { 0: ["v3"] }).entries.find((x) => x.id === "e1")?.added).toEqual({ 0: ["v1", "v2"] });
  });

  it("un visuel sur une autre page reste « ajouté »", () => {
    const e = { ...entry("e1"), added: { 0: ["v9"] } };
    const r = { id: "r", name: "R", pages: [{ id: "p1", visuals: [] }, { id: "p2", visuals: [{ id: "v9" }] }] } as unknown as Report;
    expect(placement(e, 0, visualIds(r))).toBe("placed");
    expect(visualIds(null).size).toBe(0);
  });

  it("réponse de repair : visuels réparés gardés avec leur index, écartés avec la raison", () => {
    const repaired = visual("A réparé");
    const out = mapRepaired([0, 2, 3], {
      results: [
        { visual: repaired, warnings: [], errors: [] },
        { visual: null, warnings: [], errors: ["Visuel 1 (Histogramme) : rôle(s) obligatoire(s) manquant(s) : Valeurs."] },
        { visual: visual("D"), warnings: ["agg remplacée"], errors: [] },
      ],
    });
    expect(out.specs.map((v) => v.title)).toEqual(["A réparé", "D"]);
    expect(out.indexes).toEqual([0, 3]);
    expect(out.dropped).toEqual([{ index: 2, reason: "Visuel 1 (Histogramme) : rôle(s) obligatoire(s) manquant(s) : Valeurs." }]);
    // Réponse incomplète : jamais d'ajout d'un visuel non revalidé.
    expect(mapRepaired([5], { results: [] })).toEqual({ specs: [], indexes: [], dropped: [{ index: 5, reason: "visuel invalide" }] });
  });

  it("identifiants créés répartis par index de proposition", () => {
    expect(createdByIndex([0, 3], ["v1", "v2"])).toEqual({ 0: ["v1"], 3: ["v2"] });
    expect(createdByIndex([1], [])).toEqual({});
  });
});

describe("« Créer avec l'IA » : une session par rapport", () => {
  beforeEach(() => useAIBuilder.setState({ sessions: {} }));

  it("les sessions sont séparées et survivent à la fermeture du volet", () => {
    const { update } = useAIBuilder.getState();
    update("r1", (s) => ({ ...s, draft: "CA par région" }));
    update("r2", (s) => recordResult(s, entry("e1")));
    const { sessions } = useAIBuilder.getState();
    expect(sessions.r1?.draft).toBe("CA par région");
    expect(sessions.r1?.entries).toEqual([]);
    expect(sessions.r2?.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(sessions.r2?.count).toBe(3);
  });
});
