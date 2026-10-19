"""Sources de la Suite Atelier (docs/SUITE.md §4.2 et §4.3).

- **Atelier Tab** : instantanés DataFlow v2.1.0 que l'application de bureau écrit dans un dossier
  (`~/Atelier_Tab/exports/<tableId>.json` par défaut). Aucun réseau : simple lecture de fichiers, limitée au
  dossier et à `ATELIER_TAB_MAX_SNAPSHOT_MB` ; métadonnées en cache par (chemin, mtime_ns, taille).
- **Atelier Projets** : API locale en lecture seule (`GET /api/exports/datasets`, `GET /api/exports/datasets/:name`),
  sans secret. Adresse de la machine uniquement (`check_loopback` : 127.0.0.0/8, ::1, localhost), quel que soit
  le mode ; les redirections ne sont jamais suivies.

Fonctions synchrones (disque, httpx, pandas) : à appeler via `asyncio.to_thread`.
"""

import json
import os
import re
import threading
from collections import OrderedDict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx
import pandas as pd

from app.schemas.connection import ProjectRef, TableRef
from app.services.connectors.base import ConnectorError, short, unique_names
from app.services.data.dataflow import DataflowError, DataflowInfo, dataflow_frame, dataflow_info, is_dataflow

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


def _too_big(size: int, max_bytes: int) -> str:
    return (
        f"Instantané trop volumineux ({size / 1_000_000:.0f} Mo, max {max_bytes // 1_000_000} Mo). "
        "Allégez la table dans Atelier Tab, ou augmentez ATELIER_TAB_MAX_SNAPSHOT_MB dans backend/.env."
    )


def _inside(folder: Path, path: Path) -> Path | None:
    """Chemin réel de `path` s'il reste dans `folder` (lien symbolique compris) et désigne un fichier, sinon None."""
    try:
        real = path.resolve(strict=True)
        root = folder.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    return real if real.is_relative_to(root) and real.is_file() else None


def _parse(raw: bytes, name: str) -> dict[str, Any]:
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConnectorError(f"Instantané illisible : {name} ({short(exc, 160)}).") from exc
    if not is_dataflow(data):
        raise ConnectorError(f"{name} n'est pas un instantané Atelier Tab (enveloppe DataFlow attendue).")
    return data


def _read_bounded(real: Path, max_bytes: int) -> tuple[bytes, os.stat_result]:
    """Contenu du fichier (refus au-delà de `max_bytes`, même s'il grossit pendant la lecture) et son état."""
    with real.open("rb") as handle:
        stat = os.fstat(handle.fileno())
        if stat.st_size > max_bytes:
            raise ConnectorError(_too_big(stat.st_size, max_bytes), 413)
        raw = handle.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ConnectorError(_too_big(len(raw), max_bytes), 413)
    return raw, stat


class _InfoCache:
    """Métadonnées des instantanés par (chemin réel, mtime_ns, taille) : « Tester » et « Parcourir » ne relisent
    que les fichiers modifiés. `None` = fichier qui n'est pas un instantané (ignoré jusqu'à sa modification)."""

    def __init__(self, capacity: int = 1024) -> None:
        self.capacity = capacity
        self._items: OrderedDict[tuple[str, int, int], DataflowInfo | None] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: tuple[str, int, int]) -> tuple[bool, DataflowInfo | None]:
        with self._lock:
            if key not in self._items:
                return False, None
            self._items.move_to_end(key)
            return True, self._items[key]

    def put(self, key: tuple[str, int, int], info: DataflowInfo | None) -> None:
        with self._lock:
            # Une seule entrée par fichier : l'ancienne version est oubliée.
            for old in [k for k in self._items if k[0] == key[0] and k != key]:
                del self._items[old]
            self._items[key] = info
            while len(self._items) > self.capacity:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


SNAPSHOT_INFO_CACHE = _InfoCache()


def _snapshot_info(real: Path, stat: os.stat_result, max_bytes: int) -> DataflowInfo | None:
    """Résumé d'un instantané (depuis le cache si le fichier n'a pas changé) ; None si ce n'en est pas un."""
    key = (str(real), stat.st_mtime_ns, stat.st_size)
    hit, info = SNAPSHOT_INFO_CACHE.get(key)
    if hit:
        return info
    try:
        raw, current = _read_bounded(real, max_bytes)
        info = dataflow_info(_parse(raw, real.name))
    except (ConnectorError, OSError):
        info, current = None, stat
    SNAPSHOT_INFO_CACHE.put((str(real), current.st_mtime_ns, current.st_size), info)
    return info


