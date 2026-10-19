"""Sources de la Suite Atelier (docs/SUITE.md §4.2 et §4.3).

- **Atelier Tab** : instantanés DataFlow v2.1.0 que l'application de bureau écrit dans un dossier
  (`~/Atelier_Tab/exports/<tableId>.json` par défaut). Aucun réseau : simple lecture de fichiers.
- **Atelier Projets** : API locale en lecture seule (`GET /api/exports/datasets`, `GET /api/exports/datasets/:name`),
  sans secret. L'adresse passe par la politique réseau `check_server` (machine et réseau privé hors ligne).

Fonctions synchrones (disque, httpx, pandas) : à appeler via `asyncio.to_thread`.
"""

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx
import pandas as pd

from app.schemas.connection import ProjectRef, TableRef
from app.services.connectors.base import ConnectorError, short, unique_names
from app.services.data.dataflow import DataflowError, dataflow_frame, dataflow_info, is_dataflow

# --- Atelier Tab : dossier d'instantanés -------------------------------------------------------------

_SNAPSHOT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,199}$")


def tab_folder(path: str | None, default: Path) -> Path:
    """Dossier des instantanés : celui de la connexion, sinon le dossier par défaut (`~` développé)."""
    raw = (path or "").strip()
    return Path(raw).expanduser() if raw else default.expanduser()


def _require_folder(folder: Path) -> None:
    if not folder.is_dir():
        raise ConnectorError(
            f"Dossier introuvable : {folder}. L'application de bureau Atelier Tab y publie chaque table à son "
            "enregistrement ; vérifiez le chemin (réglage de la connexion).",
            404,
        )


