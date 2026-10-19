"""Synchronisation des rapports avec GitHub : GitHub simulé en mémoire (httpx.MockTransport), aucun réseau.

Vérifie : mode en ligne obligatoire, jeton au trousseau (jamais dans les fichiers ni les réponses),
un commit par envoi via l'API Git Data, rapports uniquement, détection de conflit par sha,
récupération sans écrasement silencieux.
"""

import base64
import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services.github import blob_sha

TOKEN = "ghp_secret_de_test_123"


class FakeGitHub:
    """Dépôt GitHub minimal : branches, commits, arbres plats, blobs ; API REST utilisée par Atelier Viz."""

    def __init__(self, owner: str = "equipe", name: str = "rapports", push: bool = True) -> None:
        self.full = f"{owner}/{name}"
        self.push = push
        self.blobs: dict[str, bytes] = {}
        self.commits: dict[str, dict[str, Any]] = {}
        self.trees: dict[str, dict[str, str]] = {}  # sha → {chemin: sha du blob}
        self.branches: dict[str, str] = {}
        self.calls: list[tuple[str, str]] = []
        self.auth: set[str] = set()
        self.commit_counter = 0
        self.race = False  # simule un commit concurrent avant la mise à jour de la branche
        root = self._tree({"README.md": self._blob(b"# Rapports\n")})
        self.branches["main"] = self._commit("Premier commit", root, [])

    # --- Stockage ---
    def _blob(self, content: bytes) -> str:
        sha = blob_sha(content)
        self.blobs[sha] = content
        return sha

    def _tree(self, files: dict[str, str]) -> str:
        sha = hashlib.sha1(json.dumps(sorted(files.items())).encode()).hexdigest()
        self.trees[sha] = dict(files)
        return sha

    def _commit(self, message: str, tree: str, parents: list[str]) -> str:
        self.commit_counter += 1
        sha = hashlib.sha1(f"{self.commit_counter}{message}{tree}".encode()).hexdigest()
        self.commits[sha] = {"message": message, "tree": tree, "parents": parents}
        return sha

    def files(self, branch: str = "main") -> dict[str, bytes]:
        tree = self.trees[self.commits[self.branches[branch]]["tree"]]
        return {path: self.blobs[sha] for path, sha in tree.items()}

    def write(self, path: str, content: bytes, message: str = "Modification sur GitHub") -> None:
        """Commit fait par quelqu'un d'autre directement sur GitHub."""
        head = self.branches["main"]
        files = dict(self.trees[self.commits[head]["tree"]])
        files[path] = self._blob(content)
        self.branches["main"] = self._commit(message, self._tree(files), [head])

    # --- HTTP ---
    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.auth.add(request.headers.get("Authorization", ""))
        path = request.url.path
        self.calls.append((request.method, path))
        if request.headers.get("Authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"message": "Bad credentials"})
        prefix = f"/repos/{self.full}"
        if path == "/user":
            return httpx.Response(200, json={"login": "francois"})
        if not path.startswith(prefix):
            return httpx.Response(404, json={"message": "Not Found"})
        rest = path[len(prefix) :]
        body = json.loads(request.content) if request.content else {}
        if rest == "" and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "default_branch": "main",
                    "permissions": {"push": self.push},
                    "html_url": f"https://github.com/{self.full}",
                },
            )
        if rest.startswith("/branches/"):
            name = rest[len("/branches/") :]
            return httpx.Response(200, json={"name": name}) if name in self.branches else httpx.Response(404, json={})
        if rest.startswith("/git/ref/heads/") and request.method == "GET":
            name = rest[len("/git/ref/heads/") :]
            if name not in self.branches:
                return httpx.Response(404, json={"message": "Not Found"})
            return httpx.Response(200, json={"object": {"sha": self.branches[name]}})
        if rest == "/git/refs" and request.method == "POST":
            self.branches[body["ref"].removeprefix("refs/heads/")] = body["sha"]
            return httpx.Response(201, json={"object": {"sha": body["sha"]}})
        if rest.startswith("/git/refs/heads/") and request.method == "PATCH":
            name = rest[len("/git/refs/heads/") :]
            if self.race:
                self.write("autre.txt", b"concurrent")
            parent = self.commits[body["sha"]]["parents"][0]
            if self.branches[name] != parent and not body.get("force"):
                return httpx.Response(422, json={"message": "Update is not a fast forward"})
            self.branches[name] = body["sha"]
            return httpx.Response(200, json={"object": {"sha": body["sha"]}})
        if rest.startswith("/git/commits/") and request.method == "GET":
            commit = self.commits[rest.split("/")[-1]]
            return httpx.Response(200, json={"tree": {"sha": commit["tree"]}})
        if rest == "/git/trees" and request.method == "POST":
            files = dict(self.trees[body["base_tree"]])
            for entry in body["tree"]:
                files[entry["path"]] = self._blob(entry["content"].encode("utf-8"))
            return httpx.Response(201, json={"sha": self._tree(files)})
        if rest == "/git/commits" and request.method == "POST":
            sha = self._commit(body["message"], body["tree"], body["parents"])
            return httpx.Response(201, json={"sha": sha, "html_url": f"https://github.com/{self.full}/commit/{sha}"})
        if rest.startswith("/git/blobs/"):
            content = self.blobs[rest.split("/")[-1]]
            return httpx.Response(200, json={"encoding": "base64", "content": base64.b64encode(content).decode()})
        if rest.startswith("/contents/"):
            folder = rest[len("/contents/") :]
            ref = request.url.params.get("ref", "main")
            commit = self.branches.get(ref, ref)
            tree = self.trees[self.commits[commit]["tree"]]
            items = [
                {"name": p.rsplit("/", 1)[-1], "type": "file", "sha": s}
                for p, s in tree.items()
                if p.rsplit("/", 1)[0] == folder and "/" in p
            ]
            return httpx.Response(200, json=items) if items else httpx.Response(404, json={"message": "Not Found"})
        return httpx.Response(404, json={"message": f"Non simulé : {request.method} {path}"})


