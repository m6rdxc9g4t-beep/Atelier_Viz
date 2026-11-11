"""Préparation des données : chaque étape, enchaînement, rejeu à l'actualisation, erreurs, API."""

import pandas as pd
import pytest
from pydantic import TypeAdapter, ValidationError

from app.schemas.dataset import DatasetModel, PrepStep
from app.services.data import DatasetStore, prep
from app.services.data.model import ModelError
from app.services.data.prep import PrepError, apply_steps
from app.services.engine import LocalDatabase

STEPS = TypeAdapter(list[PrepStep])

RAW = pd.DataFrame(
    {
        "Client": ["  dupont jean ", "MARTIN  Claire", "dupont jean", None, "Leroy Paul"],
        "Montant": ["1 234,50", "80", "1 234,50", "12,5", "n/a"],
        "Date": ["05/01/2026", "20/01/2026", "05/01/2026", "03/02/2026", "15/02/2026"],
        "Statut": ["ok", "ok", "ok", "annulé", None],
        "Jan": [1, 2, 1, 3, 4],
        "Fev": [5, 6, 5, 7, 8],
    }
)


def run(df: pd.DataFrame, steps: list[dict]) -> pd.DataFrame:
    return apply_steps(df.copy(), STEPS.validate_python(steps))


def test_rename_remove_cast_text() -> None:
    out = run(
        RAW,
        [
            {"kind": "rename", "column": "Client", "to": "client"},
            {"kind": "remove", "columns": ["Jan", "Fev"]},
            {"kind": "cast", "column": "Montant", "to": "number"},
            {"kind": "cast", "column": "Date", "to": "date"},
            {"kind": "text", "column": "client", "mode": "trim"},
            {"kind": "text", "column": "client", "mode": "capitalize"},
        ],
    )
    assert list(out.columns) == ["client", "Montant", "Date", "Statut"]
    assert out["Montant"].tolist()[:4] == [1234.5, 80.0, 1234.5, 12.5]
    assert pd.isna(out["Montant"].iloc[4])  # « n/a » → vide
    assert out["Date"].iloc[1] == pd.Timestamp(2026, 1, 20)  # jour en premier
    assert out["client"].tolist()[:2] == ["Dupont Jean", "Martin Claire"]
    assert out["client"].iloc[3] is None


def test_cast_number_reads_the_separator_of_the_whole_column() -> None:
    cast = [{"kind": "cast", "column": "n", "to": "number"}]
    english = pd.DataFrame({"n": ["1,234.50", "980.00", "12,000", "$3,456.78", "1e3", "n/a"]})
    out = run(english, cast)["n"]
    assert out.tolist()[:5] == [1234.5, 980.0, 12000.0, 3456.78, 1000.0]  # « 12,000 » : douze mille
    assert pd.isna(out.iloc[5])
    european = pd.DataFrame({"n": ["1.234,56 €", "12,50", "1.234.567", "v1.2.3", "\u22128,30 £"]})
    out = run(european, cast)["n"]
    assert out.tolist()[:3] == [1234.56, 12.5, 1234567.0]
    assert pd.isna(out.iloc[3])  # pas un nombre : jamais « 123 »
    assert out.iloc[4] == -8.3  # signe moins typographique, livre sterling
    with pytest.raises(PrepError, match="séparateur décimal"):
        run(pd.DataFrame({"n": ["1,5", "2.5"]}), cast)
    # Les valeurs saisies dans un filtre se lisent une à une, quelle que soit leur écriture.
    typed = pd.DataFrame({"n": [1.5, 2.5, 1234.0]})
    assert len(run(typed, [{"kind": "filter", "column": "n", "op": "in", "values": ["1,5", "2.5", "1,234.0"]}])) == 3


def test_cast_date_with_different_utc_offsets(local_tz) -> None:
    local_tz("Europe/Paris")
    df = pd.DataFrame({"quand": ["2026-03-28T10:30:00+01:00", "2026-03-29T11:00:00+02:00", "n/a"]})
    out = run(df, [{"kind": "cast", "column": "quand", "to": "date"}])["quand"]
    assert [str(v) for v in out[:2]] == ["2026-03-28 10:30:00", "2026-03-29 11:00:00"] and pd.isna(out.iloc[2])


