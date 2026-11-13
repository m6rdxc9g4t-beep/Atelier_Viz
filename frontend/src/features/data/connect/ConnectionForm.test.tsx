import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../../lib/api";
import type { Connection, ConnectionInput, ConnectorInfo, ConnectorKind, SharePointApp, SharePointAppInput } from "../../../types/connection";
import { ConnectionForm } from "./ConnectionForm";
import { emptyForm } from "./meta";

const APP = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const info = (kind: ConnectorKind, patch: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  kind,
  label: kind === "sqlserver" ? "SQL Server" : kind,
  description: "",
  driver_installed: true,
  install_hint: null,
  default_port: null,
  needs_online: kind === "sharepoint",
  configured: true,
  default_location: null,
  ...patch,
});

const saved = (input: ConnectionInput): Connection => ({ ...input, id: "c1", created_at: "2026-11-13T10:00:00Z", has_password: false, signed_in: false, account: null }) as Connection;

function Form({ kind, remote, connector, onConnectorsChanged, onSaved = vi.fn() }: { kind: ConnectorKind; remote?: boolean; connector?: ConnectorInfo; onConnectorsChanged?: () => void; onSaved?: (c: Connection) => void }) {
  const [value, setValue] = useState<ConnectionInput>(emptyForm(kind));
  return <ConnectionForm info={connector ?? info(kind)} value={value} onChange={setValue} editing={null} onSaved={onSaved} onCancel={vi.fn()} onDeleted={vi.fn()} onConnectorsChanged={onConnectorsChanged} remote={remote} />;
}

describe("connexion SharePoint : l'application Entra ID se renseigne dans la fenêtre", () => {
  let stored: SharePointApp;
  let puts: SharePointAppInput[];
  beforeEach(() => {
    stored = { client_id: null, tenant: null, source: "none" };
    puts = [];
    vi.spyOn(api.connections, "sharepointApp").mockImplementation(async () => stored);
    vi.spyOn(api.connections, "setSharepointApp").mockImplementation(async (body) => {
      puts.push(body);
      stored = body.client_id ? { client_id: body.client_id.toLowerCase(), tenant: body.tenant, source: "interface" } : { client_id: null, tenant: null, source: "none" };
      return stored;
    });
    vi.spyOn(api.connections, "create").mockImplementation(async (body) => saved(body));
  });
  afterEach(() => vi.restoreAllMocks());

  it("montre les étapes à suivre dans Entra et enregistre les deux identifiants, sans rien de secret", async () => {
    const changed = vi.fn();
    render(<Form kind="sharepoint" connector={info("sharepoint", { configured: false })} onConnectorsChanged={changed} />);
    const panel = await screen.findByRole("region", { name: "Application Entra ID" });
    await within(panel).findByText("À renseigner");
    // Les étapes sont dépliées tant que rien n'est renseigné : type d'application, client public, autorisations, code.
    const steps = within(panel).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    expect(steps[0]).toHaveTextContent("Comptes dans cet annuaire d'organisation uniquement");
    expect(steps[1]).toHaveTextContent("Autoriser les flux de clients publics");
    expect(steps[2]).toHaveTextContent("Microsoft Graph → Autorisations déléguées : Sites.Read.All, Files.Read.All, User.Read, offline_access");
    expect(steps[4]).toHaveTextContent("microsoft.com/devicelogin");
    expect(panel.querySelector('input[type="password"]')).toBeNull();
    expect(within(panel).getByText(/ne sont pas des secrets/)).toBeInTheDocument();

    const save = within(panel).getByRole("button", { name: "Enregistrer l'application" });
    expect(save).toBeDisabled(); // rien de saisi
    await userEvent.type(within(panel).getByLabelText("ID d'application (client)"), "mon-application");
    await userEvent.click(save);
    expect(within(panel).getByRole("alert")).toHaveTextContent("36 caractères");
    expect(puts).toEqual([]);

    await userEvent.clear(within(panel).getByLabelText("ID d'application (client)"));
    await userEvent.type(within(panel).getByLabelText("ID d'application (client)"), APP);
    await userEvent.click(save);
    // Application à locataire unique : sans l'annuaire, la connexion par code échouerait.
    expect(within(panel).getByRole("alert")).toHaveTextContent("ID de l'annuaire (locataire)");
    expect(puts).toEqual([]);

    await userEvent.type(within(panel).getByLabelText("ID de l'annuaire (locataire)"), TENANT);
    await userEvent.click(save);
    await waitFor(() => expect(puts).toEqual([{ client_id: APP, tenant: TENANT }]));
    expect(await within(panel).findByRole("status")).toHaveTextContent("Application enregistrée");
    expect(within(panel).getByText("Renseignée ici")).toBeInTheDocument();
    expect(changed).toHaveBeenCalledOnce(); // la liste des sources relit « à renseigner »
    expect(save).toBeDisabled();
  });

  it("enregistre l'application saisie avec la connexion, et s'arrête si elle est refusée", async () => {
    const onSaved = vi.fn();
    render(<Form kind="sharepoint" onSaved={onSaved} />);
    const panel = await screen.findByRole("region", { name: "Application Entra ID" });
    await within(panel).findByText("À renseigner");
    await userEvent.type(within(panel).getByLabelText("ID d'application (client)"), APP);
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer et parcourir" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("ID de l'annuaire (locataire)");
    expect(api.connections.create).not.toHaveBeenCalled();

    await userEvent.type(within(panel).getByLabelText("ID de l'annuaire (locataire)"), "contoso.fr");
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer et parcourir" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(puts).toEqual([{ client_id: APP, tenant: "contoso.fr" }]);
    // La connexion elle-même ne porte pas d'application propre : elle suit celle par défaut.
    expect(vi.mocked(api.connections.create).mock.calls[0]?.[0]).toMatchObject({ kind: "sharepoint", client_id: null, tenant: null });
  });

  it("application fournie par le serveur : dite, étapes repliées, remplaçable ; « Effacer » seulement pour celle saisie ici", async () => {
    stored = { client_id: APP, tenant: "contoso.fr", source: "environment" };
    render(<Form kind="sharepoint" />);
    const panel = await screen.findByRole("region", { name: "Application Entra ID" });
    expect(await within(panel).findByText("Fournie par le serveur (SHAREPOINT_CLIENT_ID)")).toBeInTheDocument();
    expect(within(panel).getByLabelText("ID d'application (client)")).toHaveValue(APP);
    expect(panel.querySelector("details")).not.toHaveAttribute("open");
    expect(within(panel).queryByRole("button", { name: "Effacer" })).toBeNull();

    await userEvent.clear(within(panel).getByLabelText("ID d'application (client)"));
    await userEvent.type(within(panel).getByLabelText("ID d'application (client)"), "99999999-2222-3333-4444-555555555555");
    await userEvent.click(within(panel).getByRole("button", { name: "Enregistrer l'application" }));
    await userEvent.click(await within(panel).findByRole("button", { name: "Effacer" }));
    await waitFor(() => expect(puts.at(-1)).toEqual({ client_id: null, tenant: null }));
  });
});

