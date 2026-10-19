"""Modèle d'un jeu de données : colonnes calculées (vue DuckDB) et mesures calculées (agrégats).

- Les colonnes calculées sont matérialisées dans une vue `v_<id>` = table + colonnes calculées :
  filtres, regroupements et agrégations les traitent comme des colonnes ordinaires.
- Les mesures calculées sont compilées à chaque requête (`agg = "calc"`), sur les colonnes de la vue.
- Une colonne calculée peut utiliser les colonnes de base et celles définies AVANT elle ;
  une mesure peut utiliser toutes les colonnes et les autres mesures (sans cycle).
"""

from dataclasses import dataclass

from app.schemas.dataset import (
    ColumnProfile,
    ColumnType,
    DatasetModel,
    DatasetProfile,
    ExpressionCheck,
    ExpressionResult,
    ModelIssue,
    ValueCount,
)
from app.services.data.profiling import TOP_VALUES, to_json
from app.services.engine.database import LocalDatabase, quote_ident
from app.services.engine.expressions import ExpressionError, Scope, column_scope, compile_expression

COLUMN_TYPES: set[str] = {"number", "string", "boolean", "date"}


class ModelError(ValueError):
    """Modèle invalide : une entrée par colonne ou mesure fautive."""

    def __init__(self, issues: list[ModelIssue]) -> None:
        super().__init__("; ".join(f"{i.name} : {i.error}" for i in issues))
        self.issues = issues


@dataclass(frozen=True)
class CompiledColumn:
    name: str
    sql: str
    """SQL sur la table de base (colonnes calculées précédentes développées)."""
    type: ColumnType


@dataclass
class CompiledModel:
    columns: list[CompiledColumn]
    issues: list[ModelIssue]


def base_types(profile: DatasetProfile) -> dict[str, ColumnType]:
    return {c.name: c.type for c in profile.columns if not c.calculated}


def view_scope(profile: DatasetProfile) -> Scope:
    """Portée d'une mesure : toutes les colonnes de la vue (base + calculées) et les mesures."""
    return Scope(
        columns=column_scope({c.name: c.type for c in profile.columns}),
        measures={m.name: m.expression for m in profile.model.measures},
    )


def compile_model(base: dict[str, ColumnType], model: DatasetModel) -> CompiledModel:
    """Compile tout le modèle et liste les erreurs (noms en double, expressions invalides)."""
    issues: list[ModelIssue] = []
    taken = {name.lower() for name in base}
    scope_columns = column_scope(base)
    all_types: dict[str, ColumnType] = dict(base)
    compiled: list[CompiledColumn] = []

    for col in model.columns:
        if col.name.lower() in taken:
            issues.append(
                ModelIssue(kind="column", name=col.name, error="Ce nom est déjà utilisé par une autre colonne.")
            )
            continue
        taken.add(col.name.lower())
        try:
            c = compile_expression(col.expression, "column", Scope(columns=dict(scope_columns)))
        except ExpressionError as exc:
            issues.append(ModelIssue(kind="column", name=col.name, error=exc.message, position=exc.position))
            continue
        kind: ColumnType = c.type if c.type in COLUMN_TYPES else "number"  # type: ignore[assignment]
        compiled.append(CompiledColumn(col.name, c.sql, kind))
        scope_columns[col.name] = (f"({c.sql})", kind)
        all_types[col.name] = kind

    measures = {m.name: m.expression for m in model.measures}
    scope = Scope(columns=column_scope(all_types), measures=measures)
    for m in model.measures:
        if m.name.lower() in taken:
            issues.append(
                ModelIssue(kind="measure", name=m.name, error="Ce nom est déjà utilisé par une colonne ou une mesure.")
            )
            continue
        taken.add(m.name.lower())
        try:
            compile_expression(m.expression, "measure", scope, name=m.name)
        except ExpressionError as exc:
            issues.append(ModelIssue(kind="measure", name=m.name, error=exc.message, position=exc.position))
    return CompiledModel(compiled, issues)


def measure_sql(profile: DatasetProfile, name: str) -> str:
    """SQL d'une mesure calculée, sur la vue du jeu de données."""
    expression = next((m.expression for m in profile.model.measures if m.name == name), None)
    if expression is None:
        raise ExpressionError(f"Mesure calculée inconnue : « {name} ».")
    return compile_expression(expression, "measure", view_scope(profile), name=name).sql