def test_unexpected_failure_of_a_step_is_a_prep_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(df: pd.DataFrame, step: object) -> pd.DataFrame:
        raise TypeError("cas imprévu de pandas")

    monkeypatch.setitem(prep._APPLY, "dedupe", boom)
    with pytest.raises(PrepError, match="Étape 2 .*impossible") as info:
        run(RAW, [{"kind": "cast", "column": "Montant", "to": "number"}, {"kind": "dedupe", "columns": []}])
    assert info.value.index == 1 and "pandas" not in info.value.message


def test_filter_replace_fill_dedupe() -> None:
    base = [{"kind": "cast", "column": "Montant", "to": "number"}, {"kind": "cast", "column": "Date", "to": "date"}]
    assert len(run(RAW, [*base, {"kind": "filter", "column": "Montant", "op": "gte", "values": ["100"]}])) == 2
    assert len(run(RAW, [*base, {"kind": "filter", "column": "Date", "op": "lt", "values": ["01/02/2026"]}])) == 3
    assert len(run(RAW, [{"kind": "filter", "column": "Statut", "op": "in", "values": ["ok"]}])) == 3
    assert len(run(RAW, [{"kind": "filter", "column": "Statut", "op": "not_null"}])) == 4
    assert len(run(RAW, [{"kind": "filter", "column": "Client", "op": "contains", "values": ["DUPONT"]}])) == 2
    out = run(
        RAW,
        [
            {"kind": "replace", "column": "Statut", "find": "annulé", "replace": "ko"},
            {"kind": "fill", "column": "Statut", "value": "inconnu"},
            {"kind": "replace", "column": "Client", "find": "jean", "replace": "Jean", "whole": False},
            {"kind": "fill", "column": "Client", "down": True},
        ],
    )
    assert out["Statut"].tolist() == ["ok", "ok", "ok", "ko", "inconnu"]
    assert out["Client"].tolist()[2:4] == ["dupont Jean", "dupont Jean"]  # rempli vers le bas
    deduped = run(RAW, [{"kind": "text", "column": "Client", "mode": "trim"}, {"kind": "dedupe"}])
    assert len(deduped) == 4
    assert len(run(RAW, [{"kind": "dedupe", "columns": ["Date"]}])) == 4


def test_unpivot_and_split() -> None:
    out = run(RAW, [{"kind": "unpivot", "columns": ["Jan", "Fev"], "attribute": "mois", "value": "qte"}])
    assert len(out) == 10 and set(out["mois"]) == {"Jan", "Fev"}
    assert out["qte"].sum() == RAW["Jan"].sum() + RAW["Fev"].sum()
    split = run(
        RAW,
        [
            {"kind": "text", "column": "Client", "mode": "trim"},
            {"kind": "split", "column": "Client", "separator": " ", "into": ["nom", "prenom"]},
        ],
    )
    assert list(split.columns[:2]) == ["nom", "prenom"]
    assert split["nom"].iloc[0] == "dupont" and split["prenom"].iloc[1] == "Claire"
    assert split["prenom"].iloc[3] is None


def test_errors_point_to_the_step() -> None:
    with pytest.raises(PrepError) as exc:
        run(RAW, [{"kind": "rename", "column": "Client", "to": "client"}, {"kind": "remove", "columns": ["Client"]}])
    assert exc.value.index == 1 and "introuvable" in exc.value.message
    with pytest.raises(PrepError, match="existe déjà"):
        run(RAW, [{"kind": "rename", "column": "Client", "to": "statut"}])
    with pytest.raises(PrepError, match="nombre ou une date"):
        run(RAW, [{"kind": "filter", "column": "Statut", "op": "gt", "values": ["a"]}])
    with pytest.raises(PrepError, match="pas une valeur valide"):
        run(RAW, [{"kind": "filter", "column": "Jan", "op": "eq", "values": ["abc"]}])
    with pytest.raises(PrepError, match="au moins une colonne"):
        run(RAW, [{"kind": "remove", "columns": list(RAW.columns)}])
    with pytest.raises(ValidationError):
        STEPS.validate_python([{"kind": "rename", "column": "a", "to": "x|y"}])
    with pytest.raises(ValidationError):
        STEPS.validate_python([{"kind": "sql", "query": "DROP TABLE x"}])


