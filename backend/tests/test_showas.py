"""Calculs rapides (« Afficher la valeur comme ») : cumuls, N-1, évolution, moyenne mobile, part du total.

Données synthétiques sur deux ans (2025 et 2026), deux régions ; chaque résultat est comparé à un
calcul indépendant fait avec pandas.
"""

import random

import pandas as pd
import pytest

from app.schemas.dataset import DatasetModel
from app.schemas.query import QueryRequest
from app.services.data import DatasetStore
from app.services.engine import LocalDatabase, QueryError, run_query, showas

random.seed(7)
ROWS = [
    {
        "date": pd.Timestamp(2025, 1, 1) + pd.Timedelta(days=random.randrange(0, 600)),
        "region": random.choice(["Nord", "Sud"]),
        "ca": float(random.randrange(10, 500)),
        "qte": random.randrange(1, 9),
    }
    for _ in range(400)
]
DF = pd.DataFrame(ROWS)
CA = {"field": "ca", "agg": "sum"}


def show(kind: str, **extra) -> dict:
    return {**CA, "show": {"kind": kind, "date": "date", **extra}}


@pytest.fixture
def ds():
    db = LocalDatabase()
    store = DatasetStore(db)
    dataset = store.add("ventes.csv", "csv", DF.copy())

    def q(**kwargs):
        res = run_query(db, dataset.source, dataset.profile(), QueryRequest(dataset_id=dataset.id, **kwargs))
        keys = [c.key for c in res.columns]
        return [dict(zip(keys, r, strict=True)) for r in res.rows]

    q.store, q.dataset, q.db = store, dataset, db  # type: ignore[attr-defined]
    yield q
    db.close()


def monthly(df: pd.DataFrame, by: list[str] | None = None) -> pd.DataFrame:
    out = (
        df.assign(m=df["date"].dt.to_period("M").dt.to_timestamp())
        .groupby([*(by or []), "m"])["ca"]
        .sum()
        .reset_index()
    )
    return out


def test_ytd_and_running_by_month(ds) -> None:
    rows = ds(dimensions=[{"field": "date", "bin": "month"}], measures=[CA, show("ytd"), show("running")])
    ref = monthly(DF)
    ref["ytd"] = ref.groupby(ref["m"].dt.year)["ca"].cumsum()
    ref["run"] = ref["ca"].cumsum()
    assert len(rows) == len(ref)
    for r, (_, e) in zip(rows, ref.iterrows(), strict=True):
        assert r["date|month"] == e["m"].date().isoformat()
        assert r["sum(ca)@ytd"] == pytest.approx(e["ytd"])
        assert r["sum(ca)@running"] == pytest.approx(e["run"])
    # Le cumul annuel repart à zéro en janvier 2026.
    jan26 = next(r for r in rows if r["date|month"] == "2026-01-01")
    assert jan26["sum(ca)@ytd"] == pytest.approx(jan26["sum(ca)"])


def test_ytd_per_region_ignores_the_start_of_a_date_filter(ds) -> None:
    flt = [{"field": "date", "op": "between", "values": ["2026-04-01", "2026-06-30"]}]
    rows = ds(
        dimensions=[{"field": "region"}, {"field": "date", "bin": "month"}],
        measures=[CA, show("ytd")],
        filters=flt,
    )
    ref = monthly(DF, ["region"])
    ref["ytd"] = ref.groupby(["region", ref["m"].dt.year])["ca"].cumsum()
    shown = ref[(ref["m"] >= "2026-04-01") & (ref["m"] <= "2026-06-30")]
    assert len(rows) == len(shown) == 6  # avril à juin, deux régions : seules ces périodes s'affichent
    for r in rows:
        e = shown[(shown["region"] == r["region"]) & (shown["m"].dt.date.astype(str) == r["date|month"])].iloc[0]
        assert r["sum(ca)"] == pytest.approx(e["ca"])
        assert r["sum(ca)@ytd"] == pytest.approx(e["ytd"])  # inclut janvier à mars


