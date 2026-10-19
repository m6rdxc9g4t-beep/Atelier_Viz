"""SharePoint Online et OneDrive via Microsoft Graph (mode « En ligne » uniquement).

Connexion Microsoft par code d'appareil (« device code ») : l'utilisateur saisit un code sur
microsoft.com/devicelogin avec son compte professionnel ; aucun mot de passe ne transite par
l'application. Il faut une application Entra ID (client public, permissions déléguées
`Sites.Read.All` et `Files.Read.All`) : voir README, « Connecteurs ».

Sources lisibles :
- un fichier (CSV, XLSX, JSON) d'une bibliothèque ou d'un OneDrive, par son lien ;
- une liste SharePoint, par l'adresse de la liste (…/Lists/<nom>/…).
"""

import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlsplit

import httpx
import pandas as pd

from app.schemas.connection import AuthStatus, DeviceCodeStart, TableRef
from app.services.connectors.base import ConnectorError, short
from app.services.data.parsing import DatasetError, detect_format, excel_sheets, infer_types, read_table

GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"
SCOPES = "offline_access User.Read Sites.Read.All Files.Read.All"
MAX_PAGES = 2000

# Champs techniques d'une liste, jamais utiles à l'analyse.
_SYSTEM_FIELDS = {
    "ContentType", "Edit", "LinkTitleNoMenu", "LinkTitle", "DocIcon", "ItemChildCount", "FolderChildCount",
    "Attachments", "AppAuthorLookupId", "AppEditorLookupId",
}  # fmt: skip


@dataclass
class Tokens:
    access_token: str
    refresh_token: str | None
    expires_at: float
    account: str | None = None

    def dumps(self) -> str:
        return json.dumps(self.__dict__)

    @classmethod
    def loads(cls, raw: str) -> "Tokens":
        data = json.loads(raw)
        return cls(
            data["access_token"], data.get("refresh_token"), float(data.get("expires_at", 0)), data.get("account")
        )


@dataclass
class PendingLogin:
    device_code: str
    interval: int
    expires_at: float


def share_id(url: str) -> str:
    """Identifiant Graph d'un lien de partage (« u! » + base64url sans remplissage)."""
    encoded = base64.urlsafe_b64encode(url.strip().encode("utf-8")).decode("ascii").rstrip("=")
    return f"u!{encoded}"


def parse_list_url(url: str) -> tuple[str, str] | None:
    """(hôte, chemin du site) pour une adresse de liste « https://x.sharepoint.com/sites/Ventes/Lists/Commandes/… »."""
    parts = urlsplit(url.strip())
    path = unquote(parts.path)
    marker = path.lower().find("/lists/")
    if not parts.hostname or marker < 0:
        return None
    return parts.hostname, path[:marker] or "/"


def check_sharepoint_url(url: str) -> str:
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not (
        host.endswith(".sharepoint.com")
        or host.endswith(".sharepoint.us")
        or host == "1drv.ms"
        or host.endswith("onedrive.live.com")
    ):
        raise ConnectorError("Lien SharePoint attendu (https://<entreprise>.sharepoint.com/…) ou OneDrive.")
    return url.strip()


