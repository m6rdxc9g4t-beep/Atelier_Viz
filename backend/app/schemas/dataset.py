"""Schémas des jeux de données importés. Miroir TypeScript : frontend/src/types/dataset.ts."""

import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.connection import DatasetOrigin

ColumnType = Literal["number", "string", "date", "boolean"]
# Fichiers importés, ou type de la connexion d'origine.
SourceFormat = Literal[
    "csv", "xlsx", "json", "sqlserver", "postgres", "mysql", "sqlite", "sharepoint", "atelier_tab", "atelier_projets"
]
Scalar = float | int | str | bool | None


class ValueCount(BaseModel):
    """Une valeur fréquente et son nombre d'occurrences."""

    value: str
    count: int


class ColumnProfile(BaseModel):
    """Profil statistique d'une colonne."""

    name: str
    type: ColumnType
    nulls: int = Field(description="Nombre de valeurs manquantes.")
    distinct: int = Field(description="Nombre de valeurs distinctes (hors manquantes).")
    min: Scalar = None
    max: Scalar = None
    mean: float | None = Field(default=None, description="Moyenne (colonnes numériques).")
    top_values: list[ValueCount] = Field(default_factory=list, description="Valeurs les plus fréquentes.")
    calculated: bool = Field(default=False, description="Colonne calculée (définie dans le modèle).")
    expression: str | None = Field(default=None, description="Expression d'une colonne calculée.")
    related: str | None = Field(default=None, description="Relation d'origine d'une colonne liée (« magasins »).")


FORBIDDEN_NAME_CHARS = set('|[]"\n\r\t')


def _check_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise ValueError("Le nom est obligatoire.")
    if FORBIDDEN_NAME_CHARS & set(name) or name.startswith("__"):
        raise ValueError('Le nom ne peut pas contenir | [ ] " ni commencer par « __ ».')
    # Caractères de contrôle et de mise en forme invisibles (NUL, inversion de sens RLO…).
    if any(unicodedata.category(c) in {"Cc", "Cf"} for c in name):
        raise ValueError("Le nom contient un caractère invisible ou de contrôle.")
    return name


class CalculatedColumn(BaseModel):
    """Colonne calculée ligne à ligne (ex. `prix_unitaire * 1.2`)."""

    name: str = Field(min_length=1, max_length=80)
    expression: str = Field(min_length=1, max_length=2000)

    _name = field_validator("name")(_check_name)


class CalculatedMeasure(BaseModel):
    """Mesure calculée à partir d'agrégats (ex. `SUM(ca) - SUM(cout)`)."""

    name: str = Field(min_length=1, max_length=80)
    expression: str = Field(min_length=1, max_length=2000)
    description: str | None = Field(default=None, max_length=300)

    _name = field_validator("name")(_check_name)


def _check_relation_name(name: str) -> str:
    name = _check_name(name)
    if "." in name:
        raise ValueError(
            "Le nom d'une relation ne peut pas contenir de point (il préfixe les colonnes : « magasins.ville »)."
        )
    return name


class Relation(BaseModel):
    """Relation plusieurs-à-un vers un autre jeu (« ventes.region → regions.region »).

    Les colonnes du jeu lié deviennent des colonnes du jeu, nommées `<nom>.<colonne>` : axes, filtres,
    segments, mesures et colonnes calculées les utilisent comme les autres. Les segments et sélections
    posés sur le jeu lié filtrent aussi ce jeu (sens unique, comme dans Power BI).
    """

    name: str = Field(min_length=1, max_length=40, description="Préfixe des colonnes liées.")
    dataset_id: str = Field(pattern=r"^[0-9a-f]{12}$", description="Jeu lié (côté « un »).")
    from_column: str = Field(min_length=1, description="Colonne de ce jeu (clé étrangère).")
    to_column: str = Field(min_length=1, description="Colonne du jeu lié (clé, valeurs uniques).")
    columns: list[str] | None = Field(default=None, max_length=200, description="Colonnes reprises (toutes si absent).")

    _name = field_validator("name")(_check_relation_name)


class RelationCheck(BaseModel):
    """Diagnostic d'une relation avant enregistrement."""

    ok: bool
    error: str | None = None
    rows: int = Field(default=0, description="Lignes de ce jeu.")
    matched: int = Field(default=0, description="Lignes dont la clé est trouvée dans le jeu lié.")
    duplicates: int = Field(
        default=0, description="Clés présentes plusieurs fois côté « un » (première ligne retenue)."
    )
    unmatched_sample: list[str] = Field(default_factory=list, description="Exemples de clés sans correspondance.")


# --- Préparation des données (étapes rejouées à chaque actualisation, comme Power Query) -----------

PrepOp = Literal[
    "eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "not_contains", "is_null", "not_null"
]
TextMode = Literal["trim", "upper", "lower", "capitalize"]


class _Step(BaseModel):
    note: str | None = Field(default=None, max_length=200, description="Commentaire libre de l'étape.")


class RenameStep(_Step):
    """Renomme une colonne."""

    kind: Literal["rename"] = "rename"
    column: str
    to: str = Field(min_length=1, max_length=80)

    _to = field_validator("to")(_check_name)


class RemoveStep(_Step):
    """Supprime des colonnes."""

    kind: Literal["remove"] = "remove"
    columns: list[str] = Field(min_length=1, max_length=500)


