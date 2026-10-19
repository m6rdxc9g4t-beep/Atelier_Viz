"""Connecteurs de sources externes : bases SQL, fichiers synchronisés, SharePoint Online."""

from app.services.connectors.base import ConnectorError
from app.services.connectors.secrets import build_secrets
from app.services.connectors.service import ConnectionService

__all__ = ["ConnectionService", "ConnectorError", "build_secrets"]
