"""Traduction d'une `QueryRequest` en SQL DuckDB paramétré."""

from typing import Any

import duckdb

from app.schemas.dataset import ColumnType, DatasetProfile, Scalar
from app.schemas.query import Agg, DateBin, Dimension, Filter, Measure, QueryColumn, QueryRequest, QueryResponse
from app.services.data.profiling import to_json
from app.services.engine.database import LocalDatabase, quote_ident
from app.services.engine.expressions import ExpressionError

NUMERIC_AGGS: set[Agg] = {"sum", "avg", "median"}
AGG_SQL: dict[Agg, str] = {
    "sum": "SUM({c})",
    "avg": "AVG({c})",
    "median": "MEDIAN({c})",
    "min": "MIN({c})",
    "max": "MAX({c})",
    "count": "COUNT({c})",
    "count_distinct": "COUNT(DISTINCT {c})",
}


class QueryError(ValueError):
    """Requête invalide pour ce jeu de données (renvoyée en HTTP 422)."""


class _Builder:
    def __init__(self, profile: DatasetProfile, table: str) -> None:
        self.profile = profile
        self.types: dict[str, ColumnType] = {c.name: c.type for c in profile.columns}
        self.table = quote_ident(table)
        self.params: list[Any] = []

    def column(self, field: str) -> str:
        if field not in self.types:
            raise QueryError(f"Champ inconnu : « {field} ».")
        return quote_ident(field)

    def binned(self, field: str, bin_: DateBin | None) -> str:
        col = self.column(field)
        if bin_ is None:
            return col
        if self.types[field] != "date":
            raise QueryError(f"Le regroupement par période ne s'applique qu'aux dates (« {field} »).")
        return f"CAST(date_trunc('{bin_}', {col}) AS DATE)"

    def dimension(self, dim: Dimension) -> str:
        return self.binned(dim.field, dim.bin)

    def measure(self, m: Measure) -> str:
        if m.agg == "calc":
            if not m.field:
                raise QueryError("Une mesure calculée doit être nommée.")
            from app.services.data.model import measure_sql  # import local : évite un cycle entre paquets

            try:
                return measure_sql(self.profile, m.field)
            except ExpressionError as exc:
                raise QueryError(exc.message) from exc
        if m.field is None:
            if m.agg not in {"count"}:
                raise QueryError("Seul « count » peut s'appliquer sans champ.")
            return "COUNT(*)"
        col = self.column(m.field)
        kind = self.types[m.field]
        if m.agg in NUMERIC_AGGS and kind not in {"number", "boolean"}:
            raise QueryError(f"« {m.agg} » demande un champ numérique (« {m.field} » est de type {kind}).")
        if kind == "boolean" and m.agg in NUMERIC_AGGS:
            col = f"CAST({col} AS INTEGER)"
        return AGG_SQL[m.agg].format(c=col)

    def param(self, value: Scalar, field: str) -> str:
        self.params.append(value)
        return "CAST(? AS TIMESTAMP)" if self.types[field] == "date" and value is not None else "?"

    def condition(self, f: Filter) -> str:
        expr = self.binned(f.field, f.bin)
        values = f.values
        if f.op in {"in", "not_in"}:
            present = [v for v in values if v is not None]
            parts = []
            if present:
                parts.append(f"{expr} IN ({', '.join(self.param(v, f.field) for v in present)})")
            if len(present) < len(values):
                parts.append(f"{expr} IS NULL")
            if not parts:
                return "TRUE"  # liste vide (segment sans sélection) = aucun filtre
            clause = "(" + " OR ".join(parts) + ")"
            return clause if f.op == "in" else f"NOT {clause}"
        if f.op == "is_null":
            return f"{expr} IS NULL"
        if f.op == "not_null":
            return f"{expr} IS NOT NULL"
        if f.op == "between":
            low, high = values
            parts = []
            if low is not None:
                parts.append(f"{expr} >= {self.param(low, f.field)}")
            if high is not None:
                parts.append(f"{expr} <= {self.param(high, f.field)}")
            return " AND ".join(parts) or "TRUE"
        if f.op == "contains":
            escaped = str(values[0]).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            self.params.append(f"%{escaped}%")
            return f"CAST({expr} AS VARCHAR) ILIKE ? ESCAPE '\\'"
        operator = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[f.op]
        return f"{expr} {operator} {self.param(values[0], f.field)}"


