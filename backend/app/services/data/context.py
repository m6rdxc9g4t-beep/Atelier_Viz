"""Contexte de données transmis à l'IA : schéma + petit échantillon, jamais le jeu complet."""

import json

from app.schemas.dataset import DatasetProfile

CONTEXT_SAMPLE_ROWS = 5


def dataset_context(profile: DatasetProfile) -> str:
    """Décrit le jeu de données pour le prompt système de l'assistant."""
    lines = [
        f"Jeu de données actif : « {profile.name} » ({profile.rows} lignes, {profile.columns_count} colonnes).",
        "Colonnes :",
    ]
    for col in profile.columns:
        stats = [f"type {col.type}", f"{col.distinct} valeurs distinctes"]
        if col.nulls:
            stats.append(f"{col.nulls} manquantes")
        if col.type in ("number", "date") and col.min is not None:
            stats.append(f"de {col.min} à {col.max}")
        if col.top_values:
            stats.append("fréquentes : " + ", ".join(v.value for v in col.top_values[:3]))
        lines.append(f"- {col.name} ({'; '.join(stats)})")
    sample = json.dumps(profile.sample[:CONTEXT_SAMPLE_ROWS], ensure_ascii=False, default=str)
    lines.append(f"Échantillon ({CONTEXT_SAMPLE_ROWS} premières lignes) : {sample}")
    return "\n".join(lines)