@pytest.fixture
def github(client: TestClient) -> FakeGitHub:
    fake = FakeGitHub()
    client.app.state.github.http_factory = lambda: httpx.Client(transport=httpx.MockTransport(fake))  # type: ignore[attr-defined]
    return fake


def configure(client: TestClient, **extra: Any) -> dict:
    body = {"repo": "equipe/rapports", "branch": "main", "folder": "atelier/rapports", "token": TOKEN, **extra}
    r = client.put("/api/github", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def online(client: TestClient, value: bool = True) -> None:
    client.put("/api/settings", json={"online_mode": value})


def new_report(client: TestClient, name: str) -> dict:
    return client.post("/api/reports", json={"name": name}).json()


def rename(client: TestClient, report: dict, name: str) -> dict:
    current = client.get(f"/api/reports/{report['id']}").json()
    body = {k: current[k] for k in ("name", "dataset_id", "pages", "theme", "bookmarks")} | {"name": name}
    return client.put(f"/api/reports/{report['id']}", json=body).json()


def test_config_keeps_token_in_keyring_only(client: TestClient, settings, github: FakeGitHub) -> None:
    state = configure(client)
    assert state["has_token"] is True and state["config"]["folder"] == "atelier/rapports"
    assert TOKEN not in json.dumps(state)
    assert TOKEN not in (settings.data_dir / "github.json").read_text(encoding="utf-8")
    assert TOKEN in (settings.data_dir / "secrets.json").read_text(encoding="utf-8")  # repli « trousseau » des tests
    # Jeton absent = inchangé ; vide = effacé.
    assert configure(client, token=None)["has_token"] is True
    assert configure(client, token="")["has_token"] is False
    for bad in ({"repo": "pas-un-depot"}, {"folder": "../etc"}, {"folder": "a/.git/hooks"}, {"branch": "a..b"}):
        assert client.put("/api/github", json={"repo": "a/b", **bad}).status_code == 422
    assert client.delete("/api/github").json()["config"] is None


def test_offline_refused_without_network(client: TestClient, github: FakeGitHub) -> None:
    configure(client)
    for path in ("/api/github/test", "/api/github/push", "/api/github/pull"):
        r = client.post(path, json={})
        assert r.status_code == 403 and "hors ligne" in r.json()["detail"].lower()
    assert github.calls == []


def test_test_connection(client: TestClient, github: FakeGitHub) -> None:
    online(client)
    configure(client)
    r = client.post("/api/github/test").json()
    assert r["ok"] and r["account"] == "francois" and r["can_push"] is True
    assert client.get("/api/github").json()["account"] == "francois"
    configure(client, branch="atelier")
    assert "sera créée" in client.post("/api/github/test").json()["message"]
    github.push = False
    assert client.post("/api/github/test").json()["ok"] is False
    configure(client, token="mauvais")
    assert client.post("/api/github/test").json() == {
        "ok": False,
        "message": "Jeton GitHub refusé (expiré ou révoqué) : collez un nouveau jeton.",
        "account": None,
        "can_push": None,
        "default_branch": None,
        "repo_url": None,
    }


def test_push_one_commit_reports_only(client: TestClient, github: FakeGitHub, settings) -> None:
    online(client)
    configure(client)
    client.post("/api/datasets", files={"file": ("v.csv", b"a;b\n1;2\n", "text/csv")})  # données : jamais envoyées
    a, b = new_report(client, "Ventes"), new_report(client, "Stocks")
    states = {r["id"]: r["state"] for r in client.get("/api/github").json()["reports"]}
    assert states == {a["id"]: "new", b["id"]: "new"}

    r = client.post("/api/github/push", json={})
    assert r.status_code == 200, r.text
    res = r.json()
    assert sorted(res["pushed"]) == ["Stocks", "Ventes"] and res["commit_url"].startswith("https://github.com/")
    files = github.files()
    assert set(files) == {"README.md", f"atelier/rapports/{a['id']}.json", f"atelier/rapports/{b['id']}.json"}
    assert json.loads(files[f"atelier/rapports/{a['id']}.json"])["name"] == "Ventes"
    head = github.commits[github.branches["main"]]
    assert "2 rapport(s)" in head["message"] and "aucune donnée" in head["message"]
    assert len(github.commits) == 2  # un seul commit pour l'envoi
    assert all(TOKEN not in json.dumps(v) for v in github.commits.values())
    assert all(state == "synced" for state in (r["state"] for r in client.get("/api/github").json()["reports"]))

    # Rien de modifié : aucun commit.
    again = client.post("/api/github/push", json={}).json()
    assert again["pushed"] == [] and again["unchanged"] == 2 and len(github.commits) == 2

    rename(client, a, "Ventes 2026")
    assert {r["name"]: r["state"] for r in client.get("/api/github").json()["reports"]}["Ventes 2026"] == "modified"
    third = client.post("/api/github/push", json={"message": "Mise à jour du tableau de bord"}).json()
    assert third["pushed"] == ["Ventes 2026"] and third["unchanged"] == 1
    assert github.commits[github.branches["main"]]["message"] == "Mise à jour du tableau de bord"


def test_push_creates_missing_branch_and_detects_race(client: TestClient, github: FakeGitHub) -> None:
    online(client)
    configure(client, branch="atelier-viz")
    new_report(client, "R")
    assert client.post("/api/github/push", json={}).status_code == 200
    assert "atelier-viz" in github.branches and github.branches["atelier-viz"] != github.branches["main"]

    configure(client)  # autre branche : nouvelle base de comparaison
    github.race = True
    r = client.post("/api/github/push", json={})
    assert r.status_code == 409 and "rien n'a été écrasé" in r.json()["detail"]


def test_pull_imports_and_never_overwrites_silently(client: TestClient, github: FakeGitHub) -> None:
    online(client)
    configure(client)
    report = new_report(client, "Ventes")
    client.post("/api/github/push", json={})
    path = f"atelier/rapports/{report['id']}.json"

    # Un rapport créé ailleurs est importé.
    other = json.loads(github.files()[path])
    other |= {"id": "abcdefabcdef", "name": "Rapport d'un collègue"}
    github.write("atelier/rapports/abcdefabcdef.json", json.dumps(other).encode())
    github.write("atelier/rapports/notes.txt", b"ignore")
    github.write("atelier/rapports/0123456789ab.json", b"{pas du json")
    pulled = client.post("/api/github/pull", json={}).json()
    assert pulled["imported"] == ["Rapport d'un collègue"] and pulled["unchanged"] == 1
    assert [s["path"] for s in pulled["skipped"]] == ["atelier/rapports/0123456789ab.json"]
    assert client.get("/api/reports/abcdefabcdef").json()["name"] == "Rapport d'un collègue"

    # Modifié seulement sur GitHub : mis à jour ; l'envoi le signale comme plus récent au lieu de l'écraser.
    remote = json.loads(github.files()[path]) | {"name": "Ventes (GitHub)"}
    github.write(path, json.dumps(remote, ensure_ascii=False, indent=2).encode())
    pushed = client.post("/api/github/push", json={}).json()
    assert pushed["pushed"] == [] and pushed["remote_newer"] == ["Ventes"]
    assert client.post("/api/github/pull", json={}).json()["updated"] == ["Ventes (GitHub)"]
    assert client.get(f"/api/reports/{report['id']}").json()["name"] == "Ventes (GitHub)"

    # Modifié des deux côtés : conflit, rien n'est écrasé.
    rename(client, report, "Ventes (poste)")
    github.write(path, json.dumps(remote | {"name": "Ventes (collègue)"}, ensure_ascii=False).encode())
    conflict = client.post("/api/github/pull", json={}).json()
    assert [c["id"] for c in conflict["conflicts"]] == [report["id"]]
    assert conflict["conflicts"][0]["remote_name"] == "Ventes (collègue)"
    assert client.get(f"/api/reports/{report['id']}").json()["name"] == "Ventes (poste)"
    blocked = client.post("/api/github/push", json={}).json()
    assert [c["id"] for c in blocked["conflicts"]] == [report["id"]] and blocked["pushed"] == []
    assert json.loads(github.files()[path])["name"] == "Ventes (collègue)"

    # Choix explicite : importer une copie, puis garder ce poste et l'envoyer.
    copy = client.post("/api/github/pull", json={"resolutions": {report["id"]: "copy"}}).json()
    assert copy["copies"] == ["Ventes (collègue) (copie GitHub)"]
    assert client.get(f"/api/reports/{report['id']}").json()["name"] == "Ventes (poste)"
    assert any(r["name"] == "Ventes (collègue) (copie GitHub)" for r in client.get("/api/reports").json())
    forced = client.post("/api/github/push", json={"report_ids": [report["id"]]}).json()
    assert forced["pushed"] == ["Ventes (poste)"]
    assert json.loads(github.files()[path])["name"] == "Ventes (poste)"


def test_pull_conflict_resolutions(client: TestClient, github: FakeGitHub) -> None:
    online(client)
    configure(client)
    report = new_report(client, "R")
    client.post("/api/github/push", json={})
    path = f"atelier/rapports/{report['id']}.json"
    rename(client, report, "R local")
    github.write(path, json.dumps(json.loads(github.files()[path]) | {"name": "R distant"}).encode())

    kept = client.post("/api/github/pull", json={"resolutions": {report["id"]: "local"}}).json()
    assert kept["kept_local"] == ["R local"]
    assert client.post("/api/github/push", json={}).json()["pushed"] == ["R local"]

    rename(client, report, "R local 2")
    github.write(path, json.dumps(json.loads(github.files()[path]) | {"name": "R distant 2"}).encode())
    taken = client.post("/api/github/pull", json={"resolutions": {report["id"]: "remote"}}).json()
    assert taken["updated"] == ["R distant 2"]
    assert client.get(f"/api/reports/{report['id']}").json()["name"] == "R distant 2"


def test_pull_missing_branch_and_unconfigured(client: TestClient, github: FakeGitHub) -> None:
    online(client)
    assert client.post("/api/github/pull", json={}).status_code == 412
    configure(client, branch="inexistante")
    r = client.post("/api/github/pull", json={})
    assert r.status_code == 404 and "inexistante" in r.json()["detail"]


def test_blob_sha_matches_git() -> None:
    # `printf 'hello\n' | git hash-object --stdin`
    assert blob_sha(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"


def test_report_folder_layout(tmp_path: Path) -> None:
    from app.schemas.github import GitHubConfig

    assert GitHubConfig(repo="a/b", folder="/rapports/").folder == "rapports"
    assert GitHubConfig(repo="a/b", folder="").folder == ""
