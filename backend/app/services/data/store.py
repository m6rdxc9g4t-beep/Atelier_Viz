"""Registre persistant des jeux de données, stockés dans la base DuckDB locale.

Chaque jeu = une table `ds_<id>` + une ligne de métadonnées (profil calculé à l'import)
dans `__datasets`. Les données survivent au redémarrage du serveur.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import duckdb
import pandas as pd

from app.schemas.connection import DatasetOrigin
from app.schemas.dataset import (
    ColumnProfile,
    ColumnType,
    DatasetModel,
    DatasetProfile,
    DatasetRows,
    DatasetSummary,
    ExpressionCheck,
    ExpressionResult,
    ModelIssue,
    Relation,
    RelationCheck,
    SourceFormat,
)
from app.services.data.model import (
    CompiledColumn,
    Join,
    ModelError,
    check_expression,
    compile_model,
    profile_calculated,
    view_ddl,
)
from app.services.data.profiling import build_profile, records, to_json
from app.services.engine.database import LocalDatabase, quote_ident

SAMPLE_ROWS = 20
_ID_RE = re.compile(r"^[0-9a-f]{12}$")

_META_DDL = """
CREATE TABLE IF NOT EXISTS __datasets (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    format VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    profile JSON NOT NULL
)
"""


@dataclass(frozen=True)
class StoredDataset:
    """Métadonnées d'un jeu de données (le contenu reste dans DuckDB)."""

    id: str
    profile_data: DatasetProfile

    @property
    def table(self) -> str:
        return f"ds_{self.id}"

    @property
    def source(self) -> str:
        """Relation interrogée : la vue (avec colonnes calculées) si le modèle en définit, sinon la table."""
        model = self.profile_data.model
        return f"v_{self.id}" if model.columns or model.relations else self.table

    @property
    def name(self) -> str:
        return self.profile_data.name

    def summary(self) -> DatasetSummary:
        return DatasetSummary(**self.profile_data.model_dump(exclude={"columns", "sample"}))

    def profile(self) -> DatasetProfile:
        return self.profile_data


