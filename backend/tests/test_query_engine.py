"""Moteur de requêtes DuckDB : agrégations, périodes, filtres, sous-totaux, sécurité."""

from pathlib import Path

import pandas as pd
import pytest

from app.schemas.query import QueryRequest
from app.services.data import DatasetStore, read_table
from app.services.engine import LocalDatabase, QueryError, run_query

CSV = (
    b"date;region;produit;ca;nouveau\n"
    b"05/01/2026;Nord;A;100;oui\n"
    b"20/01/2026;Nord;B;50;non\n"
    b"03/02/2026;Sud;A;200;oui\n"
    b"15/02/2026;Sud;B;;non\n"
    b"10/03/2026;Nord;A;70;non\n"
)


@pytest.fixture
def ds():
    db = LocalDatabase()
    store = DatasetStore(db)
    df, fmt = read_table("ventes.csv", CSV)
    dataset = store.add("ventes.csv", fmt, df)

    def q(**kwargs):
        return run_query(db, dataset.table, dataset.profile(), QueryRequest(dataset_id=dataset.id, **kwargs))

    yield q
    db.close()


def as_dicts(res):
    keys = [c.key for c in res.columns]
    return [dict(zip(keys, r, strict=True)) for r in res.rows]


def test_group_by_sum_and_count(ds) -> None:
    res = ds(dimensions=[{"field": "region"}], measures=[{"field": "ca", "agg": "sum"}, {"agg": "count"}])
    assert as_dicts(res) == [
        {"region": "Nord", "sum(ca)": 220.0, "count(*)": 3},
        {"region": "Sud", "sum(ca)": 200.0, "count(*)": 2},
    ]
    assert [c.role for c in res.columns] == ["dimension", "measure", "measure"]


def test_month_bin_is_chronological(ds) -> None:
    res = ds(dimensions=[{"field": "date", "bin": "month"}], measures=[{"field": "ca", "agg": "sum"}])
    assert as_dicts(res) == [
        {"date|month": "2026-01-01", "sum(ca)": 150.0},
        {"date|month": "2026-02-01", "sum(ca)": 200.0},
        {"date|month": "2026-03-01", "sum(ca)": 70.0},
    ]


def test_filters_in_between_contains_and_bin(ds) -> None:
    m = [{"field": "ca", "agg": "sum"}]
    assert ds(measures=m, filters=[{"field": "region", "values": ["Sud"]}]).rows == [[200.0]]
    assert ds(measures=m, filters=[{"field": "ca", "op": "between", "values": [60, 150]}]).rows == [[170.0]]
    assert ds(measures=m, filters=[{"field": "produit", "op": "contains", "values": ["b"]}]).rows == [[50.0]]
    assert ds(measures=m, filters=[{"field": "date", "bin": "month", "values": ["2026-02-01"]}]).rows == [[200.0]]
    assert ds(measures=m, filters=[{"field": "date", "op": "gte", "values": ["2026-02-01"]}]).rows == [[270.0]]
    assert ds(measures=[{"agg": "count"}], filters=[{"field": "ca", "op": "is_null"}]).rows == [[1]]
    # Liste vide (segment sans sélection) = pas de filtre
    assert ds(measures=m, filters=[{"field": "region", "values": []}]).rows == [[420.0]]


def test_boolean_avg_and_distinct_dimensions(ds) -> None:
    assert ds(measures=[{"field": "nouveau", "agg": "avg"}]).rows == [[0.4]]
    assert ds(dimensions=[{"field": "produit"}]).rows == [["A"], ["B"]]


def test_sort_and_limit_with_truncation(ds) -> None:
    res = ds(
        dimensions=[{"field": "produit"}],
        measures=[{"field": "ca", "agg": "sum"}],
        sort=[{"key": "sum(ca)", "desc": True}],
        limit=1,
    )
    assert res.rows == [["A", 370.0]] and res.truncated is True


def test_grouping_sets_give_subtotals(ds) -> None:
    res = ds(
        dimensions=[{"field": "region"}, {"field": "produit"}],
        measures=[{"field": "ca", "agg": "avg"}],
        grouping_sets=[["region", "produit"], ["region"], []],
    )
    rows = as_dicts(res)
    assert res.columns[0].key == "__grouping"
    grand_total = next(r for r in rows if r["__grouping"] == 3)
    nord_total = next(r for r in rows if r["__grouping"] == 1 and r["region"] == "Nord")
    assert grand_total["avg(ca)"] == pytest.approx(105.0)  # vraie moyenne, pas une moyenne de moyennes
    assert nord_total["avg(ca)"] == pytest.approx(220 / 3)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"measures": [{"field": 'ca"; DROP TABLE x; --', "agg": "sum"}]}, "Champ inconnu"),
        ({"measures": [{"field": "region", "agg": "sum"}]}, "numérique"),
        ({"dimensions": [{"field": "region", "bin": "month"}]}, "dates"),
        ({"measures": [{"agg": "sum"}]}, "count"),
        ({"dimensions": [{"field": "region"}], "sort": [{"key": "inconnu"}]}, "Tri"),
    ],
)
def test_invalid_queries(ds, kwargs, message) -> None:
    with pytest.raises(QueryError, match=message):
        ds(**kwargs)


def test_filter_values_are_bound_parameters(ds) -> None:
    evil = "x' OR '1'='1"
    assert ds(measures=[{"agg": "count"}], filters=[{"field": "region", "values": [evil]}]).rows == [[0]]


def test_data_persists_across_restarts(tmp_path: Path) -> None:
    path = tmp_path / "atelier.duckdb"
    db = LocalDatabase(path)
    store = DatasetStore(db)
    dataset = store.add("a.csv", "csv", pd.DataFrame({"x": [1, 2]}))
    store.add("a.csv", "csv", pd.DataFrame({"x": [3]}))
    db.close()

    reopened = DatasetStore(LocalDatabase(path))
    assert [d.name for d in reopened.list()] == ["a (2).csv", "a.csv"]
    assert reopened.rows(reopened.get(dataset.id), 0, 10).rows == [{"x": 1}, {"x": 2}]  # type: ignore[arg-type]
    assert reopened.remove(dataset.id) and reopened.get(dataset.id) is None


def test_leading_zero_codes_stay_text() -> None:
    df, _ = read_table("x.csv", b"cp;dep;n\n01000;06;12\n75001;13;7\n")
    assert df["cp"].tolist() == ["01000", "75001"]
    assert df["dep"].tolist() == ["06", "13"]
    assert df["n"].tolist() == [12, 7]