def test_previous_year_and_variation_by_month(ds) -> None:
    rows = ds(
        dimensions=[{"field": "date", "bin": "month"}],
        measures=[CA, show("prev_year"), show("yoy_diff"), show("yoy_pct")],
    )
    ref = monthly(DF).set_index("m")["ca"]
    for r in rows:
        month = pd.Timestamp(r["date|month"])
        prev = ref.get(month - pd.DateOffset(years=1))
        if prev is None:
            assert r["sum(ca)@prev_year"] is None and r["sum(ca)@yoy_pct"] is None
            continue
        assert r["sum(ca)@prev_year"] == pytest.approx(prev)
        assert r["sum(ca)@yoy_diff"] == pytest.approx(r["sum(ca)"] - prev)
        assert r["sum(ca)@yoy_pct"] == pytest.approx((r["sum(ca)"] - prev) / abs(prev) * 100)
    assert any(r["sum(ca)@prev_year"] is not None for r in rows)


def test_without_date_axis_reference_is_the_last_filtered_date(ds) -> None:
    flt = [{"field": "date", "op": "between", "values": ["2026-01-01", "2026-03-31"]}]
    rows = ds(
        dimensions=[{"field": "region"}], measures=[CA, show("ytd"), show("prev_year"), show("running")], filters=flt
    )
    q1_26 = DF[(DF.date >= "2026-01-01") & (DF.date <= "2026-03-31")]
    q1_25 = DF[(DF.date >= "2025-01-01") & (DF.date <= "2025-03-31")]
    dstar = q1_26["date"].max()
    for r in rows:
        reg = DF[DF.region == r["region"]]
        assert r["sum(ca)"] == pytest.approx(q1_26[q1_26.region == r["region"]]["ca"].sum())
        assert r["sum(ca)@ytd"] == pytest.approx(reg[(reg.date >= "2026-01-01") & (reg.date <= dstar)]["ca"].sum())
        assert r["sum(ca)@running"] == pytest.approx(reg[reg.date <= dstar]["ca"].sum())
        assert r["sum(ca)@prev_year"] == pytest.approx(q1_25[q1_25.region == r["region"]]["ca"].sum())

    # Carte KPI sans aucun filtre : N-1 = les dates décalées d'un an qui restent dans les données.
    kpi = ds(measures=[CA, show("prev_year")])[0]
    assert kpi["sum(ca)@prev_year"] == pytest.approx(DF[DF.date + pd.DateOffset(years=1) <= DF.date.max()]["ca"].sum())


def test_moving_average(ds) -> None:
    rows = ds(dimensions=[{"field": "date", "bin": "month"}], measures=[CA, show("moving_avg", window=3)])
    ref = monthly(DF).set_index("m")["ca"]
    for r in rows:
        month = pd.Timestamp(r["date|month"])
        window = [ref[p] for p in ref.index if month - pd.DateOffset(months=2) <= p <= month]
        assert r["sum(ca)@moving_avg3"] == pytest.approx(sum(window) / len(window))
    # Sans axe de dates : moyenne des 3 derniers mois jusqu'à la dernière date.
    kpi = ds(measures=[show("moving_avg", window=3)])[0]
    last = ref.index.max()
    expected = ref[[p for p in ref.index if last - pd.DateOffset(months=2) <= p <= last]].mean()
    assert kpi["sum(ca)@moving_avg3"] == pytest.approx(expected)


def test_share_of_total_respects_filters(ds) -> None:
    flt = [{"field": "region", "op": "in", "values": ["Nord"]}]
    rows = ds(
        dimensions=[{"field": "date", "bin": "year"}], measures=[{**CA, "show": {"kind": "pct_total"}}], filters=flt
    )
    nord = DF[DF.region == "Nord"]
    for r in rows:
        year = int(r["date|year"][:4])
        assert r["sum(ca)@pct_total"] == pytest.approx(
            nord[nord.date.dt.year == year]["ca"].sum() / nord["ca"].sum() * 100
        )
    assert sum(r["sum(ca)@pct_total"] for r in rows) == pytest.approx(100)


