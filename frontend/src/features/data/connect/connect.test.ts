import { describe, expect, it } from "vitest";

import type { Connection } from "../../../types/connection";
import { describeConnection, emptyForm, formOf, groupTables, missingField, sinceLabel, suggestedName, toInput } from "./meta";

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
