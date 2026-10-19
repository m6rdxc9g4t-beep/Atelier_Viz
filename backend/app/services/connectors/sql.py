"""Connecteurs SQL : SQL Server (pymssql), PostgreSQL (psycopg), MySQL / MariaDB (PyMySQL), SQLite.

Lecture seule :
- une requête libre doit être **une seule** instruction SELECT / WITH, sans mot-clé d'écriture
  (`check_query`) ; c'est un garde-fou, pas une frontière de sécurité : utilisez un compte en
  lecture seule (rôle `db_datareader` sous SQL Server, `pg_read_all_data` sous PostgreSQL…) ;
- PostgreSQL et MySQL ouvrent en plus une transaction en lecture seule, SQLite ouvre le fichier
  en mode `ro`.
Les lignes sont lues par paquets jusqu'à la limite demandée (jamais tout en mémoire d'un coup).
"""

import importlib.util
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import pandas as pd

from app.schemas.connection import ConnectionFields, ConnectorKind, TableRef
from app.services.connectors.base import ConnectorError, rows_to_frame, short

FETCH_CHUNK = 5000
MAX_TABLES = 2000

# Mots-clés d'écriture refusés dans une requête libre (hors chaînes et commentaires). La requête commence
# forcément par SELECT / WITH et ne contient qu'une instruction : restent à bloquer SELECT … INTO, les CTE
# qui modifient (PostgreSQL : WITH x AS (DELETE …)) et les accès distants ad hoc de SQL Server.
WRITE_WORDS = {
    "insert", "update", "delete", "merge", "drop", "alter", "create", "truncate", "grant", "revoke", "deny",
    "exec", "execute", "into", "attach", "detach", "pragma", "copy",
    "openrowset", "opendatasource", "openquery", "xp_cmdshell",
}  # fmt: skip
_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_$#@]*")


def _code_only(sql: str) -> tuple[str, list[int]]:
    """Texte hors chaînes, identifiants délimités et commentaires (remplacés par des espaces) ; positions des « ; »."""
    out: list[str] = []
    semis: list[int] = []
    i, n = 0, len(sql)
    closers = {"'": "'", '"': '"', "`": "`", "[": "]"}
    while i < n:
        c = sql[i]
        if c == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif c == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            if j < 0:
                raise ConnectorError("Commentaire /* … */ non fermé dans la requête.")
            out.append(" " * (j + 2 - i))
            i = j + 2
        elif c in closers:
            close = closers[c]
            j = i + 1
            while True:
                k = sql.find(close, j)
                if k < 0:
                    raise ConnectorError("Chaîne ou identifiant non fermé dans la requête.")
                if sql.startswith(close * 2, k):
                    j = k + 2  # délimiteur doublé = caractère échappé ('', "", ]], ``)
                    continue
                break
            out.append(" " * (k + 1 - i))
            i = k + 1
        else:
            if c == ";":
                semis.append(len("".join(out)))
            out.append(c)
            i += 1
    return "".join(out), semis


def check_query(sql: str) -> str:
    """Valide une requête libre : une seule instruction SELECT / WITH en lecture.

    Retourne la requête sans « ; » final.
    """
    text = sql.strip()
    if not text:
        raise ConnectorError("La requête est vide.")
    code, semis = _code_only(text)
    # Un « ; » n'est admis qu'en toute fin de requête.
    for pos in semis:
        if code[pos + 1 :].strip():
            raise ConnectorError("Une seule instruction est autorisée (pas de « ; » au milieu de la requête).")
    words = [w.lower() for w in _WORD_RE.findall(code)]
    if not words or words[0] not in {"select", "with"}:
        raise ConnectorError("Seules les requêtes de lecture sont autorisées : commencez par SELECT ou WITH.")
    bad = sorted({w for w in words if w in WRITE_WORDS})
    if bad:
        raise ConnectorError(f"Requête refusée : « {bad[0].upper()} » n'est pas autorisé (lecture seule).")
    if semis:
        text = text[: text.rstrip().rfind(";")].rstrip() if text.rstrip().endswith(";") else text
    return text