def test_matrix_subtotals(ds) -> None:
    rows = ds(
        dimensions=[{"field": "region"}, {"field": "date", "bin": "year"}],
        measures=[CA, show("prev_year")],
        grouping_sets=[["region", "date|year"], ["region"], []],
    )
    by_year = DF.assign(y=DF.date.dt.year)
    leaf = next(r for r in rows if r["__grouping"] == 0 and r["region"] == "Nord" and r["date|year"] == "2026-01-01")
    assert leaf["sum(ca)@prev_year"] == pytest.approx(
        by_year[(by_year.region == "Nord") & (by_year.y == 2025)]["ca"].sum()
    )
    # Sous-total par région (sans axe de dates) et total général : N-1 jusqu'à la dernière date.
    shifted = DF[DF.date + pd.DateOffset(years=1) <= DF.date.max()]
    sub = next(r for r in rows if r["__grouping"] == 1 and r["region"] == "Nord")
    assert sub["sum(ca)@prev_year"] == pytest.approx(shifted[shifted.region == "Nord"]["ca"].sum())
    total = next(r for r in rows if r["__grouping"] == 3)
    assert total["sum(ca)@prev_year"] == pytest.approx(shifted["ca"].sum())


def test_works_on_calculated_measures_and_columns(ds) -> None:
    ds.store.set_model(
        ds.dataset,
        DatasetModel.model_validate(
            {
                "columns": [{"name": "ca_ttc", "expression": "ca * 1.2"}],
                "measures": [{"name": "Panier", "expression": "SUM(ca) / SUM(qte)"}],
            }
        ),
    )
    ds.dataset = ds.store.get(ds.dataset.id)
    db, dataset = ds.db, ds.dataset

    def q(**kwargs):
        res = run_query(db, dataset.source, dataset.profile(), QueryRequest(dataset_id=dataset.id, **kwargs))
        return [dict(zip([c.key for c in res.columns], r, strict=True)) for r in res.rows]

    rows = q(
        dimensions=[{"field": "date", "bin": "month"}],
        measures=[
            {"field": "Panier", "agg": "calc", "show": {"kind": "ytd", "date": "date"}},
            {"field": "ca_ttc", "agg": "sum", "show": {"kind": "ytd", "date": "date"}},
        ],
    )
    m = DF.assign(mm=DF.date.dt.to_period("M").dt.to_timestamp())
    for r in rows:
        month = pd.Timestamp(r["date|month"])
        part = m[(m.mm <= month) & (m.date.dt.year == month.year)]
        assert r["calc(Panier)@ytd"] == pytest.approx(part["ca"].sum() / part["qte"].sum())
        assert r["sum(ca_ttc)@ytd"] == pytest.approx(part["ca"].sum() * 1.2)


def test_errors(ds) -> None:
    with pytest.raises(QueryError, match="n'est pas un champ date"):
        ds(measures=[{**CA, "show": {"kind": "ytd", "date": "region"}}])
    with pytest.raises(ValueError, match="champ date"):
        QueryRequest(dataset_id="x", measures=[{**CA, "show": {"kind": "ytd"}}])
    with pytest.raises(QueryError, match="qu'une fois"):
        ds(measures=[show("ytd"), show("ytd")])


def test_guard_against_huge_expansions(ds, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(showas, "MAX_EXPANDED_ROWS", 100)
    with pytest.raises(QueryError, match="trop volumineux"):
        ds(dimensions=[{"field": "date", "bin": "day"}], measures=[show("running")])


def test_route_accepts_show_and_returns_keys(client) -> None:
    ds_id = next(d for d in client.post("/api/samples").json()["datasets"] if d["name"] == "ventes_2026.csv")["id"]
    body = {
        "dataset_id": ds_id,
        "dimensions": [{"field": "date", "bin": "quarter"}],
        "measures": [{"field": "chiffre_affaires", "agg": "sum", "show": {"kind": "ytd", "date": "date"}}],
    }
    res = client.post("/api/query", json=body)
    assert res.status_code == 200, res.text
    assert [c["key"] for c in res.json()["columns"]] == ["date|quarter", "sum(chiffre_affaires)@ytd"]
    values = [r[1] for r in res.json()["rows"]]
    assert values == sorted(values)  # cumul croissant (une seule année d'exemple)
