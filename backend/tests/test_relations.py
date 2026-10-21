"""Relations entre jeux (modèle en étoile) : colonnes liées, jointure sans doublement des lignes,
clés de types différents, colonnes / mesures calculées sur les colonnes liées, actualisation et
suppression du jeu lié, cycles, diagnostic des clés, API.
"""

import pandas as pd
import pytest
from pydantic import ValidationError

from app.schemas.dataset import DatasetModel, Relation
from app.schemas.query import QueryRequest
from app.services.data import DatasetStore
from app.services.data.model import ModelError
from app.services.engine import LocalDatabase, run_query

VENTES = pd.DataFrame(
    {
        "date": pd.to_datetime(["2026-01-05", "2026-01-20", "2026-02-03", "2026-02-15", "2026-03-10", "2026-03-11"]),
        "code": ["N", "N", "S", "S", "N", "X"],
        "ca": [100.0, 50.0, 200.0, 25.0, 70.0, 5.0],
    }
)
REGIONS = pd.DataFrame({"code": ["N", "S", "E"], "nom": ["Nord", "Sud", "Est"], "objectif": [300.0, 200.0, 50.0]})


@pytest.fixture
def env():
    db = LocalDatabase()
    store = DatasetStore(db)
    ventes = store.add("ventes.csv", "csv", VENTES.copy())
    regions = store.add("regions.csv", "csv", REGIONS.copy())

    def q(dataset_id: str, **kwargs):
        ds = store.get(dataset_id)
        assert ds is not None
        res = run_query(db, ds.source, ds.profile(), QueryRequest(dataset_id=ds.id, **kwargs))
        return [dict(zip([c.key for c in res.columns], r, strict=True)) for r in res.rows]

    yield store, ventes, regions, q
    db.close()


def relate(store, ventes, regions, **extra) -> object:
    rel = Relation(name="regions", dataset_id=regions.id, from_column="code", to_column="code", **extra)
    return store.set_model(ventes, DatasetModel(relations=[rel]))


def test_related_columns_behave_like_columns(env) -> None:
    store, ventes, regions, q = env
    updated = relate(store, ventes, regions)
    cols = {c.name: c for c in updated.profile().columns}
    assert {"regions.code", "regions.nom", "regions.objectif"} <= set(cols)
    assert cols["regions.nom"].related == "regions" and cols["regions.nom"].calculated is False
    assert cols["regions.nom"].nulls == 1  # « X » n'a pas de région
    rows = q(
        ventes.id,
        dimensions=[{"field": "regions.nom"}],
        measures=[{"field": "ca", "agg": "sum"}],
        filters=[{"field": "regions.objectif", "op": "gte", "values": [200]}],
    )
    assert rows == [{"regions.nom": "Nord", "sum(ca)": 220.0}, {"regions.nom": "Sud", "sum(ca)": 225.0}]
    # Le total du jeu n'est pas modifié par la relation.
    assert q(ventes.id, measures=[{"field": "ca", "agg": "sum"}]) == [{"sum(ca)": 450.0}]


def test_duplicate_keys_never_multiply_rows(env) -> None:
    store, ventes, _, q = env
    dup = store.add(
        "regions_dup.csv", "csv", pd.DataFrame({"code": ["N", "N", "S"], "nom": ["Nord", "Nord bis", "Sud"]})
    )
    rel = Relation(name="r", dataset_id=dup.id, from_column="code", to_column="code")
    check = store.check_relation(ventes, rel)
    assert (check.ok, check.rows, check.matched, check.duplicates, check.unmatched_sample) == (True, 6, 5, 1, ["X"])
    store.set_model(ventes, DatasetModel(relations=[rel]))
    assert q(ventes.id, measures=[{"field": "ca", "agg": "sum"}, {"agg": "count"}]) == [
        {"sum(ca)": 450.0, "count(*)": 6}
    ]


def test_keys_of_different_types_are_compared_as_text(env) -> None:
    store, _, _, q = env
    facts = store.add("f.csv", "csv", pd.DataFrame({"dept": [31, 31, 75], "ca": [1.0, 2.0, 3.0]}))
    depts = store.add("d.csv", "csv", pd.DataFrame({"dept": ["31", "75"], "nom": ["Haute-Garonne", "Paris"]}))
    store.set_model(
        facts, DatasetModel(relations=[Relation(name="d", dataset_id=depts.id, from_column="dept", to_column="dept")])
    )
    assert q(facts.id, dimensions=[{"field": "d.nom"}], measures=[{"field": "ca", "agg": "sum"}]) == [
        {"d.nom": "Haute-Garonne", "sum(ca)": 3.0},
        {"d.nom": "Paris", "sum(ca)": 3.0},
    ]


def test_calculations_use_related_columns(env) -> None:
    store, ventes, regions, q = env
    rel = Relation(name="regions", dataset_id=regions.id, from_column="code", to_column="code")
    model = DatasetModel.model_validate(
        {
            "relations": [rel.model_dump()],
            "columns": [{"name": "zone", "expression": 'IF([regions.objectif] >= 250, "Grande", "Petite")'}],
            "measures": [{"name": "Atteinte", "expression": "DIVIDE(SUM(ca), MAX([regions.objectif]))"}],
        }
    )
    updated = store.set_model(ventes, model)
    assert [c.name for c in updated.profile().columns][-1] == "zone"
    rows = q(ventes.id, dimensions=[{"field": "regions.nom"}], measures=[{"field": "Atteinte", "agg": "calc"}])
    assert rows[0] == {"regions.nom": "Nord", "calc(Atteinte)": pytest.approx(220 / 300)}
    assert q(ventes.id, dimensions=[{"field": "zone"}], measures=[{"field": "ca", "agg": "sum"}])[0] == {
        "zone": "Grande",
        "sum(ca)": 220.0,
    }