def view_ddl(dataset_id: str, columns: list[CompiledColumn]) -> str:
    view, table = quote_ident(f"v_{dataset_id}"), quote_ident(f"ds_{dataset_id}")
    if not columns:
        return f"DROP VIEW IF EXISTS {view}"
    extra = ", ".join(f"{c.sql} AS {quote_ident(c.name)}" for c in columns)
    return f"CREATE OR REPLACE VIEW {view} AS SELECT *, {extra} FROM {table}"


def profile_calculated(db: LocalDatabase, source: str, col: CompiledColumn, expression: str) -> ColumnProfile:
    """Statistiques d'une colonne calculée, calculées par DuckDB sur la vue."""
    c = quote_ident(col.name)
    src = quote_ident(source)
    _, rows = db.execute(f"SELECT COUNT(*) - COUNT({c}), COUNT(DISTINCT {c}), MIN({c}), MAX({c}) FROM {src}")
    nulls, distinct, low, high = rows[0]
    profile = ColumnProfile(
        name=col.name, type=col.type, nulls=int(nulls), distinct=int(distinct), calculated=True, expression=expression
    )
    if col.type in {"number", "date"}:
        profile.min, profile.max = to_json(low), to_json(high)
    if col.type == "number":
        _, avg = db.execute(f"SELECT AVG({c}) FROM {src}")
        profile.mean = None if avg[0][0] is None else round(float(avg[0][0]), 4)
    else:
        _, top = db.execute(
            f"SELECT CAST({c} AS VARCHAR) AS v, COUNT(*) AS n FROM {src} WHERE {c} IS NOT NULL "
            f"GROUP BY 1 ORDER BY n DESC, v LIMIT {TOP_VALUES}"
        )
        profile.top_values = [ValueCount(value=str(v), count=int(n)) for v, n in top]
    return profile


def check_expression(
    db: LocalDatabase, profile: DatasetProfile, source: str, check: ExpressionCheck
) -> ExpressionResult:
    """Valide une expression de l'éditeur et calcule un aperçu (5 valeurs ou le total)."""
    model = profile.model.model_copy(deep=True)
    name = check.name.strip() or "__apercu"
    if check.kind == "column":
        items = [c for c in model.columns if c.name != check.name]
        index = next((i for i, c in enumerate(model.columns) if c.name == check.name), len(items))
        prior = items[:index]
        base = base_types(profile)
        try:
            scope_model = DatasetModel(columns=prior)
            compiled = compile_model(base, scope_model)
            scope_cols = column_scope(base)
            for c in compiled.columns:
                scope_cols[c.name] = (f"({c.sql})", c.type)
            result = compile_expression(check.expression, "column", Scope(columns=scope_cols))
        except ExpressionError as exc:
            return ExpressionResult(ok=False, error=exc.message, position=exc.position)
        if name.lower() in {n.lower() for n in base} | {c.name.lower() for c in items}:
            return ExpressionResult(ok=False, error="Ce nom est déjà utilisé par une autre colonne.")
        table = quote_ident(f"ds_{profile.id}")
        _, rows = db.execute(f"SELECT {result.sql} FROM {table} LIMIT 5")
        return ExpressionResult(ok=True, type=result.type, preview=[to_json(r[0]) for r in rows])  # type: ignore[arg-type]

    others = {m.name: m.expression for m in model.measures if m.name != check.name}
    scope = Scope(columns=column_scope({c.name: c.type for c in profile.columns}), measures=others)
    if name.lower() in {c.name.lower() for c in profile.columns} | {n.lower() for n in others}:
        return ExpressionResult(ok=False, error="Ce nom est déjà utilisé par une colonne ou une mesure.")
    try:
        result = compile_expression(check.expression, "measure", scope, name=name)
    except ExpressionError as exc:
        return ExpressionResult(ok=False, error=exc.message, position=exc.position)
    _, rows = db.execute(f"SELECT {result.sql} FROM {quote_ident(source)}")
    return ExpressionResult(ok=True, type="number", preview=[to_json(rows[0][0])])
