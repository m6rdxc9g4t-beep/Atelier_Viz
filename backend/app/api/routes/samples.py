"""Jeux de données d'exemple livrés avec le dépôt (`samples/`), importables en un clic."""

import asyncio
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import SettingsDep, StoreDep
from app.schemas.dataset import DatasetSummary
from app.services.data import DatasetStore, read_table

router = APIRouter(prefix="/samples", tags=["samples"])

SAMPLE_SUFFIXES = {".csv", ".xlsx", ".json"}


class SampleFile(BaseModel):
    name: str
    imported: bool


class SamplesImport(BaseModel):
    datasets: list[DatasetSummary]
    imported: list[str]


def _files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in SAMPLE_SUFFIXES)


def _import(store: DatasetStore, folder: Path) -> SamplesImport:
    existing = {d.name: d for d in store.list()}
    imported: list[str] = []
    datasets: list[DatasetSummary] = []
    for path in _files(folder):
        dataset = existing.get(path.name)
        if dataset is None:
            df, fmt = read_table(path.name, path.read_bytes())
            dataset = store.add(path.name, fmt, df)
            imported.append(path.name)
        datasets.append(dataset.summary())
    return SamplesImport(datasets=datasets, imported=imported)


@router.get("", response_model=list[SampleFile])
async def list_samples(settings: SettingsDep, store: StoreDep) -> list[SampleFile]:
    """Fichiers d'exemple disponibles et déjà importés ou non (comparaison par nom)."""
    names = {d.name for d in await asyncio.to_thread(store.list)}
    return [SampleFile(name=p.name, imported=p.name in names) for p in _files(settings.samples_dir)]


@router.post("", response_model=SamplesImport)
async def import_samples(settings: SettingsDep, store: StoreDep) -> SamplesImport:
    """Importe les exemples absents (un exemple déjà importé n'est pas dupliqué)."""
    return await asyncio.to_thread(_import, store, settings.samples_dir)