class CastStep(_Step):
    """Change le type d'une colonne (valeurs non convertibles → vides)."""

    kind: Literal["cast"] = "cast"
    column: str
    to: ColumnType


class FilterStep(_Step):
    """Garde les lignes qui vérifient une condition."""

    kind: Literal["filter"] = "filter"
    column: str
    op: PrepOp
    values: list[Scalar] = Field(default_factory=list, max_length=1000)


class ReplaceStep(_Step):
    """Remplace une valeur (cellule entière) ou un morceau de texte."""

    kind: Literal["replace"] = "replace"
    column: str
    find: Scalar
    replace: Scalar
    whole: bool = Field(default=True, description="Cellule entière ; sinon remplacement dans le texte.")


class FillStep(_Step):
    """Remplit les valeurs manquantes (valeur fixe, ou valeur de la ligne précédente)."""

    kind: Literal["fill"] = "fill"
    column: str
    value: Scalar = None
    down: bool = Field(default=False, description="Recopier la valeur précédente (« remplir vers le bas »).")


class TextStep(_Step):
    """Nettoie un texte : espaces, majuscules, minuscules, première lettre en majuscule."""

    kind: Literal["text"] = "text"
    column: str
    mode: TextMode


class DedupeStep(_Step):
    """Supprime les lignes en double (sur toutes les colonnes ou certaines)."""

    kind: Literal["dedupe"] = "dedupe"
    columns: list[str] | None = None


class UnpivotStep(_Step):
    """Dépivote des colonnes : « janvier, février… » → lignes (attribut, valeur)."""

    kind: Literal["unpivot"] = "unpivot"
    columns: list[str] = Field(min_length=1, max_length=500)
    attribute: str = Field(default="attribut", min_length=1, max_length=80)
    value: str = Field(default="valeur", min_length=1, max_length=80)

    _names = field_validator("attribute", "value")(_check_name)


class SplitStep(_Step):
    """Fractionne une colonne texte selon un séparateur (« Nom Prénom » → deux colonnes)."""

    kind: Literal["split"] = "split"
    column: str
    separator: str = Field(min_length=1, max_length=10)
    into: list[str] = Field(min_length=2, max_length=10)

    @field_validator("into")
    @classmethod
    def _into(cls, names: list[str]) -> list[str]:
        return [_check_name(n) for n in names]


PrepStep = Annotated[
    RenameStep
    | RemoveStep
    | CastStep
    | FilterStep
    | ReplaceStep
    | FillStep
    | TextStep
    | DedupeStep
    | UnpivotStep
    | SplitStep,
    Field(discriminator="kind"),
]


class PrepRequest(BaseModel):
    """Étapes de préparation d'un jeu (dans l'ordre)."""

    steps: list[PrepStep] = Field(default_factory=list, max_length=50)


class PrepPreview(BaseModel):
    """Résultat des étapes (aperçu ou enregistrement) : colonnes, premières lignes, erreur éventuelle."""

    ok: bool
    error: str | None = None
    step: int | None = Field(default=None, description="Indice de l'étape fautive.")
    rows: int = 0
    raw_rows: int = Field(default=0, description="Lignes avant préparation.")
    columns: list["ColumnProfile"] = Field(default_factory=list)
    sample: list[dict[str, Any]] = Field(default_factory=list)


class DatasetModel(BaseModel):
    """Modèle d'un jeu de données : relations, colonnes et mesures calculées (évaluées par DuckDB)."""

    columns: list[CalculatedColumn] = Field(default_factory=list, max_length=50)
    measures: list[CalculatedMeasure] = Field(default_factory=list, max_length=100)
    relations: list[Relation] = Field(default_factory=list, max_length=10)


class DatasetSummary(BaseModel):
    """Résumé d'un jeu de données (liste)."""

    id: str
    name: str
    format: SourceFormat
    rows: int
    columns_count: int
    created_at: datetime
    origin: DatasetOrigin | None = Field(default=None, description="Connexion d'origine (jeu actualisable).")


class DatasetProfile(DatasetSummary):
    """Jeu de données profilé : colonnes typées + échantillon."""

    columns: list[ColumnProfile]
    sample: list[dict[str, Any]] = Field(description="Premières lignes, valeurs sérialisées en JSON.")
    model: DatasetModel = Field(default_factory=DatasetModel, description="Colonnes et mesures calculées.")
    steps: list[PrepStep] = Field(
        default_factory=list, description="Étapes de préparation, rejouées sur la source à chaque actualisation."
    )


class DatasetRows(BaseModel):
    """Page de lignes d'un jeu de données."""

    columns: list[str]
    rows: list[dict[str, Any]]
    total: int
    offset: int
    limit: int


class ExpressionCheck(BaseModel):
    """Vérification d'une expression dans l'éditeur (avant enregistrement)."""

    kind: Literal["column", "measure"]
    name: str = Field(default="", max_length=80)
    expression: str = Field(max_length=2000)


class ExpressionResult(BaseModel):
    ok: bool
    type: ColumnType | None = None
    error: str | None = None
    position: int | None = Field(default=None, description="Index du caractère fautif.")
    preview: list[Scalar] = Field(default_factory=list, description="5 premières valeurs (colonne) ou total (mesure).")


class ModelIssue(BaseModel):
    kind: Literal["column", "measure", "relation", "step"]
    name: str
    error: str
    position: int | None = None
