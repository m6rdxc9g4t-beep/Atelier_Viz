"""Service de l'interface compilée (frontend/dist) avec des en-têtes de cache adaptés.

La fenêtre de bureau (WKWebView) garde un cache HTTP persistant : sans consigne, elle peut
réafficher un ancien index.html — donc l'ancienne interface — après une mise à jour.
- index.html (et toute page HTML) : `no-cache`, revalidé à chaque ouverture ;
- fichiers de `assets/` : nom haché par Vite, contenu immuable, gardés un an.
"""

from __future__ import annotations

import os
from typing import Any

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

HTML_CACHE = "no-cache"
ASSET_CACHE = "public, max-age=31536000, immutable"


class FrontendFiles(StaticFiles):
    """`StaticFiles` qui interdit de garder en cache une ancienne version de l'interface."""

    def file_response(
        self, full_path: Any, stat_result: os.stat_result, scope: Scope, status_code: int = 200
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        path = str(full_path)
        if path.endswith(".html"):
            response.headers["Cache-Control"] = HTML_CACHE
        elif f"{os.sep}assets{os.sep}" in path:
            response.headers["Cache-Control"] = ASSET_CACHE
        return response