@pytest.fixture
def store():
    db = LocalDatabase()
    yield DatasetStore(db)
    db.close()


def test_store_applies_steps_and_replays_them_on_refresh(store: DatasetStore) -> None:
    ds = store.add("clients.csv", "csv", RAW.copy())
    steps = STEPS.validate_python(
        [
            {"kind": "cast", "column": "Montant", "to": "number"},
            {"kind": "filter", "column": "Montant", "op": "not_null"},
            {"kind": "rename", "column": "Montant", "to": "montant"},
        ]
    )
    preview = store.preview_steps(ds, steps)
    assert preview.ok and preview.rows == 4 and preview.raw_rows == 5
    assert store.get(ds.id).profile().rows == 5  # aperçu : rien n'est enregistré

    ds = store.set_steps(ds, steps)
    profile = ds.profile()
    assert profile.rows == 4 and len(profile.steps) == 3
    assert next(c for c in profile.columns if c.name == "montant").type == "number"
    # Modèle sur la colonne préparée, puis actualisation : les étapes sont rejouées.
    ds = store.set_model(ds, DatasetModel.model_validate({"columns": [{"name": "ttc", "expression": "montant * 2"}]}))
    fresh = RAW.copy()
    fresh.loc[len(fresh)] = ["Neuf", "10", "01/03/2026", "ok", 1, 1]
    ds = store.replace_data(ds, fresh, None)
    assert ds.profile().rows == 5
    _, rows = store.db.execute(f'SELECT SUM(ttc) FROM "{ds.source}"')
    assert rows[0][0] == pytest.approx((1234.5 * 2 + 80 + 12.5 + 10) * 2)
    # La source brute reste disponible : retirer une étape la fait réapparaître.
    ds = store.set_steps(ds, steps[:1] + steps[2:])
    assert ds.profile().rows == 6
    with pytest.raises(ModelError):  # la colonne calculée utilise « montant », renommée par une étape
        store.set_steps(ds, [])
    ds = store.set_steps(store.set_model(ds, DatasetModel()), [])
    assert ds.profile().rows == 6 and next(c for c in ds.profile().columns if c.name == "Montant").type == "string"
    _, raw = store.db.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?", [f"raw_{ds.id}"])
    assert raw[0][0] == 0


def test_store_rejects_steps_that_break_the_model_or_relations(store: DatasetStore) -> None:
    ds = store.add("clients.csv", "csv", RAW.copy())
    ds = store.set_model(ds, DatasetModel.model_validate({"columns": [{"name": "j2", "expression": "Jan * 2"}]}))
    with pytest.raises(ModelError) as exc:
        store.set_steps(ds, STEPS.validate_python([{"kind": "remove", "columns": ["Jan"]}]))
    assert exc.value.issues[0].kind == "column"
    assert store.get(ds.id).profile().rows == 5 and not store.get(ds.id).profile().steps

    other = store.add("faits.csv", "csv", pd.DataFrame({"c": ["ok", "annulé"], "v": [1, 2]}))
    store.set_model(
        other,
        DatasetModel.model_validate(
            {"relations": [{"name": "st", "dataset_id": ds.id, "from_column": "c", "to_column": "Statut"}]}
        ),
    )
    ds = store.get(ds.id)
    with pytest.raises(ModelError) as exc:
        store.set_steps(ds, STEPS.validate_python([{"kind": "rename", "column": "Statut", "to": "etat"}]))
    assert exc.value.issues[0].kind == "relation" and "Statut" in exc.value.issues[0].error
    # Une étape qui échoue à l'actualisation : rien ne change.
    store.set_steps(ds, STEPS.validate_python([{"kind": "cast", "column": "Montant", "to": "number"}]))
    with pytest.raises(ModelError) as exc:
        store.replace_data(store.get(ds.id), RAW.drop(columns=["Montant"]), None)
    assert exc.value.issues[0].kind == "step"
    assert store.get(ds.id).profile().rows == 5