def list_snapshots(folder: Path, max_bytes: int) -> list[TableRef]:
    """Tables publiées dans le dossier : nom, projet (`schema`), date de publication, nombre de lignes.

    - Les fichiers JSON qui ne sont pas des instantanés (ou illisibles, en cours d'écriture) sont ignorés,
      comme les liens symboliques qui sortent du dossier.
    - Un instantané plus gros que `max_bytes` est listé (sous son nom de fichier) sans être lu : son import
      explique la limite.
    - Les métadonnées sont mises en cache par (chemin, mtime_ns, taille).
    """
    _require_folder(folder)
    tables: list[TableRef] = []
    for path in sorted(folder.glob("*.json")):
        if not _SNAPSHOT_ID_RE.match(path.stem):
            continue
        real = _inside(folder, path)
        if real is None:
            continue
        try:
            stat = real.stat()
        except OSError:
            continue
        published_fallback = datetime.fromtimestamp(stat.st_mtime, UTC)
        if stat.st_size > max_bytes:
            tables.append(
                TableRef(
                    name=path.stem,
                    kind="snapshot",
                    id=path.stem,
                    description=_too_big(stat.st_size, max_bytes)[:500],
                    updated_at=published_fallback,
                )
            )
            continue
        info = _snapshot_info(real, stat, max_bytes)
        if info is None:
            continue
        tables.append(
            TableRef(
                name=info.table_name,
                schema=info.project_name or None,
                kind="snapshot",
                id=path.stem,
                description=info.workspace_name or None,
                updated_at=info.exported_at or published_fallback,
                rows=info.rows,
            )
        )
    tables.sort(key=lambda t: ((t.schema_ or "").lower(), t.name.lower()))
    return tables


def read_snapshot(folder: Path, snapshot_id: str | None, max_bytes: int) -> tuple[pd.DataFrame, str]:
    """(données à plat, nom de la table) d'un instantané désigné par son identifiant (nom du fichier sans `.json`).

    Le fichier doit être dans le dossier (pas de « .. », pas de lien symbolique qui en sort) et ne pas dépasser
    `max_bytes` (HTTP 413 sinon).
    """
    if not snapshot_id or not _SNAPSHOT_ID_RE.match(snapshot_id) or ".." in snapshot_id:
        raise ConnectorError("Choisissez une table publiée par Atelier Tab.")
    _require_folder(folder)
    path = folder / f"{snapshot_id}.json"
    real = _inside(folder, path)
    if real is None:
        if path.is_symlink() and not path.resolve().is_relative_to(folder.resolve()):
            raise ConnectorError(
                f"« {snapshot_id} » est un lien vers un fichier hors du dossier {folder} : refusé.", 403
            )
        raise ConnectorError(
            f"La table « {snapshot_id} » n'est plus publiée dans {folder} (supprimée dans Atelier Tab ?).", 404
        )
    raw, stat = _read_bounded(real, max_bytes)
    data = _parse(raw, path.name)
    info = dataflow_info(data)
    SNAPSHOT_INFO_CACHE.put((str(real), stat.st_mtime_ns, stat.st_size), info)
    try:
        df = dataflow_frame(data)
    except DataflowError as exc:
        raise ConnectorError(str(exc)) from exc
    return df, info.table_name


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
            # Jamais de redirection : elle pourrait mener hors de la machine (docs/SUITE.md §4.3).
            response = self.http.get(url, params=params, follow_redirects=False)
        except httpx.TimeoutException as exc:
            raise ConnectorError(f"Atelier Projets ne répond pas à temps ({self.base}).", 504) from exc
        except httpx.HTTPError as exc:
            raise ConnectorError(
                f"Atelier Projets est injoignable à {self.base} : lancez-le (son API écoute sur le port 3000), "
                "ou corrigez l'adresse de la connexion.",
                503,
            ) from exc
        if response.is_redirect:
            raise ConnectorError(
                f"Atelier Projets ({self.base}) a renvoyé une redirection (HTTP {response.status_code}) : "
                "elle n'est pas suivie. Indiquez l'adresse exacte de son API (par exemple http://127.0.0.1:3000).",
                502,
            )
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


def _local_naive(series: pd.Series) -> pd.Series:
    """Horodatages UTC → heure locale de la machine (heure d'été comprise), sans fuseau.

    Atelier Projets envoie ses `datetime` en ISO 8601 UTC (« …Z ») ; l'utilisateur les attend à l'heure
    de sa montre. `datetime.astimezone()` sans argument suit le fuseau du système (variable `TZ` comprise).
    """
    local = [None if pd.isna(ts) else ts.to_pydatetime().astimezone().replace(tzinfo=None) for ts in series]
    return pd.Series(pd.to_datetime(local), index=series.index, dtype="datetime64[ns]")


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
        if kind == "date":  # AAAA-MM-JJ : jour calendaire, sans décalage horaire
            return converted.dt.tz_localize(None).dt.normalize()
        return _local_naive(converted)
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
