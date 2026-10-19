"""Connexions aux sources externes : SQL Server, PostgreSQL, MySQL, SQLite, fichiers synchronisés, SharePoint."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.api.deps import ConnectionsDep
from app.schemas.connection import (
    AuthStatus,
    Connection,
    ConnectionInput,
    ConnectorInfo,
    DeviceCodeStart,
    ImportRequest,
    PreviewRequest,
    PreviewResult,
    TableList,
    TestResult,
)
from app.schemas.dataset import DatasetProfile

router = APIRouter(prefix="/connections", tags=["connections"])


@router.get("/connectors", response_model=list[ConnectorInfo])
async def list_connectors(service: ConnectionsDep) -> list[ConnectorInfo]:
    """Types de sources disponibles et état de leur pilote."""
    return await asyncio.to_thread(service.connectors)


@router.get("", response_model=list[Connection])
async def list_connections(service: ConnectionsDep) -> list[Connection]:
    """Connexions enregistrées (sans secret)."""
    return await asyncio.to_thread(service.list_connections)


@router.post("", response_model=Connection, status_code=status.HTTP_201_CREATED)
async def create_connection(body: ConnectionInput, service: ConnectionsDep) -> Connection:
    """Enregistre une connexion ; le mot de passe va dans le trousseau du système."""
    return await asyncio.to_thread(service.create, body)


@router.post("/test", response_model=TestResult)
async def test_unsaved(body: ConnectionInput, service: ConnectionsDep) -> TestResult:
    """Essaie une connexion avant de l'enregistrer."""
    password = body.password.get_secret_value() if body.password is not None else None
    return await asyncio.to_thread(service.test, body, password)


@router.put("/{connection_id}", response_model=Connection)
async def update_connection(connection_id: str, body: ConnectionInput, service: ConnectionsDep) -> Connection:
    """Modifie une connexion (`password` absent : inchangé ; vide : effacé)."""
    return await asyncio.to_thread(service.update, connection_id, body)


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(connection_id: str, service: ConnectionsDep) -> Response:
    """Supprime une connexion et ses secrets (les jeux importés restent, sans actualisation possible)."""
    await asyncio.to_thread(service.delete, connection_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{connection_id}/test", response_model=TestResult)
async def test_saved(connection_id: str, service: ConnectionsDep) -> TestResult:
    """Essaie une connexion enregistrée."""
    cfg = await asyncio.to_thread(service.get, connection_id)
    return await asyncio.to_thread(service.test, cfg, None, connection_id)


@router.get("/{connection_id}/tables", response_model=TableList)
async def list_tables(
    connection_id: str,
    service: ConnectionsDep,
    url: Annotated[str | None, Query(max_length=2000, description="SharePoint : lien du classeur")] = None,
) -> TableList:
    """Tables et vues d'une base, feuilles d'un classeur Excel."""
    return await asyncio.to_thread(service.tables, connection_id, url)


@router.post("/{connection_id}/preview", response_model=PreviewResult)
async def preview(connection_id: str, body: PreviewRequest, service: ConnectionsDep) -> PreviewResult:
    """Premières lignes d'une table, d'une requête ou d'un élément SharePoint (rien n'est importé)."""
    return await asyncio.to_thread(service.preview, connection_id, body)


@router.post("/{connection_id}/import", response_model=DatasetProfile, status_code=status.HTTP_201_CREATED)
async def import_dataset(connection_id: str, body: ImportRequest, service: ConnectionsDep) -> DatasetProfile:
    """Copie la source dans la base locale (DuckDB) : un jeu de données actualisable."""
    dataset = await asyncio.to_thread(service.import_dataset, connection_id, body)
    return dataset.profile()


@router.post("/{connection_id}/login", response_model=DeviceCodeStart)
async def login_start(connection_id: str, service: ConnectionsDep) -> DeviceCodeStart:
    """SharePoint : démarre la connexion Microsoft (code à saisir sur microsoft.com/devicelogin)."""
    return await asyncio.to_thread(service.login_start, connection_id)


@router.post("/{connection_id}/login/poll", response_model=AuthStatus)
async def login_poll(connection_id: str, service: ConnectionsDep) -> AuthStatus:
    """SharePoint : où en est la connexion Microsoft ? (à appeler toutes les `interval` secondes)."""
    return await asyncio.to_thread(service.login_poll, connection_id)


@router.post("/{connection_id}/logout", response_model=Connection)
async def logout(connection_id: str, service: ConnectionsDep) -> Connection:
    """SharePoint : oublie le jeton Microsoft."""
    return await asyncio.to_thread(service.logout, connection_id)
