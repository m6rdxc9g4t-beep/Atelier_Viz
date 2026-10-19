"""Base DuckDB locale (un fichier) : persistance des jeux de données entre redémarrages."""

import threading
from pathlib import Path
from typing import Any

import duckdb
import pandas as pd


def quote_ident(name: str) -> str:
    """Identifiant SQL entre guillemets (les guillemets internes sont doublés)."""
    return '"' + name.replace('"', '""') + '"'


class LocalDatabase:
    """Connexion DuckDB unique protégée par un verrou.

    DuckDB est embarqué (aucun serveur) ; les appels sont synchrones et doivent être
    lancés via `asyncio.to_thread` depuis les routes.

    Args:
        path: fichier de base, ou ":memory:" pour les tests.
    """

    def __init__(self, path: str | Path = ":memory:") -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._con = duckdb.connect(str(path))
        self._lock = threading.Lock()

    def execute(self, sql: str, params: list[Any] | None = None) -> tuple[list[str], list[tuple[Any, ...]]]:
        """Exécute une requête et retourne (noms de colonnes, lignes)."""
        with self._lock:
            cursor = self._con.execute(sql, params or [])
            if cursor.description is None:
                return [], []
            names = [d[0] for d in cursor.description]
            return names, cursor.fetchall()

    def write_dataframe(self, table: str, df: pd.DataFrame) -> None:
        """Crée (ou remplace) une table à partir d'un DataFrame pandas."""
        with self._lock:
            self._con.register("__incoming", df)
            try:
                self._con.execute(f"CREATE OR REPLACE TABLE {quote_ident(table)} AS SELECT * FROM __incoming")
            finally:
                self._con.unregister("__incoming")

    def read_dataframe(self, sql: str, params: list[Any] | None = None) -> pd.DataFrame:
        with self._lock:
            return self._con.execute(sql, params or []).df()

    def close(self) -> None:
        with self._lock:
            self._con.close()
