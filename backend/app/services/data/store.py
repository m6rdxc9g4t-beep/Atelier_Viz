"""Registre persistant des jeux de données, stockés dans la base DuckDB locale.

Chaque jeu = une table `ds_<id>` + une ligne de métadonnées (profil calculé à l'import)
dans `__datasets`. Les données survivent au redémarrage du serveur.
"""

import json
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

import pandas as pd

from app.schemas.dataset import (
    DatasetModel,
    DatasetProfile,
    DatasetRows,
    DatasetSummary,
    ExpressionCheck,
    ExpressionResult,
    SourceFormat,
)
from app.services.data.model import ModelError, check_expression, compile_model, profile_calculated, view_ddl
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
        return f"v_{self.id}" if self.profile_data.model.columns else self.table

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

    def add(self, name: str, fmt: SourceFormat, df: pd.DataFrame) -> StoredDataset:
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
        self.db.execute(f"DROP VIEW IF EXISTS {quote_ident(f'v_{dataset_id}')}")
        self.db.execute(f"DROP TABLE IF EXISTS {quote_ident(f'ds_{dataset_id}')}")
        self.db.execute("DELETE FROM __datasets WHERE id = ?", [dataset_id])
        return True

    def set_model(self, dataset: StoredDataset, model: DatasetModel) -> StoredDataset:
        """Valide et enregistre le modèle : vue recréée, colonnes calculées profilées.

        Lève `ModelError` (rien n'est modifié) si une colonne ou une mesure est invalide.
        """
        profile = dataset.profile_data
        base = [c for c in profile.columns if not c.calculated]
        compiled = compile_model({c.name: c.type for c in base}, model)
        if compiled.issues:
            raise ModelError(compiled.issues)
        self.db.execute(view_ddl(dataset.id, compiled.columns))
        source = f"v_{dataset.id}" if compiled.columns else dataset.table
        expressions = {c.name: c.expression for c in model.columns}
        calculated = [profile_calculated(self.db, source, c, expressions[c.name]) for c in compiled.columns]
        updated = profile.model_copy(update={"columns": base + calculated, "model": model})
        self.db.execute("UPDATE __datasets SET profile = ? WHERE id = ?", [updated.model_dump_json(), dataset.id])
        return StoredDataset(dataset.id, updated)

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