class DbConnection(Protocol):
    def cursor(self) -> Any: ...
    def close(self) -> None: ...


@dataclass(frozen=True)
class Dialect:
    """Particularités d'un moteur SQL : pilote, guillemets, liste des tables, limite."""

    kind: ConnectorKind
    label: str
    description: str
    module: str | None
    install_hint: str | None
    default_port: int | None

    def driver_installed(self) -> bool:
        return self.module is None or importlib.util.find_spec(self.module) is not None

    def quote(self, ident: str) -> str:
        if self.kind == "sqlserver":
            return "[" + ident.replace("]", "]]") + "]"
        if self.kind == "mysql":
            return "`" + ident.replace("`", "``") + "`"
        return '"' + ident.replace('"', '""') + '"'

    def relation(self, ref: TableRef) -> str:
        name = self.quote(ref.name)
        return f"{self.quote(ref.schema_)}.{name}" if ref.schema_ else name

    def select_table(self, ref: TableRef, limit: int | None) -> str:
        rel = self.relation(ref)
        if limit is None:
            return f"SELECT * FROM {rel}"
        if self.kind == "sqlserver":
            return f"SELECT TOP ({int(limit)}) * FROM {rel}"
        return f"SELECT * FROM {rel} LIMIT {int(limit)}"

    def tables_sql(self, database: str | None) -> tuple[str, list[Any]]:
        if self.kind == "sqlite":
            return (
                "SELECT NULL, name, type FROM sqlite_master "
                "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
                [],
            )
        if self.kind == "mysql":
            where = (
                "TABLE_SCHEMA = DATABASE()"
                if database
                else "TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')"
            )
            return (
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES "
                f"WHERE {where} ORDER BY 1, 2",
                [],
            )
        if self.kind == "postgres":
            return (
                "SELECT table_schema, table_name, table_type FROM information_schema.tables "
                "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') "
                "AND table_schema NOT LIKE 'pg_toast%' ORDER BY 1, 2",
                [],
            )
        return ("SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY 1, 2", [])

    def version_sql(self) -> str:
        return {"sqlserver": "SELECT @@VERSION", "postgres": "SELECT version()", "mysql": "SELECT VERSION()"}.get(
            self.kind, "SELECT 'SQLite ' || sqlite_version()"
        )


DIALECTS: dict[ConnectorKind, Dialect] = {
    "sqlserver": Dialect(
        "sqlserver",
        "SQL Server",
        "Microsoft SQL Server, Azure SQL, SQL Server Express",
        "pymssql",
        "pip install pymssql",
        1433,
    ),
    "postgres": Dialect(
        "postgres",
        "PostgreSQL",
        "PostgreSQL, Supabase, Neon, Amazon RDS / Aurora",
        "psycopg",
        'pip install "psycopg[binary]"',
        5432,
    ),
    "mysql": Dialect("mysql", "MySQL / MariaDB", "MySQL, MariaDB, Amazon RDS", "pymysql", "pip install pymysql", 3306),
    "sqlite": Dialect("sqlite", "SQLite", "Fichier de base SQLite (.db, .sqlite)", None, None, None),
}


def sqlite_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_file():
        raise ConnectorError(f"Fichier SQLite introuvable : {path}")
    return path


