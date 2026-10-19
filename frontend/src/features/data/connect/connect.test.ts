import { describe, expect, it } from "vitest";

import type { Connection } from "../../../types/connection";
import { describeConnection, emptyForm, formOf, groupSnapshots, groupTables, missingField, sinceLabel, sourceDetails, suggestedName, toInput } from "./meta";

const pg: Connection = {
  id: "c1",
  name: "Entrepôt",
  kind: "postgres",
  host: "db.local",
  port: 5432,
  database: "ventes",
  username: "lecteur",
  encrypt: false,
  path: null,
  tenant: null,
  client_id: null,
  created_at: "2026-10-19T10:00:00Z",
  has_password: true,
  signed_in: false,
  account: null,
};

describe("connecteurs : formulaires", () => {
  it("prépare un formulaire par type et vérifie les champs obligatoires", () => {
    expect(emptyForm("sqlserver")).toMatchObject({ name: "SQL Server", host: "", password: "" });
    expect(emptyForm("file")).toEqual({ name: "Fichier synchronisé", kind: "file", path: "" });
    expect(missingField(emptyForm("sqlserver"))).toBe("Indiquez le serveur.");
    expect(missingField(emptyForm("sqlite"))).toBe("Indiquez le chemin du fichier.");
    expect(missingField(emptyForm("sharepoint"))).toBeNull();
  });

  it("n'envoie le mot de passe qu'à la création ou s'il a été ressaisi", () => {
    const form = formOf(pg);
    expect(form.password).toBeNull();
    expect("id" in form || "has_password" in form).toBe(false);
    expect(toInput(form, true)).not.toHaveProperty("password"); // inchangé
    expect(toInput({ ...form, password: "nouveau" }, true).password).toBe("nouveau");
    expect(toInput({ ...emptyForm("mysql"), host: " srv ", database: "" }, false)).toMatchObject({ host: "srv", database: null, password: "" });
  });
});

describe("connecteurs : présentation", () => {
  it("décrit les connexions et propose un nom de jeu", () => {
    expect(describeConnection(pg)).toBe("db.local · ventes");
    expect(describeConnection({ ...pg, kind: "file", path: "/Users/f/OneDrive - Contoso/objectifs.xlsx" })).toBe("objectifs.xlsx");
    expect(describeConnection({ ...pg, kind: "sharepoint", signed_in: true, account: "f@contoso.fr" })).toBe("f@contoso.fr");
    expect(suggestedName(pg, { table: { schema: "public", name: "commandes" } })).toBe("commandes");
    expect(suggestedName(pg, { table: { schema: "commercial", name: "commandes" } })).toBe("commercial.commandes");
    expect(suggestedName({ ...pg, kind: "mysql" }, { table: { schema: "ventes", name: "lignes" } })).toBe("lignes");
    expect(suggestedName(pg, { query: "select 1" })).toBe("Entrepôt (requête)");
    expect(suggestedName({ ...pg, kind: "file", path: "C:\\Data\\objectifs.xlsx" }, { table: { name: "2026", kind: "sheet" } })).toBe("objectifs — 2026");
    expect(suggestedName({ ...pg, kind: "sharepoint" }, { url: "https://c.sharepoint.com/sites/V/Lists/Commandes/AllItems.aspx" })).toBe("Commandes");
    expect(suggestedName({ ...pg, kind: "sharepoint" }, { url: "https://c.sharepoint.com/sites/V/Docs/Objectifs%202026.xlsx", table: { name: "T1" } })).toBe(
      "Objectifs 2026 — T1",
    );
  });

  it("regroupe les tables par schéma et cherche sans accents", () => {
    const tables = [
      { schema: "dbo", name: "Ventes" },
      { schema: "dbo", name: "Clients" },
      { schema: "rh", name: "Employés" },
    ];
    expect(groupTables(tables, "").map(([s, l]) => [s, l.length])).toEqual([
      ["dbo", 2],
      ["rh", 1],
    ]);
    expect(groupTables(tables, "employes")).toEqual([["rh", [{ schema: "rh", name: "Employés" }]]]);
    expect(groupTables(tables, "rh.")).toHaveLength(1);
  });

  it("affiche l'ancienneté d'une actualisation", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(sinceLabel("2026-10-19T11:59:40Z", now)).toBe("à l'instant");
    expect(sinceLabel("2026-10-19T11:35:00Z", now)).toBe("il y a 25 min");
    expect(sinceLabel("2026-10-19T09:00:00Z", now)).toBe("il y a 3 h");
    expect(sinceLabel("2026-10-12T09:00:00Z", now)).toBe("le 12/10/2026");
  });
});

