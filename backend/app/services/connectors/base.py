"""Éléments communs aux connecteurs : erreurs, contrôle réseau, conversion des lignes en DataFrame."""

import datetime as dt
import decimal
import ipaddress
import socket
import uuid
from collections.abc import Sequence
from typing import Any

import pandas as pd

from app.schemas.connection import PreviewResult
from app.services.data.profiling import to_json


class ConnectorError(Exception):
    """Erreur présentable à l'utilisateur (message en français), avec son code HTTP."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def short(exc: BaseException, limit: int = 400) -> str:
    """Message d'erreur d'un pilote, sur une ligne, sans doublons ni en-têtes techniques, raccourci."""
    flat: list[object] = []
    for a in exc.args:  # pymssql : args = ((20009, b"…"),)
        flat.extend(a if isinstance(a, tuple) else (a,))
    parts = [a.decode("utf-8", "replace") if isinstance(a, bytes) else a for a in flat]
    raw = "\n".join(p for p in parts if isinstance(p, str)) or str(exc)
    lines: list[str] = []
    for line in raw.splitlines():
        line = " ".join(line.split())
        # pymssql (FreeTDS) : « DB-Lib error message 20009, severity 9: » puis le texte utile, répété.
        if line and not line.startswith("DB-Lib error message") and line not in lines:
            lines.append(line)
    text = " — ".join(lines) or type(exc).__name__
    return text if len(text) <= limit else text[: limit - 1] + "…"


def server_hostname(host: str) -> str:
    """Nom d'hôte seul : sans « tcp: », instance SQL Server (« srv\\PROD ») ni port (« srv,1433 »)."""
    h = host.strip()
    if h.lower().startswith("tcp:"):
        h = h[4:]
    h = h.split("\\", 1)[0].split(",", 1)[0]
    if h.startswith("[") and "]" in h:  # IPv6 entre crochets
        return h[1 : h.index("]")]
    if h.count(":") == 1:  # hôte:port
        h = h.split(":", 1)[0]
    return h


def check_server(host: str, online: bool) -> None:
    """Hors ligne, seuls la machine et les réseaux privés (entreprise, VPN) sont joignables.

    Lève `ConnectorError` 403 pour une adresse publique, 422 pour un serveur introuvable.
    """
    if online:
        return
    name = server_hostname(host)
    if name.lower() in {"localhost", ".", "(local)", "host.docker.internal"} or name.lower().endswith(".local"):
        return
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(name, None)}
    except (socket.gaierror, UnicodeError) as exc:
        raise ConnectorError(f"Serveur « {name} » introuvable : vérifiez le nom (ou le VPN de l'entreprise).") from exc
    ips = [ipaddress.ip_address(str(a).split("%")[0]) for a in addresses]
    if not all(ip.is_private or ip.is_loopback for ip in ips):
        raise ConnectorError(
            f"Mode hors ligne : « {name} » est une adresse Internet. Activez le mode « En ligne » "
            "pour vous y connecter, ou passez par le réseau de l'entreprise.",
            403,
        )


def unique_names(names: Sequence[Any]) -> list[str]:
    """Noms de colonnes non vides et uniques (« colonne_3 », « montant_2 »)."""
    out: list[str] = []
    for i, raw in enumerate(names):
        name = "" if raw is None else str(raw).strip()
        if not name:
            name = f"colonne_{i + 1}"
        base, n = name, 2
        while name in out:
            name, n = f"{base}_{n}", n + 1
        out.append(name)
    return out


def _convert(series: pd.Series) -> pd.Series:
    """Type pandas d'une colonne venue d'une base : nombres, dates, booléens ; le reste en texte."""
    values = series.dropna()
    if values.empty:
        return series.astype("object").where(series.notna(), None)
    kinds = {type(v) for v in values}
    if kinds <= {bool}:
        return series.astype("boolean")
    if all(issubclass(k, (int, float, decimal.Decimal)) and not issubclass(k, bool) for k in kinds):
        return pd.to_numeric(series.map(lambda v: float(v) if isinstance(v, decimal.Decimal) else v), errors="coerce")
    if all(issubclass(k, (dt.datetime, dt.date)) for k in kinds) or all(issubclass(k, pd.Timestamp) for k in kinds):
        converted = pd.to_datetime(series, errors="coerce", utc=any(getattr(v, "tzinfo", None) for v in values))
        if getattr(converted.dt, "tz", None) is not None:
            converted = converted.dt.tz_convert("UTC").dt.tz_localize(None)
        return converted
    if all(issubclass(k, (bytes, bytearray, memoryview)) for k in kinds):
        return pd.Series([None] * len(series), index=series.index, dtype="object")  # binaire : non exploitable

    def text(v: Any) -> Any:
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return None
        if isinstance(v, (bytes, bytearray, memoryview)):
            return None
        if isinstance(v, (uuid.UUID, dt.time, dt.timedelta, decimal.Decimal)):
            return str(v)
        return v if isinstance(v, str) else str(v)

    return series.map(text).astype("object")


def rows_to_frame(columns: Sequence[Any], rows: Sequence[Sequence[Any]]) -> pd.DataFrame:
    """Lignes d'un curseur DB-API → DataFrame typé (les types de la base sont conservés, sans réinterprétation)."""
    names = unique_names(columns)
    df = pd.DataFrame.from_records([tuple(r) for r in rows], columns=names) if rows else pd.DataFrame(columns=names)
    for name in names:
        df[name] = _convert(df[name])
    return df


def preview_of(df: pd.DataFrame, truncated: bool) -> PreviewResult:
    """Aperçu sérialisable en JSON."""
    return PreviewResult(
        columns=list(df.columns),
        rows=[{c: to_json(v) for c, v in zip(df.columns, row, strict=True)} for row in df.itertuples(index=False)],
        truncated=truncated,
    )
