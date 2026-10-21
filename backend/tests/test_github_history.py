"""Historique GitHub d'un rapport, aperçu et restauration d'une version ; GitHub Enterprise (URL d'API)."""

import base64
import json
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.schemas.github import GitHubConfig
from tests.test_github import TOKEN, FakeGitHub, configure, new_report, online, rename


class HistoryGitHub(FakeGitHub):
    """Ajoute l'historique d'un fichier (`/commits?path=`) et la lecture d'un fichier à un commit."""

    def __init__(self, base_path: str = "") -> None:
        super().__init__()
        self.base_path = base_path
        self.hosts: set[str] = set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.hosts.add(request.url.host)
        path = request.url.path.removeprefix(self.base_path)
        prefix = f"/repos/{self.full}"
        if request.headers.get("Authorization") == f"Bearer {TOKEN}" and path.startswith(prefix):
            rest = path[len(prefix) :]
            if rest == "/commits":
                return self._history(request.url.params["path"], request.url.params.get("sha", "main"))
            if rest.startswith("/contents/") and rest.endswith(".json"):
                return self._file(rest[len("/contents/") :], request.url.params.get("ref", "main"))
        if self.base_path:
            request = httpx.Request(
                request.method, request.url.copy_with(path=path), headers=request.headers, content=request.content
            )
        return super().__call__(request)

    def _blob_at(self, commit: str, path: str) -> str | None:
        return self.trees[self.commits[commit]["tree"]].get(path)

    def _history(self, path: str, branch: str) -> httpx.Response:
        out: list[dict[str, Any]] = []
        sha: str | None = self.branches[branch]
        while sha:
            commit = self.commits[sha]
            parent = commit["parents"][0] if commit["parents"] else None
            if self._blob_at(sha, path) != (self._blob_at(parent, path) if parent else None):
                out.append(
                    {
                        "sha": sha,
                        "html_url": f"https://github.com/{self.full}/commit/{sha}",
                        "commit": {
                            "message": commit["message"],
                            "author": {"name": "François", "date": "2026-10-20T08:00:00Z"},
                        },
                    }
                )
            sha = parent
        return httpx.Response(200, json=out)

    def _file(self, path: str, ref: str) -> httpx.Response:
        commit = self.branches.get(ref, ref)
        if commit not in self.commits or (blob := self._blob_at(commit, path)) is None:
            return httpx.Response(404, json={"message": "Not Found"})
        content = base64.b64encode(self.blobs[blob]).decode()
        return httpx.Response(200, json={"type": "file", "encoding": "base64", "content": content, "sha": blob})


@pytest.fixture
def github(client: TestClient) -> HistoryGitHub:
    fake = HistoryGitHub()
    client.app.state.github.http_factory = lambda: httpx.Client(transport=httpx.MockTransport(fake))  # type: ignore[attr-defined]
    return fake


def test_history_preview_and_restore(client: TestClient, github: HistoryGitHub) -> None:
    online(client)
    configure(client)
    report = new_report(client, "Ventes v1")
    assert client.post("/api/github/push", json={}).status_code == 200
    rename(client, report, "Ventes v2")
    assert client.post("/api/github/push", json={"message": "Deuxième version"}).status_code == 200
    rename(client, report, "Ventes v3 (locale)")

    versions = client.get(f"/api/github/reports/{report['id']}/history").json()
    assert [v["message"] for v in versions] == ["Deuxième version", "Atelier Viz : 1 rapport(s) mis à jour"]
    assert versions[0]["author"] == "François" and versions[0]["url"].startswith("https://github.com/")
    first = versions[1]["sha"]
    preview = client.get(f"/api/github/reports/{report['id']}/versions/{first}").json()
    assert preview["name"] == "Ventes v1" and preview["pages"] == ["Page 1"] and preview["visuals"] == 0

    # Restaurer en copie : le rapport local ne bouge pas.
    copy = client.post(f"/api/github/reports/{report['id']}/restore", json={"sha": first, "as_copy": True}).json()
    assert copy["report_id"] != report["id"] and copy["name"] == f"Ventes v1 (version {first[:7]})"
    assert client.get(f"/api/reports/{report['id']}").json()["name"] == "Ventes v3 (locale)"
    # Restaurer : retour en arrière local, à envoyer ensuite (aucun appel d'écriture vers GitHub).
    writes_before = [c for c in github.calls if c[0] != "GET"]
    restored = client.post(f"/api/github/reports/{report['id']}/restore", json={"sha": first}).json()
    assert "rétabli" in restored["message"] and [c for c in github.calls if c[0] != "GET"] == writes_before
    assert client.get(f"/api/reports/{report['id']}").json()["name"] == "Ventes v1"
    states = {r["id"]: r["state"] for r in client.get("/api/github").json()["reports"]}
    assert states[report["id"]] == "modified"
    pushed = client.post("/api/github/push", json={}).json()
    assert sorted(pushed["pushed"]) == ["Ventes v1", copy["name"]]  # la copie est un nouveau rapport
    assert json.loads(github.files()[f"atelier/rapports/{report['id']}.json"])["name"] == "Ventes v1"


def test_history_errors(client: TestClient, github: HistoryGitHub) -> None:
    configure(client)
    assert client.get("/api/github/reports/0123456789ab/history").status_code == 403  # hors ligne
    online(client)
    assert client.get("/api/github/reports/0123456789ab/history").json() == []
    assert client.get("/api/github/reports/pas-un-id/history").status_code == 422
    assert client.get("/api/github/reports/0123456789ab/versions/zzz").status_code == 422
    r = client.post("/api/github/reports/0123456789ab/restore", json={"sha": "a" * 40})
    assert r.status_code == 404 and "n'existe pas" in r.json()["detail"]
    assert client.post("/api/github/reports/0123456789ab/restore", json={"sha": "x"}).status_code == 422


def test_enterprise_api_url(client: TestClient) -> None:
    fake = HistoryGitHub(base_path="/api/v3")
    client.app.state.github.http_factory = lambda: httpx.Client(transport=httpx.MockTransport(fake))  # type: ignore[attr-defined]
    online(client)
    state = configure(client, api_url="https://github.entreprise.fr/api/v3/")
    assert state["config"]["api_url"] == "https://github.entreprise.fr/api/v3"
    assert client.post("/api/github/test").json()["ok"] is True
    new_report(client, "Ventes")
    pushed = client.post("/api/github/push", json={}).json()
    assert pushed["pushed"] == ["Ventes"] and fake.hosts == {"github.entreprise.fr"}
    for bad in (
        "http://github.entreprise.fr/api/v3",
        "https://jeton@github.entreprise.fr",
        "https://x.fr/api?a=1",
        "ftp://x",
    ):
        assert client.put("/api/github", json={"repo": "a/b", "api_url": bad}).status_code == 422
    assert GitHubConfig(repo="a/b", api_url="https://ghe.local/api/v3").web_url == "https://ghe.local"
    assert GitHubConfig(repo="a/b").web_url == "https://github.com" and not GitHubConfig(repo="a/b").enterprise
    assert GitHubConfig(repo="a/b", api_url="http://localhost:8080/api/v3").api_url.startswith("http://localhost")