class DatasetStore:
    """Accès aux jeux de données. Méthodes synchrones : à appeler via `asyncio.to_thread`."""

    def __init__(self, db: LocalDatabase) -> None:
        self.db = db
        self.db.execute(_META_DDL)

    def add(self, name: str, fmt: SourceFormat, df: pd.DataFrame, origin: DatasetOrigin | None = None) -> StoredDataset:
        dataset_id = uuid.uuid4().hex[:12]
        name = self._unique_name(name)
        profile = DatasetProfile(
            id=dataset_id,
            name=name,
            format=fmt,
            rows=len(df),
            columns_count=len(df.columns),
            created_at=datetime.now(UTC),
            columns=build_profile(df),
            sample=records(df, limit=SAMPLE_ROWS),
            origin=origin,
        )
        self.db.write_dataframe(f"ds_{dataset_id}", df)
        self.db.execute(
            "INSERT INTO __datasets VALUES (?, ?, ?, ?, ?)",
            [dataset_id, name, fmt, profile.created_at, profile.model_dump_json()],
        )
        return StoredDataset(dataset_id, profile)

    def get(self, dataset_id: str) -> StoredDataset | None:
        if not _ID_RE.match(dataset_id):
            return None
        _, rows = self.db.execute("SELECT profile FROM __datasets WHERE id = ?", [dataset_id])
        if not rows:
            return None
        return StoredDataset(dataset_id, DatasetProfile.model_validate(json.loads(rows[0][0])))

    def list(self) -> list[StoredDataset]:
        """Du plus récent au plus ancien."""
        _, rows = self.db.execute("SELECT id, profile FROM __datasets ORDER BY created_at DESC")
        return [StoredDataset(r[0], DatasetProfile.model_validate(json.loads(r[1]))) for r in rows]

    def rows(self, dataset: StoredDataset, offset: int, limit: int) -> DatasetRows:
        names, rows = self.db.execute(f"SELECT * FROM {quote_ident(dataset.source)} LIMIT ? OFFSET ?", [limit, offset])
        return DatasetRows(
            columns=names,
            rows=[{n: to_json(v) for n, v in zip(names, row, strict=True)} for row in rows],
            total=dataset.profile_data.rows,
            offset=offset,
            limit=limit,
        )

    def remove(self, dataset_id: str) -> bool:
        if self.get(dataset_id) is None:
            return False
        # Les jeux liés à celui-ci perdent leur relation (et ce qui en dépendait) avant la suppression.
        for dep in self.dependents(dataset_id):
            model = dep.profile_data.model.model_copy(
                update={"relations": [r for r in dep.profile_data.model.relations if r.dataset_id != dataset_id]}
            )
            self._set_model_pruned(dep, model)
        self.db.execute(f"DROP VIEW IF EXISTS {quote_ident(f'v_{dataset_id}')}")
        self.db.execute(f"DROP TABLE IF EXISTS {quote_ident(f'ds_{dataset_id}')}")
        self.db.execute("DELETE FROM __datasets WHERE id = ?", [dataset_id])
        return True

    def set_model(self, dataset: StoredDataset, model: DatasetModel) -> StoredDataset:
        """Valide et enregistre le modèle : vue recréée, colonnes liées et calculées profilées.

        Lève `ModelError` (rien n'est modifié) si une relation, une colonne ou une mesure est invalide.
        Les jeux qui dépendent de celui-ci (relations vers lui) sont reconstruits ensuite.
        """
        profile = dataset.profile_data
        base = [c for c in profile.columns if not c.calculated and not c.related]
        previous = self._view_sql(dataset.id, base, profile.model)
        try:
            derived = self._materialize(dataset.id, base, model)
        except duckdb.Error as exc:
            if previous:
                self.db.execute(previous)  # la vue précédente est rétablie : rien n'est modifié
            raise ModelError([ModelIssue(kind="column", name="(modèle)", error=f"Calcul impossible : {exc}")]) from exc
        updated = profile.model_copy(update={"columns": base + derived, "model": model})
        self.db.execute("UPDATE __datasets SET profile = ? WHERE id = ?", [updated.model_dump_json(), dataset.id])
        self._rebuild_dependents(dataset.id)
        return StoredDataset(dataset.id, updated)

    def replace_data(self, dataset: StoredDataset, df: pd.DataFrame, origin: DatasetOrigin | None) -> StoredDataset:
        """Actualise le contenu d'un jeu (même identifiant : les rapports restent branchés).

        Le modèle (relations, colonnes et mesures calculées) est revalidé sur les nouvelles colonnes :
        s'il ne tient plus (colonne disparue…), `ModelError` est levée et rien n'est modifié.
        """
        profile = dataset.profile_data
        staging = f"ds_{dataset.id}__new"
        self.db.write_dataframe(staging, df)
        try:
            base = build_profile(df)
            self._compile(dataset.id, base, profile.model)  # validation seule, avant tout remplacement
            table, new = quote_ident(dataset.table), quote_ident(staging)
            self.db.execute(f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM {new}")
        finally:
            self.db.execute(f"DROP TABLE IF EXISTS {quote_ident(staging)}")
        derived = self._materialize(dataset.id, base, profile.model)
        updated = profile.model_copy(
            update={
                "rows": len(df),
                "columns_count": len(df.columns),
                "columns": base + derived,
                "sample": records(df, limit=SAMPLE_ROWS),
                "origin": origin,
            }
        )
        self.db.execute("UPDATE __datasets SET profile = ? WHERE id = ?", [updated.model_dump_json(), dataset.id])
        self._rebuild_dependents(dataset.id)
        return StoredDataset(dataset.id, updated)

    # --- Relations et vue ------------------------------------------------------------------

    def _joins(
        self, dataset_id: str, base: list[ColumnProfile], model: DatasetModel
    ) -> tuple[list[Join], dict[str, ColumnType], list[ModelIssue]]:
        """Jointures des relations, types des colonnes liées et erreurs éventuelles."""
        base_types = {c.name: c.type for c in base}
        taken = {name.lower() for name in base_types}
        joins: list[Join] = []
        related: dict[str, ColumnType] = {}
        issues: list[ModelIssue] = []
        names: set[str] = set()

        def issue(rel: Relation, error: str) -> None:
            issues.append(ModelIssue(kind="relation", name=rel.name, error=error))

        for rel in model.relations:
            if rel.name.lower() in names:
                issue(rel, "Ce nom de relation est déjà utilisé.")
                continue
            names.add(rel.name.lower())
            if rel.dataset_id == dataset_id:
                issue(rel, "Un jeu ne peut pas être lié à lui-même.")
                continue
            other = self.get(rel.dataset_id)
            if other is None:
                issue(rel, "Le jeu lié n'existe plus.")
                continue
            if self._reaches(rel.dataset_id, dataset_id):
                issue(rel, f"Relation circulaire : « {other.name} » est déjà lié à ce jeu.")
                continue
            if rel.from_column not in base_types:
                issue(rel, f"Colonne inconnue dans ce jeu : « {rel.from_column} ».")
                continue
            other_types = {c.name: c.type for c in other.profile_data.columns}
            if rel.to_column not in other_types:
                issue(rel, f"Colonne inconnue dans « {other.name} » : « {rel.to_column} ».")
                continue
            wanted = rel.columns if rel.columns is not None else list(other_types)
            unknown = [c for c in wanted if c not in other_types]
            if unknown:
                issue(rel, f"Colonne(s) inconnue(s) dans « {other.name} » : {', '.join(unknown)}.")
                continue
            pairs = []
            for col in wanted:
                out = f"{rel.name}.{col}"
                if out.lower() in taken:
                    issue(rel, f"« {out} » existe déjà dans ce jeu.")
                    break
                taken.add(out.lower())
                pairs.append((col, out))
                related[out] = other_types[col]
            else:
                as_text = base_types[rel.from_column] != other_types[rel.to_column]
                joins.append(Join(other.source, rel.from_column, rel.to_column, as_text, tuple(pairs)))
        return joins, related, issues

    def _reaches(self, start: str, target: str, seen: set[str] | None = None) -> bool:
        """Vrai si `start` mène à `target` en suivant les relations enregistrées."""
        seen = seen if seen is not None else set()
        if start == target:
            return True
        if start in seen:
            return False
        seen.add(start)
        ds = self.get(start)
        return bool(ds) and any(self._reaches(r.dataset_id, target, seen) for r in ds.profile_data.model.relations)  # type: ignore[union-attr]

    def _compile(self, dataset_id: str, base: list[ColumnProfile], model: DatasetModel):  # type: ignore[no-untyped-def]
        joins, related, issues = self._joins(dataset_id, base, model)
        compiled = compile_model({**{c.name: c.type for c in base}, **related}, model)
        issues += compiled.issues
        if issues:
            raise ModelError(issues)
        return joins, related, compiled

    def _view_sql(self, dataset_id: str, base: list[ColumnProfile], model: DatasetModel) -> str | None:
        """SQL de la vue actuelle (pour la rétablir en cas d'échec), ou None si elle n'est plus valide."""
        try:
            joins, _, compiled = self._compile(dataset_id, base, model)
        except ModelError:
            return None
        return view_ddl(dataset_id, compiled.columns, joins)

    def _materialize(self, dataset_id: str, base: list[ColumnProfile], model: DatasetModel) -> list[ColumnProfile]:
        """Crée la vue et profile ses colonnes liées puis calculées."""
        joins, related, compiled = self._compile(dataset_id, base, model)
        self.db.execute(view_ddl(dataset_id, compiled.columns, joins))
        source = f"v_{dataset_id}" if compiled.columns or joins else f"ds_{dataset_id}"
        by_out = {out: rel.name for rel in model.relations for out in related if out.startswith(f"{rel.name}.")}
        linked = [
            profile_calculated(self.db, source, CompiledColumn(name, "", kind), None, by_out[name])
            for name, kind in related.items()
        ]
        expressions = {c.name: c.expression for c in model.columns}
        calculated = [profile_calculated(self.db, source, c, expressions[c.name]) for c in compiled.columns]
        return linked + calculated

    def dependents(self, dataset_id: str) -> list[StoredDataset]:
        """Jeux qui ont une relation vers celui-ci."""
        return [d for d in self.list() if any(r.dataset_id == dataset_id for r in d.profile_data.model.relations)]

    def _rebuild_dependents(self, dataset_id: str) -> None:
        """Après un changement de modèle ou de données : vues et profils des jeux liés recalculés."""
        for dep in self.dependents(dataset_id):
            try:
                self.set_model(dep, dep.profile_data.model)
            except ModelError:
                continue  # relation devenue invalide : la vue précédente reste en place

    def check_relation(self, dataset: StoredDataset, rel: Relation) -> RelationCheck:
        """Correspondance des clés avant enregistrement : lignes trouvées, doublons côté « un »."""
        other = self.get(rel.dataset_id)
        base = {c.name: c.type for c in dataset.profile_data.columns}
        if other is None:
            return RelationCheck(ok=False, error="Le jeu lié n'existe pas.")
        if rel.dataset_id == dataset.id:
            return RelationCheck(ok=False, error="Un jeu ne peut pas être lié à lui-même.")
        if rel.from_column not in base:
            return RelationCheck(ok=False, error=f"Colonne inconnue : « {rel.from_column} ».")
        other_types = {c.name: c.type for c in other.profile_data.columns}
        if rel.to_column not in other_types:
            return RelationCheck(ok=False, error=f"Colonne inconnue dans « {other.name} » : « {rel.to_column} ».")
        left, right = quote_ident(rel.from_column), quote_ident(rel.to_column)
        if base[rel.from_column] != other_types[rel.to_column]:
            left, right = f"CAST({left} AS VARCHAR)", f"CAST({right} AS VARCHAR)"
        src, dim = quote_ident(dataset.source), quote_ident(other.source)
        _, dup = self.db.execute(
            f"SELECT COUNT(*) FROM (SELECT {right} FROM {dim} WHERE {right} IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1)"
        )
        _, counts = self.db.execute(
            f"SELECT COUNT(*), COUNT(*) FILTER (WHERE {left} IN (SELECT {right} FROM {dim})) FROM {src}"
        )
        _, missing = self.db.execute(
            f"SELECT DISTINCT CAST({left} AS VARCHAR) FROM {src} WHERE {left} IS NOT NULL "
            f"AND {left} NOT IN (SELECT {right} FROM {dim} WHERE {right} IS NOT NULL) ORDER BY 1 LIMIT 5"
        )
        return RelationCheck(
            ok=True,
            rows=int(counts[0][0]),
            matched=int(counts[0][1]),
            duplicates=int(dup[0][0]),
            unmatched_sample=[str(r[0]) for r in missing],
        )

    def _set_model_pruned(self, dataset: StoredDataset, model: DatasetModel) -> StoredDataset:
        """Enregistre le modèle en retirant les colonnes et mesures devenues invalides (suppression d'un jeu lié)."""
        for _ in range(20):
            try:
                return self.set_model(dataset, model)
            except ModelError as exc:
                bad = {(i.kind, i.name) for i in exc.issues}
                model = model.model_copy(
                    update={
                        "relations": [r for r in model.relations if ("relation", r.name) not in bad],
                        "columns": [c for c in model.columns if ("column", c.name) not in bad],
                        "measures": [m for m in model.measures if ("measure", m.name) not in bad],
                    }
                )
        return self.set_model(dataset, DatasetModel())

    def check(self, dataset: StoredDataset, check: ExpressionCheck) -> ExpressionResult:
        """Vérifie une expression de l'éditeur (sans rien enregistrer)."""
        return check_expression(self.db, dataset.profile_data, dataset.source, check)

    def _unique_name(self, name: str) -> str:
        _, rows = self.db.execute("SELECT name FROM __datasets")
        existing = {r[0] for r in rows}
        if name not in existing:
            return name
        stem, dot, ext = name.rpartition(".")
        if not dot:
            stem, ext = name, ""
        n = 2
        while (candidate := f"{stem} ({n}){'.' + ext if ext else ''}") in existing:
            n += 1
        return candidate