describe("Atelier Viz sur un serveur : quelle machine lit le fichier", () => {
  afterEach(() => vi.restoreAllMocks());

  it("« Fichier synchronisé » explique qu'il lit un dossier du serveur, et quoi faire d'un fichier de son poste", () => {
    render(<Form kind="file" remote />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Atelier Viz tourne ici sur un serveur.");
    expect(note).toHaveTextContent("un fichier du serveur qui fait tourner Atelier Viz");
    expect(note).toHaveTextContent("pas un fichier de cet ordinateur");
    expect(note).toHaveTextContent("déposez-le dans Données");
    expect(note).toHaveTextContent("« SharePoint Online » ou « Fichier web (URL) »");
    expect(screen.getByLabelText("Chemin du fichier sur le serveur d'Atelier Viz")).toHaveAttribute("placeholder", "/data/partage/objectifs.xlsx");
  });

  it("sur son ordinateur, rien ne change", () => {
    render(<Form kind="file" remote={false} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByLabelText("Chemin du fichier sur cette machine")).toBeInTheDocument();
  });

  it("pilote absent : sur un serveur, rien n'est à installer sur son ordinateur", () => {
    const missing = info("sqlserver", { driver_installed: false, install_hint: "pip install pymssql" });
    const { unmount } = render(<Form kind="sqlserver" connector={missing} remote />);
    expect(screen.getByRole("alert")).toHaveTextContent("Pilote SQL Server absent sur le serveur d'Atelier Viz");
    expect(screen.getByRole("alert")).toHaveTextContent("requirements-connectors.txt");
    expect(screen.getByRole("alert")).not.toHaveTextContent("pip install");
    unmount();
    render(<Form kind="sqlserver" connector={missing} remote={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("lancez pip install pymssql");
  });
});