@contextmanager
def connect(
    cfg: ConnectionFields, password: str | None, login_timeout: float, query_timeout: float
) -> Iterator[DbConnection]:
    """Ouvre une connexion en lecture seule et la ferme à la sortie.

    Lève `ConnectorError` (502) si la source est injoignable, (501) si le pilote manque.
    """
    dialect = DIALECTS[cfg.kind]
    if not dialect.driver_installed():
        raise ConnectorError(
            f"Pilote {dialect.label} absent : dans le dossier backend, lancez « {dialect.install_hint} ».", 501
        )
    try:
        conn = _open(cfg, password, login_timeout, query_timeout)
    except ConnectorError:
        raise
    except Exception as exc:  # noqa: BLE001 — chaque pilote a ses propres exceptions
        raise ConnectorError(f"Connexion impossible à {dialect.label} : {short(exc)}", 502) from exc
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _open(cfg: ConnectionFields, password: str | None, login_timeout: float, query_timeout: float) -> DbConnection:
    host = (cfg.host or "").strip()
    if cfg.kind == "sqlserver":
        import pymssql

        kwargs: dict[str, Any] = {
            "server": host,
            "user": cfg.username or None,
            "password": password,
            "database": cfg.database or "",
            "login_timeout": int(login_timeout),
            "timeout": int(query_timeout),
            "appname": "Atelier Viz",
            "read_only": True,  # ApplicationIntent=ReadOnly (routage vers un réplica de lecture si disponible)
        }
        if cfg.port and "\\" not in host:  # instance nommée (srv\PROD) : port résolu par SQL Browser
            kwargs["port"] = str(cfg.port)
        if cfg.encrypt:
            kwargs["encryption"] = "require"
        conn: DbConnection = pymssql.connect(**kwargs)
        return conn
    if cfg.kind == "postgres":
        import psycopg

        pg = psycopg.connect(
            host=host,
            port=cfg.port or 5432,
            dbname=cfg.database or None,
            user=cfg.username or None,
            password=password,
            connect_timeout=int(login_timeout),
            application_name="Atelier Viz",
            # Lecture seule et délai maximal imposés par le serveur à toute la session.
            options=f"-c default_transaction_read_only=on -c statement_timeout={int(query_timeout * 1000)}",
        )
        return pg
    if cfg.kind == "mysql":
        import pymysql

        my = pymysql.connect(
            host=host,
            port=cfg.port or 3306,
            user=cfg.username or None,
            password=password or "",
            database=cfg.database or None,
            connect_timeout=int(login_timeout),
            read_timeout=int(query_timeout),
            charset="utf8mb4",
        )
        with my.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
        return my
    path = sqlite_path(cfg.path or "")
    return sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True, timeout=login_timeout, check_same_thread=False)


def run(conn: DbConnection, sql: str, limit: int, params: list[Any] | None = None) -> tuple[pd.DataFrame, bool]:
    """Exécute une lecture et rapporte au plus `limit` lignes (+ indicateur « il y en avait plus »)."""
    cur = conn.cursor()
    try:
        cur.execute(sql, params) if params else cur.execute(sql)
        if cur.description is None:
            raise ConnectorError("La requête ne renvoie pas de lignes.")
        columns = [d[0] for d in cur.description]
        rows: list[Any] = []
        while len(rows) <= limit:
            chunk = cur.fetchmany(min(FETCH_CHUNK, limit + 1 - len(rows)))
            if not chunk:
                break
            rows.extend(chunk)
    except ConnectorError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ConnectorError(f"Erreur de la base : {short(exc)}") from exc
    finally:
        try:
            cur.close()
        except Exception:  # noqa: BLE001
            pass
    truncated = len(rows) > limit
    return rows_to_frame(columns, rows[:limit]), truncated


def list_tables(conn: DbConnection, cfg: ConnectionFields) -> tuple[list[TableRef], bool]:
    dialect = DIALECTS[cfg.kind]
    sql, params = dialect.tables_sql(cfg.database)
    df, truncated = run(conn, sql, MAX_TABLES, params)
    tables = []
    for schema, name, kind in df.itertuples(index=False):
        is_view = "view" in str(kind).lower()
        tables.append(
            TableRef(
                schema=None if schema is None or pd.isna(schema) else str(schema),
                name=str(name),
                kind="view" if is_view else "table",
            )
        )
    return tables, truncated


def version(conn: DbConnection, cfg: ConnectionFields) -> str:
    df, _ = run(conn, DIALECTS[cfg.kind].version_sql(), 1)
    text = str(df.iat[0, 0]) if len(df) else ""
    return " ".join(text.split())[:160]