def _measure_type(m: Measure, types: dict[str, ColumnType]) -> ColumnType:
    if m.agg in {"min", "max"} and m.field in types:
        return types[m.field]
    return "number"


def run_query(db: LocalDatabase, table: str, profile: DatasetProfile, req: QueryRequest) -> QueryResponse:
    """Construit et exécute la requête ; retourne un résultat JSON-sérialisable."""
    b = _Builder(profile, table)
    dim_exprs = [b.dimension(d) for d in req.dimensions]
    meas_exprs = [b.measure(m) for m in req.measures]
    dim_keys = [d.key for d in req.dimensions]
    meas_keys = [m.key for m in req.measures]
    if len(set(dim_keys + meas_keys)) != len(dim_keys) + len(meas_keys):
        raise QueryError("Chaque dimension et chaque mesure ne peut apparaître qu'une fois.")

    select = [f"{e} AS {quote_ident(k)}" for e, k in zip(dim_exprs, dim_keys, strict=True)]
    select += [f"{e} AS {quote_ident(k)}" for e, k in zip(meas_exprs, meas_keys, strict=True)]
    columns = [
        QueryColumn(key=d.key, field=d.field, role="dimension", type=b.types[d.field]) for d in req.dimensions
    ] + [QueryColumn(key=m.key, field=m.field, role="measure", type=_measure_type(m, b.types)) for m in req.measures]

    where = [b.condition(f) for f in req.filters]
    # Préfixe du SELECT calculé AVANT d'assembler le texte : aucun remplacement dans le SQL
    # (un texte saisi dans une mesure calculée pourrait contenir le motif remplacé).
    prefix = ""
    group_by = ""
    if dim_exprs and meas_exprs:
        if req.grouping_sets is not None:
            by_key = dict(zip(dim_keys, dim_exprs, strict=True))
            sets = []
            for group in req.grouping_sets:
                unknown = [k for k in group if k not in by_key]
                if unknown:
                    raise QueryError(f"grouping_sets : dimension(s) inconnue(s) {unknown}.")
                sets.append("(" + ", ".join(by_key[k] for k in group) + ")")
            group_by = f" GROUP BY GROUPING SETS ({', '.join(sets)})"
            prefix = f'GROUPING({", ".join(dim_exprs)}) AS "__grouping", '
            columns.insert(0, QueryColumn(key="__grouping", field=None, role="grouping", type="number"))
        else:
            group_by = " GROUP BY " + ", ".join(dim_exprs)
    elif dim_exprs:
        prefix = "DISTINCT "
    sql = f"SELECT {prefix}{', '.join(select)} FROM {b.table}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += group_by

    valid_keys = {c.key for c in columns}
    order = []
    for s in req.sort:
        if s.key not in valid_keys:
            raise QueryError(f"Tri sur une clé absente de la requête : « {s.key} ».")
        order.append(f"{quote_ident(s.key)} {'DESC' if s.desc else 'ASC'} NULLS LAST")
    if not order and dim_keys:
        order = [f"{quote_ident(k)} ASC NULLS LAST" for k in dim_keys]
    if order:
        sql += " ORDER BY " + ", ".join(order)
    sql += f" LIMIT {req.limit + 1}"

    try:
        _, rows = db.execute(sql, b.params)
    except duckdb.Error as exc:
        raise QueryError(f"Le moteur n'a pas pu exécuter la requête : {exc}") from exc
    truncated = len(rows) > req.limit
    return QueryResponse(
        columns=columns,
        rows=[[to_json(v) for v in row] for row in rows[: req.limit]],
        truncated=truncated,
    )
