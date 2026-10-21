"""Calculs rapides sur une mesure (« Afficher la valeur comme », comme les mesures rapides de Power BI).

Pour une mesure `m` et un champ date `d` :

| Calcul       | Sens                                                                 |
|--------------|----------------------------------------------------------------------|
| `ytd`        | cumul depuis le 1er janvier jusqu'à la fin de la période             |
| `running`    | cumul depuis le début des données                                    |
| `prev_year`  | même période l'an dernier (N-1)                                      |
| `yoy_diff`   | `m - N-1` ; `yoy_pct` : `(m - N-1) / |N-1|` en points de %          |
| `moving_avg` | moyenne des `window` dernières périodes                              |
| `pct_total`  | part du total général filtré, en points de %                         |

Deux contextes, comme dans Power BI :
- **avec un axe de dates** (une dimension sur `d`, avec ou sans période) : une valeur par période ;
  les filtres sur `d` limitent les périodes affichées mais pas l'accumulation (le cumul de juin
  inclut janvier même si le filtre commence en avril) ;
- **sans axe de dates** (carte KPI, table par région) : la période de référence se termine à la
  dernière date retenue par les filtres de date (`d*`).

Le SQL est une requête « base » (la requête habituelle, mesures renommées `__mN`) jointe à une
sous-requête par calcul, sur les mêmes dimensions (sous-totaux des matrices compris). Les expressions
de dimensions, de mesures et de filtres viennent du `_Builder` validé : aucun texte du client.
"""

from typing import TYPE_CHECKING, Any

from app.schemas.query import DateBin, Dimension, Filter, Measure, QueryRequest
from app.services.engine.database import LocalDatabase, quote_ident

if TYPE_CHECKING:
    from app.services.engine.query import _Builder

# Pas d'une période, pour « fin de période » et pour la fenêtre de la moyenne mobile.
STEP: dict[DateBin, tuple[int, str]] = {
    "year": (1, "YEAR"),
    "quarter": (3, "MONTH"),
    "month": (1, "MONTH"),
    "week": (7, "DAY"),
    "day": (1, "DAY"),
}
PER_YEAR: dict[DateBin, int] = {"year": 1, "quarter": 4, "month": 12, "week": 53, "day": 366}
# Garde-fou : lignes produites par l'expansion des cumuls (lignes × périodes concernées).
MAX_EXPANDED_ROWS = 30_000_000


def _q(name: str) -> str:
    return quote_ident(name)


class _Parts:
    """Texte SQL et paramètres assemblés dans le même ordre (aucun paramètre déplacé)."""

    def __init__(self) -> None:
        self.text: list[str] = []
        self.params: list[Any] = []

    def add(self, text: str, params: list[Any] | None = None) -> "_Parts":
        self.text.append(text)
        self.params.extend(params or [])
        return self

    def extend(self, other: "_Parts") -> "_Parts":
        self.text.extend(other.text)
        self.params.extend(other.params)
        return self

    def sql(self) -> str:
        return "".join(self.text)


def _where(*conds: tuple[str, list[Any]]) -> _Parts:
    """« WHERE a AND b » en gardant l'ordre des paramètres ; rien si aucune condition."""
    parts = _Parts()
    kept = [(t, p) for t, p in conds if t]
    for i, (text, params) in enumerate(kept):
        parts.add((" WHERE " if i == 0 else " AND ") + text, params)
    return parts


def compose(
    db: LocalDatabase,
    b: "_Builder",
    req: QueryRequest,
    dim_exprs: list[str],
    prefix: str,
    where: list[str],
    group_by: str,
    base_params: list[Any],
    tail: str,
) -> tuple[str, list[Any]]:
    """Requête complète : CTE `base` + une CTE par calcul, jointes sur les dimensions."""
    dims = list(zip([d.key for d in req.dimensions], dim_exprs, req.dimensions, strict=True))
    base_keys: list[str] = []
    base_exprs: list[str] = []
    for m in req.measures:
        if m.base_key not in base_keys:
            base_keys.append(m.base_key)
            base_exprs.append(b.measure(m))
    alias = {k: f"__m{i}" for i, k in enumerate(base_keys)}

    select = [f"{e} AS {_q(k)}" for k, e, _ in dims] + [
        f"{e} AS {_q(alias[k])}" for k, e in zip(base_keys, base_exprs, strict=True)
    ]
    out = _Parts().add(f"WITH base AS (SELECT {prefix}{', '.join(select)} FROM {b.table}")
    out.add(" WHERE " + " AND ".join(where) if where else "", base_params)
    out.add(group_by + ")")

    grouping = req.grouping_sets is not None and bool(dims)
    final: list[str] = ['base."__grouping"'] if grouping else []
    final += [f"base.{_q(k)}" for k, _, _ in dims]
    joins: list[str] = []
    for j, m in enumerate(req.measures):
        if m.show is None:
            final.append(f"base.{_q(alias[m.base_key])} AS {_q(m.key)}")
            continue
        name = f"c{j}"
        cte = _show_cte(db, b, req, dims, m, grouping)
        out.add(f", {name} AS (").extend(cte).add(")")
        mb = f"CAST(base.{_q(alias[m.base_key])} AS DOUBLE)"
        v = f"CAST({name}.v AS DOUBLE)"
        expr = {
            "yoy_diff": f"{mb} - {v}",
            "yoy_pct": f"({mb} - {v}) / NULLIF(ABS({v}), 0) * 100",
            "pct_total": f"{mb} / NULLIF({v}, 0) * 100",
        }.get(m.show.kind, v)
        final.append(f"{expr} AS {_q(m.key)}")
        if m.show.kind == "pct_total" or not dims:
            joins.append(f" LEFT JOIN {name} ON TRUE")
        else:
            on = [f"base.{_q(k)} IS NOT DISTINCT FROM {name}.{_q(k)}" for k, _, _ in dims]
            if grouping:
                on.append(f'base."__grouping" = {name}."__grouping"')
            joins.append(f" LEFT JOIN {name} ON " + " AND ".join(on))
    out.add(f" SELECT {', '.join(final)} FROM base" + "".join(joins) + tail)
    return out.sql(), out.params


