import { describe, expect, it } from "vitest";

import type { ExempleHistoire } from "../types/exemples";
import { EXAMPLES_EVENT, announceExamplesChange, onExamplesChange, pickHistoire, readRemembered, remember, showExamplesOnHome, stepsAround } from "./exemples";

const apps = ["convert", "tab", "viz", "tresorerie", "nexus", "projets", "wiki"] as const;
const h = (id: string): ExempleHistoire => ({
  id,
  titre: id,
  sous_titre: "",
  secteur: "",
  resume: "",
  parcours: apps.map((app) => ({ app, titre: `Étape ${app}`, texte: "" })),
  jeux: [],
  alerte: "",
  rapport: "",
  charge: false,
});

describe("exemples de la suite", () => {
  it("trouve l'étape courante et la suivante", () => {
    const s = stepsAround(h("a"));
    expect(s.index).toBe(2);
    expect(s.current?.app).toBe("viz");
    expect(s.next?.app).toBe("tresorerie");
    expect(stepsAround(h("a"), "wiki").next).toBeNull();
  });

  it("reprend l'histoire mémorisée, sinon la première", () => {
    const list = [h("a"), h("b")];
    expect(pickHistoire(list, "b")?.id).toBe("b");
    expect(pickHistoire(list, "disparue")?.id).toBe("a");
    expect(pickHistoire([], null)).toBeNull();
  });

  it("supporte un stockage absent ou en erreur", () => {
    const broken = {
      getItem: () => {
        throw new Error("interdit");
      },
      setItem: () => {
        throw new Error("interdit");
      },
    };
    expect(readRemembered(broken)).toBeNull();
    expect(() => remember("a", broken)).not.toThrow();
    const map = new Map<string, string>();
    remember("b", { setItem: (k, v) => void map.set(k, v) });
    expect(readRemembered({ getItem: (k) => map.get(k) ?? null })).toBe("b");
  });
});

describe("annonce des chargements et retraits", () => {
  it("prévient les écrans abonnés, jusqu'à leur désabonnement", () => {
    const target = new EventTarget();
    let calls = 0;
    const off = onExamplesChange(() => calls++, target);
    announceExamplesChange(target);
    announceExamplesChange(target);
    expect(calls).toBe(2);
    off();
    announceExamplesChange(target);
    expect(calls).toBe(2);
    expect(EXAMPLES_EVENT).toBe("atelier-viz:exemples");
  });
});

describe("section d'exemples de l'accueil", () => {
  it("guide tant qu'il n'y a aucun rapport, puis laisse la place à la liste", () => {
    expect(showExamplesOnHome([])).toBe(true);
    expect(showExamplesOnHome([{ id: "aaaaaaaaaaaa" }])).toBe(false);
    // Liste pas encore lue (ou illisible) : rien, pour ne pas afficher puis retirer la section.
    expect(showExamplesOnHome(null)).toBe(false);
  });
});
