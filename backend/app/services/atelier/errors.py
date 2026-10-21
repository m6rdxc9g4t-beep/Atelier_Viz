"""Erreurs des routes `/api/atelier/*` (docs/SUITE.md §7.5) : `{ "detail": "message en français", "code": … }`."""

from __future__ import annotations

from typing import Any

PREFIX = "/api/atelier"

STATUS_CODES = {
    400: "VALIDATION",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "VALIDATION",
    422: "VALIDATION",
}


class AtelierError(Exception):
    """Erreur présentable d'une action du nœud Atelier (code machine du contrat)."""

    def __init__(self, status_code: int, code: str, detail: str, extra: dict[str, Any] | None = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.extra = extra or {}

    def body(self) -> dict[str, Any]:
        return {"detail": self.detail, "code": self.code, **self.extra}


def is_atelier_path(path: str) -> bool:
    return path == PREFIX or path.startswith(PREFIX + "/")


def code_for(status_code: int) -> str:
    return STATUS_CODES.get(status_code, "VALIDATION" if 400 <= status_code < 500 else "INTERNAL")


def validation_message(errors: list[Any]) -> str:
    """Message lisible d'une erreur de validation FastAPI (« Entrée invalide : body.key — … »)."""
    parts = []
    for err in errors[:5]:
        if not isinstance(err, dict):
            continue
        where = ".".join(str(p) for p in err.get("loc", ()) if p not in {"body", "query", "path"})
        parts.append(f"{where or 'entrée'} : {err.get('msg', 'invalide')}")
    return "Entrée invalide — " + ("; ".join(parts) if parts else "format inattendu") + "."


def text_detail(detail: Any) -> str:
    """`detail` d'une HTTPException ramené à une phrase."""
    if isinstance(detail, str):
        return detail
    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
        return detail["message"]
    return "Requête refusée."