def _show_cte(
    db: LocalDatabase,
    b: "_Builder",
    req: QueryRequest,
    dims: list[tuple[str, str, Dimension]],
    m: Measure,
    grouping: bool,
) -> _Parts:
    """Valeurs du calcul : une ligne par combinaison de dimensions (et par ensemble de regroupement)."""
    assert m.show is not None
    agg = b.measure(m)
    if m.show.kind == "pct_total":
        text, params = b.fragment(req.filters)
        return _Parts().add(f"SELECT {agg} AS v FROM {b.table}").extend(_where((text, params)))
    if not grouping:
        return _per_set(db, b, req, dims, [k for k, _, _ in dims], m, agg, None)
    parts = _Parts()
    n = len(dims)
    for i, keys in enumerate(req.grouping_sets or []):
        # Masque identique à GROUPING(d1, …, dn) : bit à 1 pour une dimension agrégée (d1 = poids fort).
        mask = sum(1 << (n - 1 - idx) for idx, (k, _, _) in enumerate(dims) if k not in keys)
        if i:
            parts.add(" UNION ALL ")
        parts.add("(").extend(_per_set(db, b, req, dims, keys, m, agg, mask)).add(")")
    return parts


def _per_set(
    db: LocalDatabase,
    b: "_Builder",
    req: QueryRequest,
    dims: list[tuple[str, str, Dimension]],
    keys: list[str],
    m: Measure,
    agg: str,
    mask: int | None,
) -> _Parts:
    """Calcul pour un ensemble de dimensions `keys` (les autres valent NULL, comme un sous-total)."""
    assert m.show is not None and m.show.date is not None
    kind = m.show.kind
    dc = _q(m.show.date)
    src = b.table
    in_set = [(k, e, d) for k, e, d in dims if k in keys]
    date_dim = next(((k, e, d) for k, e, d in in_set if d.field == m.show.date), None)
    date_filters: list[Filter] = [f for f in req.filters if f.field == m.show.date]
    other_filters: list[Filter] = [f for f in req.filters if f.field != m.show.date]

    inner_select = ", ".join([f"{e} AS {_q(k)}" for k, e, _ in in_set] + [f"{agg} AS v"])
    inner_group = (" GROUP BY " + ", ".join(e for _, e, _ in in_set)) if in_set else ""
    # Dimensions dans l'ordre de la requête, NULL hors de l'ensemble, puis le masque de regroupement.
    outer_dims = [(_q(k) if k in keys else "NULL") + f" AS {_q(k)}" for k, _, _ in dims]
    if mask is not None:
        outer_dims.insert(0, f'{mask} AS "__grouping"')

    def wrap(inner: _Parts, value: str = "v") -> _Parts:
        cols = ", ".join([*outer_dims, f"{value} AS v"])
        return _Parts().add(f"SELECT {cols} FROM (").extend(inner).add(") AS i")

    def dstar() -> _Parts:
        """Dernière date retenue par les filtres de date (référence sans axe de dates)."""
        text, params = b.fragment(date_filters)
        return _Parts().add(f"(SELECT MAX({dc}) FROM {src}").extend(_where((text, params))).add(")")

    other = b.fragment(other_filters)

    if kind in {"ytd", "running"}:
        if date_dim is not None:
            bin_ = date_dim[2].bin
            ctx = f"date_trunc('{bin_}', {dc})" if bin_ else dc
            _guard(db, src, ctx, bin_, kind)
            upper = f"s.{dc} < ctx.b + INTERVAL {STEP[bin_][0]} {STEP[bin_][1]}" if bin_ else f"s.{dc} <= ctx.b"
            lower = f" AND s.{dc} >= date_trunc('year', ctx.b)" if kind == "ytd" else ""
            # Chaque ligne compte pour toutes les périodes qui la suivent (dans son année pour ytd).
            x = (
                f"(SELECT s.* REPLACE (ctx.b AS {dc}) FROM {src} AS s JOIN "
                f"(SELECT DISTINCT {ctx} AS b FROM {src} WHERE {dc} IS NOT NULL) AS ctx ON {upper}{lower}) AS x"
            )
            inner = _Parts().add(f"SELECT {inner_select} FROM {x}").extend(_where(other)).add(inner_group)
            return wrap(inner)
        bound = _Parts().add(f"{dc} <= ").extend(dstar())
        if kind == "ytd":
            bound.add(f" AND {dc} >= date_trunc('year', ").extend(dstar()).add(")")
        inner = (
            _Parts()
            .add(f"SELECT {inner_select} FROM {src}")
            .extend(_where(other, (bound.sql(), bound.params)))
            .add(inner_group)
        )
        return wrap(inner)

    if kind in {"prev_year", "yoy_diff", "yoy_pct"}:
        bound = f" AND {dc} + INTERVAL 1 YEAR <= (SELECT MAX({dc}) FROM {src})" if date_dim is None else ""
        # Les lignes de l'an dernier, décalées d'un an : elles tombent sur les périodes (ou filtres) de cette année.
        shifted = f"CAST({dc} + INTERVAL 1 YEAR AS TIMESTAMP)"
        x = f"(SELECT * REPLACE ({shifted} AS {dc}) FROM {src} WHERE {dc} IS NOT NULL{bound}) AS x"
        conds = other if date_dim is not None else b.fragment(req.filters)
        inner = _Parts().add(f"SELECT {inner_select} FROM {x}").extend(_where(conds)).add(inner_group)
        return wrap(inner)

    # Moyenne mobile.
    k = m.show.window
    if date_dim is not None:
        bin_ = date_dim[2].bin
        partition = [_q(key) for key, _, d in in_set if key != date_dim[0]]
        over = f"PARTITION BY {', '.join(partition)} " if partition else ""
        if bin_:
            n, unit = STEP[bin_]
            frame = f"RANGE BETWEEN INTERVAL {n * (k - 1)} {unit} PRECEDING AND CURRENT ROW"
        else:
            frame = f"ROWS BETWEEN {k - 1} PRECEDING AND CURRENT ROW"
        inner = _Parts().add(f"SELECT {inner_select} FROM {src}").extend(_where(other)).add(inner_group)
        return wrap(inner, f"AVG(v) OVER ({over}ORDER BY {_q(date_dim[0])} {frame})")
    # Sans axe de dates : moyenne des `window` derniers mois jusqu'à d*.
    bound = (
        _Parts()
        .add(f"{dc} <= ")
        .extend(dstar())
        .add(f" AND {dc} >= date_trunc('month', ")
        .extend(dstar())
        .add(f") - INTERVAL {k - 1} MONTH")
    )
    keys_sel = [f"{e} AS {_q(key)}" for key, e, _ in in_set]
    month = f"date_trunc('month', {dc}) AS __p"
    monthly = _Parts().add(f"SELECT {', '.join([*keys_sel, month, f'{agg} AS v'])} FROM {src}")
    monthly.extend(_where(other, (bound.sql(), bound.params))).add(" GROUP BY ALL")
    outer_group = (" GROUP BY " + ", ".join(_q(key) for key, _, _ in in_set)) if in_set else ""
    cols = ", ".join([*(_q(key) for key, _, _ in in_set), "AVG(v) AS v"])
    inner = _Parts().add(f"SELECT {cols} FROM (").extend(monthly).add(f") AS mo{outer_group}")
    return wrap(inner)


def _guard(db: LocalDatabase, src: str, ctx: str, bin_: DateBin | None, kind: str) -> None:
    """Refuse un cumul qui produirait trop de lignes intermédiaires (ex. cumul par jour sur des millions de lignes)."""
    from app.services.engine.query import QueryError

    _, rows = db.execute(f"SELECT COUNT(*), COUNT(DISTINCT {ctx}) FROM {src}")
    count, periods = int(rows[0][0] or 0), int(rows[0][1] or 0)
    spread = periods if kind == "running" or bin_ is None else min(periods, PER_YEAR[bin_])
    if count * max(1, spread) / 2 > MAX_EXPANDED_ROWS:
        raise QueryError(
            "Calcul trop volumineux pour ce regroupement : choisissez une période plus large (mois, trimestre)."
        )