def test_refresh_keeps_what_was_saved_while_it_was_reading(store: DatasetStore) -> None:
    """Une actualisation part d'un instantané du jeu lu avant de joindre la source : ce qui a été enregistré
    entre-temps (mesure, étapes) ne doit pas être écrasé à son retour."""
    stale = store.add("clients.csv", "csv", RAW.copy())
    steps = STEPS.validate_python([{"kind": "cast", "column": "Montant", "to": "number"}])
    store.set_steps(stale, steps)
    model = DatasetModel.model_validate(
        {
            "columns": [{"name": "ttc", "expression": "Montant * 2"}],
            "measures": [{"name": "total", "expression": "SUM(ttc)"}],
        }
    )
    store.set_model(stale, model)  # l'écran du modèle part lui aussi d'une lecture antérieure aux étapes

    fresh = RAW.assign(Montant=["10", "20", "30", "40", "50"])
    updated = store.replace_data(stale, fresh, None)  # instantané d'avant les étapes et le modèle

    profile = store.get(stale.id).profile()
    assert updated.profile() == profile
    assert [s.kind for s in profile.steps] == ["cast"]  # étapes gardées et rejouées
    assert [m.name for m in profile.model.measures] == ["total"]
    assert next(c for c in profile.columns if c.name == "ttc").calculated
    _, rows = store.db.execute(f'SELECT SUM("ttc") FROM "{updated.source}"')
    assert rows[0][0] == 300  # la vue calcule sur les nouvelles données, avec la colonne calculée
    # Enregistrer des étapes depuis un instantané ancien garde aussi le modèle.
    store.set_steps(
        stale, [*steps, *STEPS.validate_python([{"kind": "filter", "column": "Montant", "op": "gt", "values": ["10"]}])]
    )
    profile = store.get(stale.id).profile()
    assert profile.rows == 4 and [m.name for m in profile.model.measures] == ["total"]


def test_writes_on_a_removed_dataset_change_nothing(store: DatasetStore) -> None:
    stale = store.add("clients.csv", "csv", RAW.copy())
    assert store.remove(stale.id)

    def tables() -> list[str]:
        _, rows = store.db.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_name LIKE ?", [f"%{stale.id}%"]
        )
        return [r[0] for r in rows]

    for write in (
        lambda: store.replace_data(stale, RAW.copy(), None),
        lambda: store.set_steps(stale, STEPS.validate_python([{"kind": "cast", "column": "Montant", "to": "number"}])),
        lambda: store.set_model(stale, DatasetModel()),
    ):
        with pytest.raises(ModelError, match="supprimé"):
            write()
        assert tables() == []  # ni table, ni source brute, ni vue orpheline
    assert store.get(stale.id) is None


def test_routes(client) -> None:
    ds_id = next(d for d in client.post("/api/samples").json()["datasets"] if d["name"] == "magasins.csv")["id"]
    steps = {"steps": [{"kind": "filter", "column": "ville", "op": "contains", "values": ["Paris"]}]}
    res = client.post(f"/api/datasets/{ds_id}/steps/preview", json=steps)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] and 0 < body["rows"] < body["raw_rows"]
    bad = client.post(
        f"/api/datasets/{ds_id}/steps/preview", json={"steps": [*steps["steps"], {"kind": "remove", "columns": ["x"]}]}
    ).json()
    assert bad == {**bad, "ok": False, "step": 1, "rows": body["rows"]}
    saved = client.put(f"/api/datasets/{ds_id}/steps", json=steps)
    assert saved.status_code == 200 and saved.json()["rows"] == body["rows"]
    assert client.get(f"/api/datasets/{ds_id}").json()["steps"][0]["kind"] == "filter"
    err = client.put(f"/api/datasets/{ds_id}/steps", json={"steps": [{"kind": "remove", "columns": ["x"]}]})
    assert err.status_code == 422 and err.json()["detail"]["issues"][0]["kind"] == "step"
