import { beforeEach, describe, expect, it } from "vitest";

import type { Report, Visual } from "../types/report";
import { applyBookmarkTo, captureBookmark, describeBookmark, nextBookmarkName } from "./bookmarks";
import { bodyOf, useStudio } from "./store";

const slicer = (id: string, selected: unknown[] = []): Visual => ({
  id,
  type: "slicer",
  title: null,
  layout: { x: 0, y: 0, w: 200, h: 200 },
  dataset_id: "d1",
  roles: { field: [{ field: "region" }] },
  options: { selected, range: [null, null] },
  filters: [],
});

const chart = (id: string): Visual => ({
  id,
  type: "column",
  title: null,
  layout: { x: 220, y: 0, w: 400, h: 300 },
  dataset_id: "d1",
  roles: { category: [{ field: "region" }, { field: "ville" }], values: [{ field: "ca", agg: "sum" }] },
  options: {},
  filters: [],
});

function report(): Report {
  return {
    id: "r1",
    version: 1,
    name: "Ventes",
    dataset_id: "d1",
    theme: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pages: [
      { id: "p1", name: "Synthèse", filters: [], size: { width: 1280, height: 720 }, visuals: [slicer("s1"), chart("c1")] },
      { id: "p2", name: "Détail", filters: [], size: { width: 1280, height: 720 }, visuals: [] },
    ],
  };
}

describe("capture et application d'un signet", () => {
  it("retient page, filtres, segments, exploration et sélection, puis les rétablit", () => {
    const r = report();
    const p1 = r.pages[0]!;
    p1.filters = [{ field: "annee", op: "eq", values: [2026] }];
    p1.visuals[0]!.options.selected = ["Occitanie"];
    p1.visuals[1]!.options.drill = { level: 1, path: [{ value: "Occitanie" }] };
    const selection = { visualId: "c1", datasetId: "d1", filters: [{ field: "ville", op: "in" as const, values: ["Toulouse"] }], keys: ["Toulouse"] };
    const b = captureBookmark(r, "p1", selection, { id: "b1", name: "Occitanie", now: "2026-10-19T10:00:00Z" });
    expect(b.page_id).toBe("p1");
    expect(b.pages.p1?.filters).toHaveLength(1);
    expect(b.pages.p1?.visuals.s1?.selected).toEqual(["Occitanie"]);
    expect(b.pages.p1?.visuals.c1?.drill).toEqual({ level: 1, path: [{ value: "Occitanie" }] });
    expect(b.selection?.visual_id).toBe("c1");

    // L'état change ensuite (la capture est une copie, pas une référence).
    p1.filters = [];
    p1.visuals[0]!.options.selected = [];
    delete p1.visuals[1]!.options.drill;
    expect(b.pages.p1?.visuals.s1?.selected).toEqual(["Occitanie"]);

    const applied = applyBookmarkTo(r, b, "p2", null);
    expect(applied).toEqual({ pageId: "p1", selection: { ...selection, filters: selection.filters }, missing: 0 });
    expect(p1.filters).toEqual([{ field: "annee", op: "eq", values: [2026] }]);
    expect(p1.visuals[0]!.options.selected).toEqual(["Occitanie"]);
    expect(p1.visuals[1]!.options.drill).toEqual({ level: 1, path: [{ value: "Occitanie" }] });
  });

  it("ignore les pages et visuels supprimés depuis la capture et garde les nouveaux visuels", () => {
    const r = report();
    r.pages[0]!.visuals[0]!.options.selected = ["Bretagne"];
    const b = captureBookmark(r, "p2", null, { id: "b1", name: "Détail" });
    r.pages = r.pages.filter((p) => p.id !== "p2");
    r.pages[0]!.visuals = [chart("c1"), slicer("s2", ["Nord"])];
    const applied = applyBookmarkTo(r, b, "p1", null);
    expect(applied.pageId).toBe("p1"); // page capturée supprimée : on reste
    expect(applied.missing).toBe(3); // page p2, son état, segment s1
    expect(r.pages[0]!.visuals[1]!.options.selected).toEqual(["Nord"]);
  });

  it("respecte « Page affichée » et « Données » décochées", () => {
    const r = report();
    r.pages[0]!.visuals[0]!.options.selected = ["Normandie"];
    const b = { ...captureBookmark(r, "p2", null, { id: "b1", name: "x" }), apply_data: false };
    r.pages[0]!.visuals[0]!.options.selected = [];
    expect(applyBookmarkTo(r, b, "p1", null).pageId).toBe("p2");
    expect(r.pages[0]!.visuals[0]!.options.selected).toEqual([]);
    const pageOnly = { ...b, apply_page: false, apply_data: true };
    expect(applyBookmarkTo(r, pageOnly, "p1", null).pageId).toBe("p1");
    expect(r.pages[0]!.visuals[0]!.options.selected).toEqual(["Normandie"]);
  });

  it("nomme et décrit les signets", () => {
    const r = report();
    expect(nextBookmarkName([])).toBe("Signet 1");
    const b = captureBookmark(r, "p1", null, { id: "b1", name: "Signet 2" });
    expect(nextBookmarkName([b])).toBe("Signet 3");
    expect(describeBookmark(r, b)).toBe("Synthèse · sans filtre");
    r.pages[0]!.filters = [{ field: "x", op: "eq", values: [1] }];
    r.pages[0]!.visuals[0]!.options.selected = ["A"];
    expect(describeBookmark(r, captureBookmark(r, "p1", null, { id: "b2", name: "y" }))).toBe("Synthèse · 1 filtre · 1 segment");
  });
});

describe("signets dans le Studio", () => {
  beforeEach(() => useStudio.getState().load(report()));

  it("ajoute, applique, met à jour, renomme, réordonne et supprime", () => {
    const s = useStudio.getState;
    s().setOptions("s1", { selected: ["Occitanie"] }, false);
    const a = s().addBookmark("Occitanie");
    s().setPage("p2");
    const b = s().addBookmark();
    expect(s().report?.bookmarks?.map((x) => x.name)).toEqual(["Occitanie", "Signet 2"]);

    s().resetFilters();
    expect(s().applyBookmark(a!)).toBe(true);
    expect(s().pageId).toBe("p1");
    expect(s().report?.pages[0]?.visuals[0]?.options.selected).toEqual(["Occitanie"]);

    // Appliquer n'est pas une édition : pas d'entrée d'historique.
    const before = s().past.length;
    s().applyBookmark(b!);
    expect(s().past.length).toBe(before);
    expect(s().pageId).toBe("p2");

    s().setPage("p1");
    s().setOptions("s1", { selected: ["Bretagne"] }, false);
    s().updateBookmark(a!);
    expect(s().report?.bookmarks?.[0]?.pages.p1?.visuals.s1?.selected).toEqual(["Bretagne"]);

    s().renameBookmark(a!, "  Bretagne  ");
    s().moveBookmark(a!, 1);
    expect(s().report?.bookmarks?.map((x) => x.name)).toEqual(["Signet 2", "Bretagne"]);
    s().removeBookmark(b!);
    expect(s().report?.bookmarks?.map((x) => x.id)).toEqual([a]);
    expect(bodyOf(s().report!).bookmarks).toHaveLength(1);
    expect(s().applyBookmark("inconnu")).toBe(false);
  });

  it("charge un ancien rapport sans signets", () => {
    const old = report();
    delete old.bookmarks;
    useStudio.getState().load(old);
    expect(bodyOf(useStudio.getState().report!).bookmarks).toEqual([]);
    expect(useStudio.getState().addBookmark()).not.toBeNull();
  });
});
