"""Modèle de données : langage d'expressions, colonnes et mesures calculées, routes."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.schemas.dataset import DatasetModel, ExpressionCheck
from app.schemas.query import QueryRequest
from app.services.data import DatasetStore, read_table
from app.services.data.model import ModelError
from app.services.engine import LocalDatabase, run_query
from app.services.engine.expressions import ExpressionError, Scope, column_scope, compile_expression

CSV = (
    b"date;region;produit;ca;cout;nouveau\n"
    b"05/01/2026;Nord;A;100;60;oui\n"
    b"20/01/2026;Nord;B;50;20;non\n"
    b"03/02/2026;Sud;A;200;150;oui\n"
    b"15/02/2026;Sud;B;0;10;non\n"
    b"10/03/2026;Nord;A;70;30;non\n"
)

SCOPE = Scope(
    columns=column_scope({"ca": "number", "cout": "number", "region": "string", "date": "date", "nouveau": "boolean"}),
    measures={"marge": "SUM(ca) - SUM(cout)", "boucle": "[boucle2] + 1", "boucle2": "[boucle] * 2"},
)


def compile_ok(text: str, kind: str = "measure") -> str:
    return compile_expression(text, kind, SCOPE, name="essai").sql  # type: ignore[arg-type]


def error_of(text: str, kind: str = "measure") -> tuple[str, int | None]:
    with pytest.raises(ExpressionError) as info:
        compile_expression(text, kind, SCOPE, name="essai")  # type: ignore[arg-type]
    return info.value.message, info.value.position


# ─── Langage ─────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "kind", "sql"),
    [
        ("SUM(ca) - SUM(cout)", "measure", '(SUM("ca") - SUM("cout"))'),
        ("SOMME(ca) / NB(*)", "measure", '(SUM("ca") / NULLIF(COUNT(*), 0))'),
        ("DIVIDE([marge], SUM(ca), 0)", "measure", 'COALESCE((((SUM("ca") - SUM("cout"))) / NULLIF(SUM("ca"), 0)), 0)'),
        ("COUNT(DISTINCT region)", "measure", 'COUNT(DISTINCT "region")'),
        ("AVG(nouveau)", "measure", 'AVG(CAST("nouveau" AS INTEGER))'),
        ("ca * 1.2", "column", '("ca" * 1.2)'),
        ("SI(ca > 100, 'Gros', \"Petit\")", "column", "(CASE WHEN (\"ca\" > 100) THEN 'Gros' ELSE 'Petit' END)"),
        ("ANNEE(date)", "column", 'YEAR("date")'),
        (
            "date >= '2026-02-01' ET NON nouveau",
            "column",
            '(("date" >= CAST(\'2026-02-01\' AS TIMESTAMP)) AND (NOT "nouveau"))',
        ),
    ],
)
def test_compiles_to_safe_sql(text: str, kind: str, sql: str) -> None:
    assert compile_ok(text, kind) == sql


@pytest.mark.parametrize(
    ("text", "kind", "message", "position"),
    [
        ("ca * 2", "measure", "doit être agrégé", 0),
        ("SUMM(ca)", "measure", "Vouliez-vous dire « SUM »", 0),
        ("SUM(regoin)", "measure", "Vouliez-vous dire « region »", 4),
        ("SUM(region)", "measure", "SUM attend un nombre, pas un texte", 4),
        ("SUM(SUM(ca))", "measure", "ne peut pas en contenir une autre", 4),
        ("boucle", "measure", "Référence circulaire", 0),
        ("SUM(ca)", "column", "utilisez une mesure calculée", 0),
        ("[marge] + 1", "column", "est une mesure", 0),
        ("ca +", "column", "Valeur attendue", 4),
        ("ca @ 2", "column", "Caractère inattendu « @ »", 3),
        ("IF(ca > 1, 1, 'x')", "column", "même type", 0),
        ("region > 3", "column", "Comparaison impossible entre un texte et un nombre", 7),
        ("COUNT(region) * region", "measure", "doit être agrégé", 16),
    ],
)
def test_errors_are_french_and_located(text: str, kind: str, message: str, position: int) -> None:
    got, pos = error_of(text, kind)
    assert message in got
    assert pos == position


def test_injection_attempts_stay_literals_or_unknown_names() -> None:
    assert error_of('[ca"; DROP TABLE x; --]', "column")[0].startswith("Champ ou mesure inconnu")
    sql = compile_ok("SI(ca > 0, 'a''); DROP TABLE x; --', 'b')", "column")
    assert "'a''); DROP TABLE x; --'" in sql  # apostrophe doublée : reste un texte
    assert error_of("ca; DROP TABLE x", "column")[0].startswith("Caractère inattendu")


# ─── Modèle stocké, vue et moteur ────────────────────────────────────────────────────


@pytest.fixture
def store(tmp_path: Path):
    db = LocalDatabase(tmp_path / "t.duckdb")
    s = DatasetStore(db)
    df, fmt = read_table("v.csv", CSV)
    s.add("v.csv", fmt, df)
    yield s
    db.close()


MODEL = DatasetModel.model_validate(
    {
        "columns": [
            {"name": "marge ligne", "expression": "ca - cout"},
            {"name": "taille", "expression": "SI([marge ligne] >= 40, 'Grosse', 'Petite')"},
        ],
        "measures": [
            {"name": "marge", "expression": "SUM(ca) - SUM(cout)"},
            {"name": "taux de marge", "expression": "DIVIDE([marge], SUM(ca))"},
        ],
    }
)


def query(store: DatasetStore, **kw):  # type: ignore[no-untyped-def]
    ds = store.list()[0]
    res = run_query(store.db, ds.source, ds.profile(), QueryRequest(dataset_id=ds.id, **kw))
    keys = [c.key for c in res.columns]
    return [dict(zip(keys, r, strict=True)) for r in res.rows]


def test_model_creates_view_profiles_columns_and_computes_measures(store: DatasetStore) -> None:
    ds = store.set_model(store.list()[0], MODEL)
    calc = {c.name: c for c in ds.profile().columns if c.calculated}
    assert calc["marge ligne"].type == "number" and calc["marge ligne"].min == -10 and calc["marge ligne"].max == 50
    assert calc["taille"].type == "string" and {v.value for v in calc["taille"].top_values} == {"Grosse", "Petite"}
    assert ds.source == f"v_{ds.id}"

    rows = query(
        store,
        dimensions=[{"field": "taille"}],
        measures=[
            {"field": "marge", "agg": "calc"},
            {"field": "taux de marge", "agg": "calc"},
            {"field": "ca", "agg": "sum"},
        ],
        filters=[{"field": "marge ligne", "op": "gt", "values": [0]}],
    )
    assert rows == [
        {"taille": "Grosse", "calc(marge)": 130, "calc(taux de marge)": pytest.approx(130 / 370), "sum(ca)": 370},
        {"taille": "Petite", "calc(marge)": 30, "calc(taux de marge)": pytest.approx(30 / 50), "sum(ca)": 50},
    ]
    # Sous-totaux (matrice) : la mesure calculée est recalculée sur chaque niveau, pas additionnée.
    total = query(
        store,
        dimensions=[{"field": "region"}],
        measures=[{"field": "taux de marge", "agg": "calc"}],
        grouping_sets=[["region"], []],
    )
    assert total[-1]["calc(taux de marge)"] == pytest.approx((420 - 270) / 420)


def test_invalid_model_changes_nothing(store: DatasetStore) -> None:
    ds = store.list()[0]
    bad = DatasetModel.model_validate(
        {"columns": [{"name": "ca", "expression": "1"}], "measures": [{"name": "m", "expression": "SUM(inconnu)"}]}
    )
    with pytest.raises(ModelError) as info:
        store.set_model(ds, bad)
    assert [(i.kind, i.name) for i in info.value.issues] == [("column", "ca"), ("measure", "m")]
    assert store.list()[0].profile().model.columns == []


def test_model_survives_restart_and_removal_drops_view(tmp_path: Path) -> None:
    db = LocalDatabase(tmp_path / "p.duckdb")
    s = DatasetStore(db)
    df, fmt = read_table("v.csv", CSV)
    ds = s.set_model(s.add("v.csv", fmt, df), MODEL)
    db.close()
    db2 = LocalDatabase(tmp_path / "p.duckdb")
    s2 = DatasetStore(db2)
    again = s2.get(ds.id)
    assert again is not None and [m.name for m in again.profile().model.measures] == ["marge", "taux de marge"]
    assert query(s2, measures=[{"field": "marge", "agg": "calc"}]) == [{"calc(marge)": 150.0}]
    s2.remove(ds.id)
    _, views = db2.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal")
    assert views == []
    db2.close()


def test_check_gives_preview_or_located_error(store: DatasetStore) -> None:
    ds = store.set_model(store.list()[0], MODEL)
    ok = store.check(ds, ExpressionCheck(kind="column", name="ttc", expression="ca * 1.2"))
    assert ok.ok and ok.type == "number" and ok.preview == [120.0, 60.0, 240.0, 0.0, 84.0]
    m = store.check(ds, ExpressionCheck(kind="measure", name="ratio", expression="[marge] / NB(*)"))
    assert m.ok and m.preview == [30.0]
    bad = store.check(ds, ExpressionCheck(kind="measure", name="x", expression="SUM(ca) +"))
    assert not bad.ok and bad.position == 9
    clash = store.check(ds, ExpressionCheck(kind="measure", name="ca", expression="SUM(ca)"))
    assert not clash.ok and "déjà utilisé" in (clash.error or "")


# ─── Routes ──────────────────────────────────────────────────────────────────────────


def test_routes(client: TestClient) -> None:
    dataset_id = client.post("/api/datasets", files={"file": ("v.csv", CSV, "text/csv")}).json()["id"]
    res = client.put(f"/api/datasets/{dataset_id}/model", json=MODEL.model_dump())
    assert res.status_code == 200, res.text
    assert [c["name"] for c in res.json()["columns"] if c["calculated"]] == ["marge ligne", "taille"]
    assert "taille" in client.get(f"/api/datasets/{dataset_id}/rows").json()["columns"]

    q = {"dataset_id": dataset_id, "measures": [{"field": "marge", "agg": "calc"}]}
    assert client.post("/api/query", json=q).json()["rows"] == [[150.0]]
    q["measures"] = [{"field": "inexistante", "agg": "calc"}]
    assert client.post("/api/query", json=q).status_code == 422

    bad = client.put(
        f"/api/datasets/{dataset_id}/model", json={"columns": [], "measures": [{"name": "m", "expression": "ca"}]}
    )
    assert bad.status_code == 422 and bad.json()["detail"]["issues"][0]["name"] == "m"
    check = client.post(
        f"/api/datasets/{dataset_id}/model/check", json={"kind": "column", "name": "x", "expression": "ca *"}
    )
    assert check.status_code == 200 and check.json()["ok"] is False
    assert (
        client.put(
            f"/api/datasets/{dataset_id}/model", json={"columns": [{"name": "a|b", "expression": "1"}]}
        ).status_code
        == 422
    )


# ─── Robustesse (revue de sécurité) ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    [
        "(" * 600 + "ca" + ")" * 600,  # imbrication profonde
        "-" * 1000 + "ca",  # chaîne de signes
        " + ".join(["ca"] * 400),  # trop d'éléments
    ],
)
def test_deep_or_huge_expressions_fail_cleanly(text: str) -> None:
    message, _ = error_of(text, "column")
    assert "trop" in message


def test_infinite_number_is_rejected() -> None:
    assert error_of("ca + " + "9" * 400, "column")[0] == "Nombre trop grand."


def test_literal_with_template_marker_is_not_altered(store: DatasetStore) -> None:
    model = DatasetModel.model_validate(
        {"measures": [{"name": "piège", "expression": 'SUM(IF(region = "{distinct}", 1, 0)) + COUNT(*)'}]}
    )
    store.set_model(store.list()[0], model)
    plain = query(store, dimensions=[{"field": "region"}], measures=[{"field": "piège", "agg": "calc"}])
    assert plain == [{"region": "Nord", "calc(piège)": 3}, {"region": "Sud", "calc(piège)": 2}]
    grouped = query(
        store,
        dimensions=[{"field": "region"}],
        measures=[{"field": "piège", "agg": "calc"}],
        grouping_sets=[["region"], []],
    )
    assert grouped[-1]["calc(piège)"] == 5


@pytest.mark.parametrize("name", ["a\x00b", "a‮b", "a\x1fb"])
def test_control_characters_in_names_are_refused(name: str) -> None:
    with pytest.raises(ValueError, match="invisible ou de contrôle"):
        DatasetModel.model_validate({"columns": [{"name": name, "expression": "1"}]})


def test_routes_never_return_500_on_hostile_input(client: TestClient) -> None:
    dataset_id = client.post("/api/datasets", files={"file": ("v.csv", CSV, "text/csv")}).json()["id"]
    for expression in ["(" * 600 + "ca" + ")" * 600, "-" * 1000 + "ca", "ca + " + "9" * 400]:
        res = client.post(
            f"/api/datasets/{dataset_id}/model/check", json={"kind": "column", "name": "x", "expression": expression}
        )
        assert res.status_code == 200 and res.json()["ok"] is False
        res = client.put(
            f"/api/datasets/{dataset_id}/model", json={"columns": [{"name": "x", "expression": expression}]}
        )
        assert res.status_code == 422
    assert (
        client.put(
            f"/api/datasets/{dataset_id}/model", json={"columns": [{"name": "a\x00b", "expression": "1"}]}
        ).status_code
        == 422
    )


# ─── Paramètres de simulation (PARAM) ────────────────────────────────────────────────


def test_param_compiles_to_literal_value_or_default() -> None:
    assert compile_ok('SUM(ca) * (1 + PARAM("croissance", 5) / 100)') == '(SUM("ca") * (1 + (5 / NULLIF(100, 0))))'
    scoped = Scope(columns=SCOPE.columns, measures=SCOPE.measures, parameters={"croissance": -2.5})
    sql = compile_expression('SUM(ca) * PARAMETRE("croissance", 5)', "measure", scoped).sql
    assert sql == '(SUM("ca") * CAST((-2.5) AS DOUBLE))'
    # Défaut négatif accepté ; un autre paramètre garde son défaut.
    assert compile_ok('PARAM("remise", -3)') == "(-3)"


@pytest.mark.parametrize(
    ("text", "kind", "message"),
    [
        ('ca * PARAM("x", 1)', "column", "s'utilise dans une mesure"),
        ("SUM(ca) * PARAM(croissance, 1)", "measure", "entre guillemets"),
        ('SUM(ca) * PARAM("x", ca)', "measure", "doit être un nombre"),
        ('SUM(ca) * PARAM("x")', "measure", "attend 2 argument"),
        ('SUM(ca) * PARAM("a;DROP TABLE x", 1)', "measure", "entre guillemets"),
    ],
)
def test_param_errors(text: str, kind: str, message: str) -> None:
    assert message in error_of(text, kind)[0]


def test_parameters_used_lists_names_and_defaults() -> None:
    from app.services.engine.expressions import parameters_used

    text = 'SUM(ca) * (1 + PARAM("croissance", 5) / 100) - PARAM("remise", -2) + PARAM("croissance", 9)'
    assert parameters_used(text) == [("croissance", 5.0), ("remise", -2.0)]
    assert parameters_used("SUM(") == []


def test_query_uses_parameter_values(store: DatasetStore) -> None:
    model = DatasetModel.model_validate(
        {"measures": [{"name": "CA simulé", "expression": 'SUM(ca) * (1 + PARAM("croissance", 10) / 100)'}]}
    )
    store.set_model(store.list()[0], model)
    measure = [{"field": "CA simulé", "agg": "calc"}]
    assert query(store, measures=measure)[0]["calc(CA simulé)"] == pytest.approx(420 * 1.10)
    assert query(store, measures=measure, parameters={"croissance": 50})[0]["calc(CA simulé)"] == pytest.approx(630)
    # Un paramètre inconnu de la mesure est sans effet.
    assert query(store, measures=measure, parameters={"autre": 3})[0]["calc(CA simulé)"] == pytest.approx(462)


@pytest.mark.parametrize("bad", [{"x": float("inf")}, {"": 1}, {"x" * 61: 1}, {"x": 1e16}])
def test_query_rejects_invalid_parameters(bad: dict[str, float]) -> None:
    with pytest.raises(ValueError):
        QueryRequest(dataset_id="abc", measures=[{"agg": "count"}], parameters=bad)


def test_query_route_accepts_parameters(client: TestClient) -> None:
    ds = client.post("/api/datasets", files={"file": ("v.csv", CSV, "text/csv")}).json()
    model = {"columns": [], "measures": [{"name": "Prévu", "expression": 'SUM(ca) + PARAM("bonus", 0)'}]}
    assert client.put(f"/api/datasets/{ds['id']}/model", json=model).status_code == 200
    body = {"dataset_id": ds["id"], "measures": [{"field": "Prévu", "agg": "calc"}], "parameters": {"bonus": 80}}
    res = client.post("/api/query", json=body)
    assert res.status_code == 200, res.text
    assert res.json()["rows"] == [[500]]
    bad = client.post("/api/query", json={**body, "parameters": {"bonus": "beaucoup"}})
    assert bad.status_code == 422


def test_fractional_parameters_do_not_overflow_decimals(store: DatasetStore) -> None:
    model = DatasetModel.model_validate(
        {"measures": [{"name": "m", "expression": 'SUM(ca) * PARAM("a", 0.1) * PARAM("b", 0.1) * PARAM("c", 0.1)'}]}
    )
    store.set_model(store.list()[0], model)
    params = {"a": 0.30000000000000004, "b": 1.1000000000000001, " c ": 0.7000000000000001}
    rows = query(store, measures=[{"field": "m", "agg": "calc"}], parameters=params)
    assert rows[0]["calc(m)"] == pytest.approx(420 * 0.3 * 1.1 * 0.7)