describe("connecteurs de la Suite Atelier", () => {
  const tab: Connection = { ...pg, id: "t1", kind: "atelier_tab", name: "Atelier Tab", host: null, port: null, database: null, username: null, has_password: false, path: null };
  const projets: Connection = { ...tab, id: "p1", kind: "atelier_projets", name: "Atelier Projets", base_url: "http://127.0.0.1:3900/" };

  it("formulaires sans secret, champs facultatifs", () => {
    expect(emptyForm("atelier_tab")).toEqual({ name: "Atelier Tab", kind: "atelier_tab", path: "" });
    expect(emptyForm("atelier_projets")).toEqual({ name: "Atelier Projets", kind: "atelier_projets", base_url: "" });
    expect(missingField(emptyForm("atelier_tab"))).toBeNull(); // dossier vide = dossier par défaut
    expect(missingField(emptyForm("atelier_projets"))).toBeNull(); // adresse vide = adresse par défaut
    expect(missingField({ ...emptyForm("atelier_projets"), base_url: "127.0.0.1:3000" })).toBe("Adresse attendue : http://127.0.0.1:3000.");
    expect(toInput(emptyForm("atelier_tab"), false)).not.toHaveProperty("password");
    expect(toInput({ ...emptyForm("atelier_projets"), base_url: " http://127.0.0.1:3900 " }, false)).toMatchObject({ base_url: "http://127.0.0.1:3900", path: null });
  });

  it("décrit la connexion et propose le nom de la table ou du jeu", () => {
    expect(describeConnection(tab)).toBe("~/Atelier_Tab/exports");
    expect(describeConnection({ ...tab, path: "/Users/f/Partage/exports" })).toBe("/Users/f/Partage/exports");
    expect(describeConnection(projets)).toBe("127.0.0.1:3900");
    expect(describeConnection({ ...projets, base_url: null })).toBe("127.0.0.1:3000");
    expect(suggestedName(tab, { table: { name: "Planning & Lots", schema: "Rénovation", kind: "snapshot", id: "tbl_planning_lots" } })).toBe("Planning & Lots");
    expect(suggestedName(projets, { table: { name: "Éléments de travail", kind: "dataset", id: "work-items" }, project_id: "p1" })).toBe("Éléments de travail");
  });

  it("regroupe les tables publiées par projet et les détaille", () => {
    const tables = [
      { name: "Planning & Lots", schema: "Rénovation Urbaine 2026", id: "a", rows: 3, updated_at: "2026-10-18T12:57:00Z" },
      { name: "Budget Global", schema: "Rénovation Urbaine 2026", id: "b", rows: 1 },
      { name: "Brouillon", schema: null, id: "c" },
      { name: "Matériaux", schema: "Chiffrage", id: "d" },
    ];
    expect(groupSnapshots(tables, "").map(([p, l]) => [p, l.map((t) => t.name)])).toEqual([
      ["Chiffrage", ["Matériaux"]],
      ["Rénovation Urbaine 2026", ["Budget Global", "Planning & Lots"]],
      ["Sans projet", ["Brouillon"]],
    ]);
    expect(groupSnapshots(tables, "renovation budget")).toEqual([]);
    expect(groupSnapshots(tables, "materiaux").map(([p]) => p)).toEqual(["Chiffrage"]);
    expect(groupSnapshots(tables, "renovation").flatMap(([, l]) => l)).toHaveLength(2);
    expect(sourceDetails(tables[1]!)).toBe("1 ligne");
    expect(sourceDetails(tables[0]!)).toMatch(/^3 lignes · publiée le 18\/10\/2026 à \d{2}:57$/);
    expect(sourceDetails({ name: "x" })).toBe("");
  });
});
