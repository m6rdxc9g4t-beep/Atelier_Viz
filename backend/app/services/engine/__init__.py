"""Moteur de données local : DuckDB (stockage des jeux importés + requêtes d'agrégation)."""

from app.services.engine.database import LocalDatabase
from app.services.engine.query import QueryError, run_query

__all__ = ["LocalDatabase", "QueryError", "run_query"]