def test_refreshing_the_related_dataset_updates_facts(env) -> None:
    store, ventes, regions, q = env
    relate(store, ventes, regions)
    store.replace_data(
        regions,
        pd.DataFrame({"code": ["N", "S", "X"], "nom": ["Nord-Est", "Sud", "Ouest"], "objectif": [1.0, 2.0, 3.0]}),
        None,
    )
    rows = q(ventes.id, dimensions=[{"field": "regions.nom"}], measures=[{"field": "ca", "agg": "sum"}])
    assert {r["regions.nom"] for r in rows} == {"Nord-Est", "Sud", "Ouest"}
    profile = store.get(ventes.id).profile()  # type: ignore[union-attr]
    assert next(c for c in profile.columns if c.name == "regions.nom").nulls == 0  # profils recalculés


def test_removing_the_related_dataset_prunes_the_model(env) -> None:
    store, ventes, regions, q = env
    model = DatasetModel.model_validate(
        {
            "relations": [{"name": "regions", "dataset_id": regions.id, "from_column": "code", "to_column": "code"}],
            "columns": [
                {"name": "double", "expression": "ca * 2"},
                {"name": "obj", "expression": "[regions.objectif] + 0"},
            ],
        }
    )
    store.set_model(ventes, model)
    assert store.remove(regions.id)
    after = store.get(ventes.id)
    assert after is not None
    assert after.profile_data.model.relations == [] and [c.name for c in after.profile_data.model.columns] == ["double"]
    assert q(ventes.id, measures=[{"field": "double", "agg": "sum"}]) == [{"sum(double)": 900.0}]


def test_chains_and_cycles(env) -> None:
    store, ventes, regions, q = env
    pays = store.add("pays.csv", "csv", pd.DataFrame({"nom": ["Nord", "Sud", "Est"], "pays": ["FR", "FR", "DE"]}))
    store.set_model(
        regions, DatasetModel(relations=[Relation(name="geo", dataset_id=pays.id, from_column="nom", to_column="nom")])
    )
    relate(store, ventes, store.get(regions.id))
    # Chaîne ventes → regions → pays : la colonne du 2e niveau est disponible.
    rows = q(ventes.id, dimensions=[{"field": "regions.geo.pays"}], measures=[{"field": "ca", "agg": "sum"}])
    assert rows[0] == {"regions.geo.pays": "FR", "sum(ca)": 445.0}
    # Cycle : pays → ventes refusé.
    with pytest.raises(ModelError, match="circulaire"):
        store.set_model(
            pays,
            DatasetModel(relations=[Relation(name="v", dataset_id=ventes.id, from_column="nom", to_column="code")]),
        )


def test_invalid_relations(env) -> None:
    store, ventes, regions, _ = env
    with pytest.raises(ValidationError):
        Relation(name="a.b", dataset_id=regions.id, from_column="code", to_column="code")
    cases = [
        (Relation(name="r", dataset_id=ventes.id, from_column="code", to_column="code"), "lui-même"),
        (Relation(name="r", dataset_id=regions.id, from_column="inconnue", to_column="code"), "inconnue"),
        (
            Relation(name="r", dataset_id=regions.id, from_column="code", to_column="code", columns=["nom", "zzz"]),
            "zzz",
        ),
        (Relation(name="r", dataset_id="000000000000", from_column="code", to_column="code"), "n'existe plus"),
    ]
    for rel, fragment in cases:
        with pytest.raises(ModelError) as err:
            store.set_model(ventes, DatasetModel(relations=[rel]))
        assert fragment in err.value.issues[0].error and err.value.issues[0].kind == "relation"
    assert (
        store.check_relation(ventes, Relation(name="r", dataset_id=regions.id, from_column="zz", to_column="code")).ok
        is False
    )


def test_api_relations(client) -> None:
    datasets = {d["name"]: d["id"] for d in client.post("/api/samples").json()["datasets"]}
    ventes, regions = datasets["ventes_2026.csv"], datasets["regions.csv"]
    rel = {
        "name": "reg",
        "dataset_id": regions,
        "from_column": "region",
        "to_column": "region",
        "columns": ["responsable", "objectif_ca_2026"],
    }
    check = client.post(f"/api/datasets/{ventes}/relations/check", json=rel).json()
    assert check["ok"] and check["matched"] == check["rows"] == 573 and check["duplicates"] == 0
    model = client.get(f"/api/datasets/{ventes}").json()["model"]
    saved = client.put(f"/api/datasets/{ventes}/model", json={**model, "relations": [*model["relations"], rel]})
    assert saved.status_code == 200, saved.text
    names = {c["name"] for c in saved.json()["columns"]}
    assert {"reg.responsable", "reg.objectif_ca_2026"} <= names and "reg.code" not in names
    res = client.post(
        "/api/query",
        json={
            "dataset_id": ventes,
            "dimensions": [{"field": "reg.responsable"}],
            "measures": [{"field": "chiffre_affaires", "agg": "sum"}],
        },
    )
    assert res.status_code == 200 and len(res.json()["rows"]) == 5
    bad = client.put(f"/api/datasets/{ventes}/model", json={**model, "relations": [{**rel, "from_column": "inconnue"}]})
    assert bad.status_code == 422 and bad.json()["detail"]["issues"][0]["kind"] == "relation"