def _load(path: Path, max_bytes: int) -> dict[str, Any]:
    size = path.stat().st_size
    if size > max_bytes:
        raise ConnectorError(
            f"Instantané trop volumineux ({size // 1_000_000} Mo, max {max_bytes // 1_000_000} Mo).", 413
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConnectorError(f"Instantané illisible : {path.name} ({short(exc, 160)}).") from exc
    if not is_dataflow(data):
        raise ConnectorError(f"{path.name} n'est pas un instantané Atelier Tab (enveloppe DataFlow attendue).")
    return data


def list_snapshots(folder: Path, max_bytes: int) -> list[TableRef]:
    """Tables publiées dans le dossier : nom, projet (`schema`), date de publication, nombre de lignes.

    Les fichiers JSON qui ne sont pas des instantanés (ou illisibles, en cours d'écriture) sont ignorés.
    """
    _require_folder(folder)
    tables: list[TableRef] = []
    for path in sorted(folder.glob("*.json")):
        if not path.is_file() or not _SNAPSHOT_ID_RE.match(path.stem):
            continue
        try:
            data = _load(path, max_bytes)
        except (ConnectorError, OSError):
            continue
        info = dataflow_info(data)
        published = info.exported_at or datetime.fromtimestamp(path.stat().st_mtime, UTC)
        tables.append(
            TableRef(
                name=info.table_name,
                schema=info.project_name or None,
                kind="snapshot",
                id=path.stem,
                description=info.workspace_name or None,
                updated_at=published,
                rows=info.rows,
            )
        )
    tables.sort(key=lambda t: ((t.schema_ or "").lower(), t.name.lower()))
    return tables


def read_snapshot(folder: Path, snapshot_id: str | None, max_bytes: int) -> tuple[pd.DataFrame, str]:
    """(données à plat, nom de la table) d'un instantané désigné par son identifiant (nom du fichier sans `.json`)."""
    if not snapshot_id or not _SNAPSHOT_ID_RE.match(snapshot_id) or ".." in snapshot_id:
        raise ConnectorError("Choisissez une table publiée par Atelier Tab.")
    _require_folder(folder)
    path = folder / f"{snapshot_id}.json"
    if not path.is_file():
        raise ConnectorError(
            f"La table « {snapshot_id} » n'est plus publiée dans {folder} (supprimée dans Atelier Tab ?).", 404
        )
    data = _load(path, max_bytes)
    try:
        df = dataflow_frame(data)
    except DataflowError as exc:
        raise ConnectorError(str(exc)) from exc
    return df, dataflow_info(data).table_name


# --- Atelier Projets : API locale --------------------------------------------------------------------

PROJETS_TYPES = {"string", "number", "date", "datetime", "boolean"}


def projets_base(url: str | None, default: str) -> str:
    """Adresse d'Atelier Projets sans « / » final (celle de la connexion, sinon la valeur par défaut)."""
    return ((url or "").strip() or default).rstrip("/")


def projets_host(base: str) -> str:
    """Nom d'hôte de l'adresse (pour la politique réseau)."""
    host = urlparse(base).hostname
    if not host:
        raise ConnectorError(f"Adresse d'Atelier Projets invalide : « {base} ».")
    return host


class ProjetsClient:
    """Client de l'API d'export d'Atelier Projets (lecture seule, aucun secret)."""

    def __init__(self, base: str, http: httpx.Client) -> None:
        self.base = base
        self.http = http

    def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        url = f"{self.base}{path}"
        try:
            response = self.http.get(url, params=params)
        except httpx.TimeoutException as exc:
            raise ConnectorError(f"Atelier Projets ne répond pas à temps ({self.base}).", 504) from exc
        except httpx.HTTPError as exc:
            raise ConnectorError(
                f"Atelier Projets est injoignable à {self.base} : lancez-le (son API écoute sur le port 3000), "
                "ou corrigez l'adresse de la connexion.",
                503,
            ) from exc
        if response.status_code == 404:
            raise ConnectorError(
                f"Atelier Projets ({self.base}) ne connaît pas {path.split('?')[0]} : "
                "mettez-le à jour (exports de jeux de données requis).",
                404,
            )
        if response.status_code >= 400:
            detail = ""
            try:
                body = response.json()
                if isinstance(body, dict):
                    detail = str(body.get("message") or body.get("error") or body.get("detail") or "")
            except ValueError:
                pass
            raise ConnectorError(
                f"Atelier Projets a refusé la demande (HTTP {response.status_code})"
                + (f" : {detail}" if detail else "."),
                502,
            )
        try:
            return response.json()
        except ValueError as exc:
            raise ConnectorError(
                f"Réponse illisible d'Atelier Projets ({self.base}{path}) : JSON attendu.", 502
            ) from exc

    def health(self) -> bool:
        """Vrai si `GET /api/health` répond."""
        self._get("/api/health")
        return True

    def datasets(self) -> list[TableRef]:
        """Jeux de données exportables (`GET /api/exports/datasets`)."""
        raw = self._get("/api/exports/datasets")
        if not isinstance(raw, list):
            raise ConnectorError("Réponse inattendue d'Atelier Projets : liste de jeux de données attendue.", 502)
        out: list[TableRef] = []
        for item in raw:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"]:
                continue
            count = item.get("rowCount")
            out.append(
                TableRef(
                    name=str(item.get("label") or item["name"])[:255],
                    kind="dataset",
                    id=item["name"][:255],
                    description=str(item["description"])[:500] if item.get("description") else None,
                    rows=count if isinstance(count, int) and count >= 0 else None,
                )
            )
        return out

    def projects(self) -> list[ProjectRef]:
        """Projets (`GET /api/projects`) pour le filtre facultatif ; liste vide si indisponible."""
        try:
            raw = self._get("/api/projects")
        except ConnectorError:
            return []
        if not isinstance(raw, list):
            return []
        return [
            ProjectRef(id=str(p["id"]), name=str(p.get("name") or p["id"]))
            for p in raw
            if isinstance(p, dict) and p.get("id") is not None
        ]

    def dataset(self, name: str, project_id: str | None) -> tuple[pd.DataFrame, str]:
        """(données typées, libellé) d'un jeu (`GET /api/exports/datasets/:name?projectId=`)."""
        params = {"projectId": project_id} if project_id else None
        raw = self._get(f"/api/exports/datasets/{quote(name, safe='')}", params)
        if (
            not isinstance(raw, dict)
            or not isinstance(raw.get("columns"), list)
            or not isinstance(raw.get("rows"), list)
        ):
            raise ConnectorError("Réponse inattendue d'Atelier Projets : { columns, rows } attendu.", 502)
        return projets_frame(raw["columns"], raw["rows"]), str(raw.get("label") or name)


def _projets_column(kind: str, values: list[Any]) -> pd.Series:
    """Colonne typée selon le type annoncé par Atelier Projets (aucune réinterprétation)."""
    if kind == "number":
        return pd.to_numeric(
            pd.Series([v if isinstance(v, (int, float, str)) and not isinstance(v, bool) else None for v in values]),
            errors="coerce",
        )
    if kind in {"date", "datetime"}:
        series = pd.Series([v if isinstance(v, str) and v else None for v in values], dtype="object")
        converted = pd.to_datetime(series, errors="coerce", utc=True, format="ISO8601")
        converted = converted.dt.tz_convert("UTC").dt.tz_localize(None)
        return converted.dt.normalize() if kind == "date" else converted
    if kind == "boolean":
        return pd.Series([v if isinstance(v, bool) else None for v in values], dtype="boolean")
    return pd.Series(
        [
            None
            if v is None
            else v
            if isinstance(v, str)
            else json.dumps(v, ensure_ascii=False)
            if isinstance(v, (dict, list))
            else str(v)
            for v in values
        ],
        dtype="object",
    )


def projets_frame(columns: list[Any], rows: list[Any]) -> pd.DataFrame:
    """`columns: [{ key, label, type }]` + `rows` (par `key`) → DataFrame ; colonnes nommées par leur libellé."""
    cols = [c for c in columns if isinstance(c, dict) and isinstance(c.get("key"), str) and c["key"]]
    if not cols:
        raise ConnectorError("Jeu de données d'Atelier Projets sans colonne.", 502)
    names = unique_names([str(c.get("label") or c["key"]).strip() or c["key"] for c in cols])
    records = [r for r in rows if isinstance(r, dict)]
    data: dict[str, pd.Series] = {}
    for name, col in zip(names, cols, strict=True):
        kind = col.get("type") if col.get("type") in PROJETS_TYPES else "string"
        data[name] = _projets_column(str(kind), [r.get(col["key"]) for r in records])
    return pd.DataFrame(data)