class SharePointClient:
    """Client Microsoft Graph synchrone (appelé via `asyncio.to_thread`)."""

    def __init__(
        self,
        tenant: str,
        client_id: str,
        load_tokens: Callable[[], str | None],
        save_tokens: Callable[[str | None], None],
        http: httpx.Client,
        max_file_bytes: int,
    ) -> None:
        self.tenant = tenant or "organizations"
        self.client_id = client_id
        self._load = load_tokens
        self._save = save_tokens
        self.http = http
        self.max_file_bytes = max_file_bytes

    # --- Authentification ------------------------------------------------------------------

    def start_login(self) -> tuple[DeviceCodeStart, PendingLogin]:
        resp = self._post_form(
            f"{LOGIN}/{self.tenant}/oauth2/v2.0/devicecode", {"client_id": self.client_id, "scope": SCOPES}
        )
        data = resp.json()
        if resp.status_code != 200:
            raise ConnectorError(
                "Connexion Microsoft refusée : "
                f"{data.get('error_description') or data.get('error') or resp.status_code}",
                502,
            )
        start = DeviceCodeStart(
            user_code=data["user_code"],
            verification_uri=data.get("verification_uri", "https://microsoft.com/devicelogin"),
            message=data.get("message", ""),
            expires_in=int(data.get("expires_in", 900)),
            interval=int(data.get("interval", 5)),
        )
        return start, PendingLogin(data["device_code"], start.interval, time.time() + start.expires_in)

    def poll_login(self, pending: PendingLogin) -> AuthStatus:
        if time.time() > pending.expires_at:
            return AuthStatus(status="expired", message="Le code a expiré : recommencez la connexion.")
        resp = self._post_form(
            f"{LOGIN}/{self.tenant}/oauth2/v2.0/token",
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": self.client_id,
                "device_code": pending.device_code,
            },
        )
        data = resp.json()
        if resp.status_code == 200:
            tokens = self._store(data)
            tokens.account = self._account(tokens.access_token)
            self._save(tokens.dumps())
            return AuthStatus(status="signed_in", account=tokens.account)
        error = data.get("error")
        if error in {"authorization_pending", "slow_down"}:
            return AuthStatus(status="pending")
        if error == "expired_token":
            return AuthStatus(status="expired", message="Le code a expiré : recommencez la connexion.")
        if error in {"authorization_declined", "access_denied"}:
            return AuthStatus(status="denied", message="Connexion refusée dans le navigateur.")
        return AuthStatus(status="error", message=str(data.get("error_description") or error or resp.status_code)[:300])

    def signed_in(self) -> Tokens | None:
        raw = self._load()
        if not raw:
            return None
        try:
            return Tokens.loads(raw)
        except (ValueError, KeyError):
            return None

    def _store(self, data: dict[str, Any], previous: Tokens | None = None) -> Tokens:
        return Tokens(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token") or (previous.refresh_token if previous else None),
            expires_at=time.time() + int(data.get("expires_in", 3600)) - 60,
            account=previous.account if previous else None,
        )

    def _token(self) -> str:
        tokens = self.signed_in()
        if tokens is None:
            raise ConnectorError("Connectez-vous à Microsoft 365 pour lire SharePoint.", 401)
        if time.time() < tokens.expires_at:
            return tokens.access_token
        if not tokens.refresh_token:
            self._save(None)
            raise ConnectorError("Session Microsoft expirée : reconnectez-vous.", 401)
        resp = self._post_form(
            f"{LOGIN}/{self.tenant}/oauth2/v2.0/token",
            {
                "grant_type": "refresh_token",
                "client_id": self.client_id,
                "refresh_token": tokens.refresh_token,
                "scope": SCOPES,
            },
        )
        if resp.status_code != 200:
            self._save(None)
            raise ConnectorError("Session Microsoft expirée : reconnectez-vous.", 401)
        fresh = self._store(resp.json(), tokens)
        self._save(fresh.dumps())
        return fresh.access_token

    def _account(self, access_token: str) -> str | None:
        try:
            resp = self.http.get(
                f"{GRAPH}/me",
                headers={"Authorization": f"Bearer {access_token}"},
                params={"$select": "userPrincipalName,displayName"},
            )
        except httpx.HTTPError:
            return None
        if resp.status_code != 200:
            return None
        me = resp.json()
        return me.get("userPrincipalName") or me.get("displayName")

    def _post_form(self, url: str, form: dict[str, str]) -> httpx.Response:
        try:
            return self.http.post(url, data=form)
        except httpx.HTTPError as exc:
            raise ConnectorError(f"Microsoft 365 injoignable : {short(exc)}", 502) from exc

    # --- Graph ----------------------------------------------------------------------------

    def _get(self, url: str, params: dict[str, str] | None = None) -> httpx.Response:
        try:
            resp = self.http.get(
                url if url.startswith("https://") else f"{GRAPH}{url}",
                params=params,
                headers={"Authorization": f"Bearer {self._token()}"},
            )
        except httpx.HTTPError as exc:
            raise ConnectorError(f"SharePoint injoignable : {short(exc)}", 502) from exc
        if resp.status_code == 401:
            raise ConnectorError("Session Microsoft expirée : reconnectez-vous.", 401)
        if resp.status_code == 403:
            raise ConnectorError(
                "Accès refusé par SharePoint : votre compte n'a pas le droit de lire cet élément.", 403
            )
        if resp.status_code == 404:
            raise ConnectorError("Élément SharePoint introuvable : vérifiez le lien (et vos droits d'accès).", 404)
        if resp.status_code >= 400:
            try:
                detail = resp.json().get("error", {}).get("message", "")
            except ValueError:
                detail = resp.text[:200]
            raise ConnectorError(f"Erreur SharePoint ({resp.status_code}) : {detail}", 502)
        return resp

    def test(self) -> str:
        me = self._get("/me", {"$select": "userPrincipalName,displayName"}).json()
        return str(me.get("userPrincipalName") or me.get("displayName") or "compte Microsoft")

    def _item(self, url: str) -> dict[str, Any]:
        item: dict[str, Any] = self._get(f"/shares/{share_id(url)}/driveItem").json()
        if "folder" in item:
            raise ConnectorError("Ce lien désigne un dossier : indiquez le lien d'un fichier (CSV, XLSX ou JSON).")
        return item

    def _download(self, item: dict[str, Any]) -> bytes:
        size = int(item.get("size") or 0)
        if size > self.max_file_bytes:
            raise ConnectorError(
                f"Fichier trop volumineux ({size // 1_000_000} Mo, max {self.max_file_bytes // 1_000_000} Mo).", 413
            )
        drive = item.get("parentReference", {}).get("driveId")
        if not drive:
            raise ConnectorError("Fichier SharePoint sans bibliothèque : lien non pris en charge.")
        url = f"{GRAPH}/drives/{drive}/items/{item['id']}/content"
        try:
            resp = self.http.get(url, headers={"Authorization": f"Bearer {self._token()}"}, follow_redirects=True)
        except httpx.HTTPError as exc:
            raise ConnectorError(f"Téléchargement SharePoint impossible : {short(exc)}", 502) from exc
        if resp.status_code >= 400:
            raise ConnectorError(f"Téléchargement SharePoint impossible ({resp.status_code}).", 502)
        return resp.content

    def _list(self, url: str) -> tuple[str, dict[str, Any]]:
        parsed = parse_list_url(url)
        if parsed is None:
            raise ConnectorError(
                "Adresse de liste attendue : https://<entreprise>.sharepoint.com/sites/<site>/Lists/<liste>/…"
            )
        host, path = parsed
        site = self._get(f"/sites/{host}:{path}" if path != "/" else f"/sites/{host}").json()
        lists = (
            self._get(f"/sites/{site['id']}/lists", {"$select": "id,name,displayName,webUrl"}).json().get("value", [])
        )
        target = unquote(urlsplit(url).path).lower()
        for lst in lists:
            web = unquote(urlsplit(str(lst.get("webUrl", ""))).path).lower().rstrip("/")
            if web and (target == web or target.startswith(web + "/")):
                return site["id"], lst
        raise ConnectorError("Liste SharePoint introuvable sur ce site (vérifiez l'adresse).", 404)

    def sheets(self, url: str) -> list[TableRef]:
        """Feuilles d'un classeur Excel ; [] pour un CSV, un JSON ou une liste."""
        url = check_sharepoint_url(url)
        if parse_list_url(url):
            return []
        item = self._item(url)
        if not str(item.get("name", "")).lower().endswith(".xlsx"):
            return []
        try:
            return [TableRef(name=s, kind="sheet") for s in excel_sheets(self._download(item))]
        except DatasetError as exc:
            raise ConnectorError(str(exc)) from exc

    def fetch(self, url: str, sheet: str | None, limit: int) -> tuple[pd.DataFrame, bool, str]:
        """Contenu d'un fichier ou d'une liste : (données, tronqué, nom suggéré)."""
        url = check_sharepoint_url(url)
        if parse_list_url(url):
            return self._fetch_list(url, limit)
        item = self._item(url)
        name = str(item.get("name") or "sharepoint.csv")
        try:
            detect_format(name)
            df, _ = read_table(name, self._download(item), sheet)
        except DatasetError as exc:
            raise ConnectorError(str(exc)) from exc
        return df.head(limit), len(df) > limit, name

    def _fetch_list(self, url: str, limit: int) -> tuple[pd.DataFrame, bool, str]:
        site_id, lst = self._list(url)
        base = f"/sites/{site_id}/lists/{lst['id']}"
        columns = self._get(f"{base}/columns", {"$select": "name,displayName,hidden,readOnly"}).json().get("value", [])
        keep = {
            c["name"]: c.get("displayName") or c["name"]
            for c in columns
            if not c.get("hidden") and (not c.get("readOnly") or c["name"] in {"Created", "Modified"})
        }
        rows: list[dict[str, Any]] = []
        next_url: str | None = f"{GRAPH}{base}/items?expand=fields&$top=999"
        pages = 0
        while next_url and len(rows) <= limit and pages < MAX_PAGES:
            page = self._get(next_url).json()
            for it in page.get("value", []):
                fields = it.get("fields", {})
                rows.append({keep[k]: _flat(v) for k, v in fields.items() if k in keep and k not in _SYSTEM_FIELDS})
            next_url = page.get("@odata.nextLink")
            pages += 1
        truncated = len(rows) > limit or bool(next_url)
        df = pd.DataFrame(rows[:limit])
        if df.empty:
            raise ConnectorError("La liste SharePoint est vide.")
        df = df.dropna(axis=1, how="all")
        return (
            infer_types(df.astype("object").where(df.notna(), None)),
            truncated,
            str(lst.get("displayName") or lst.get("name") or "Liste"),
        )


def _flat(value: Any) -> Any:
    """Valeur de champ de liste lisible : personnes / recherches → libellé, choix multiples → « a, b »."""
    if isinstance(value, dict):
        return (
            value.get("LookupValue")
            or value.get("Email")
            or value.get("Label")
            or json.dumps(value, ensure_ascii=False)
        )
    if isinstance(value, list):
        return ", ".join(str(_flat(v)) for v in value)
    return value
