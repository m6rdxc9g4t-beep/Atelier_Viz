"""Garde « requêtes locales » (docs/SUITE.md §5.1) : Host de bouclage, Origin locale pour les écritures."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.local_only import allowed_hosts, host_name, refusal
from main import create_app


@pytest.fixture
def strict(settings: Settings) -> Iterator[TestClient]:
    """Application sans « testserver » dans ALLOWED_HOSTS : seul le bouclage est accepté."""
    local = settings.model_copy(update={"allowed_hosts": []})
    with TestClient(create_app(local), base_url="http://127.0.0.1:8000") as client:
        yield client


def test_host_name_parsing() -> None:
    assert host_name("127.0.0.1:8000") == "127.0.0.1"
    assert host_name("LocalHost") == "localhost"
    assert host_name("[::1]:8000") == "::1"
    assert host_name("[::1]") == "::1"
    assert host_name("::1") == "::1"
    assert host_name("evil.example:80") == "evil.example"


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:5173", "[::1]:8000", "127.0.0.1", "localhost"])
def test_loopback_hosts_are_accepted(strict: TestClient, host: str) -> None:
    assert strict.get("/api/health", headers={"Host": host}).status_code == 200


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8000", "127.0.0.1.evil.example", "192.168.1.10:8000"])
def test_foreign_host_is_refused_even_for_reads(strict: TestClient, host: str) -> None:
    """DNS rebinding : un site qui pointe vers 127.0.0.1 ne lit ni ne modifie rien."""
    res = strict.get("/api/settings", headers={"Host": host})
    assert res.status_code == 403
    assert "requêtes locales" in res.json()["detail"]
    put = strict.put("/api/settings", json={"online_mode": True}, headers={"Host": host})
    assert put.status_code == 403
    assert strict.get("/api/settings").json()["online_mode"] is False


@pytest.mark.parametrize(
    "origin", ["https://evil.example", "http://evil.example:8000", "null", "file://", "pas une url"]
)
def test_foreign_origin_cannot_write(strict: TestClient, origin: str) -> None:
    res = strict.put("/api/settings", json={"online_mode": True}, headers={"Origin": origin})
    assert res.status_code == 403
    assert "Origine" in res.json()["detail"]
    assert strict.get("/api/settings").json()["online_mode"] is False


def test_foreign_origin_can_still_read_with_local_host(strict: TestClient) -> None:
    """Lecture : le navigateur n'en donne pas la réponse à un autre site (CORS) ; seul l'Host compte."""
    assert strict.get("/api/health", headers={"Origin": "https://evil.example"}).status_code == 200


@pytest.mark.parametrize("origin", [None, "http://127.0.0.1:5173", "http://localhost:8000", "http://[::1]:8000"])
def test_local_or_missing_origin_can_write(strict: TestClient, origin: str | None) -> None:
    """Interface (Vite 5173, app de bureau 8000) ou outil sans navigateur (curl : pas d'Origin)."""
    headers = {"Origin": origin} if origin else {}
    res = strict.put("/api/settings", json={"online_mode": True}, headers=headers)
    assert res.status_code == 200
    assert res.json()["online_mode"] is True


def test_vite_proxy_headers_are_accepted(strict: TestClient) -> None:
    """Proxy Vite sans `changeOrigin` : Host et Origin de l'interface de développement arrivent tels quels."""
    headers = {"Host": "127.0.0.1:5173", "Origin": "http://127.0.0.1:5173"}
    assert strict.put("/api/settings", json={"online_mode": False}, headers=headers).status_code == 200


def test_allowed_hosts_setting_extends_the_list(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALLOWED_HOSTS", "viz.local, Autre.Local:8000")
    assert Settings(_env_file=None).allowed_hosts == ["viz.local", "Autre.Local:8000"]  # type: ignore[call-arg]
    monkeypatch.setenv("ALLOWED_HOSTS", '["viz.local"]')
    assert Settings(_env_file=None).allowed_hosts == ["viz.local"]  # type: ignore[call-arg]
    assert allowed_hosts(["Autre.Local:8000"]) >= {"autre.local", "127.0.0.1", "localhost", "::1"}

    local = settings.model_copy(update={"allowed_hosts": ["viz.local"]})
    with TestClient(create_app(local), base_url="http://viz.local") as client:
        assert client.get("/api/health").status_code == 200
        put = client.put("/api/settings", json={"online_mode": False}, headers={"Origin": "http://viz.local"})
        assert put.status_code == 200
        assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 403


def test_refusal_rules() -> None:
    hosts = allowed_hosts()
    assert refusal("GET", None, None, hosts) is not None  # pas de Host : refusé
    assert refusal("GET", "127.0.0.1:8000", "https://evil.example", hosts) is None
    assert refusal("OPTIONS", "127.0.0.1:8000", "https://evil.example", hosts) is None
    for method in ("POST", "PUT", "PATCH", "DELETE"):
        assert refusal(method, "127.0.0.1:8000", "https://evil.example", hosts) is not None


def test_json_body_requires_json_content_type(client: TestClient) -> None:
    """FastAPI ≥ 0.132 : un corps JSON sans Content-Type JSON est refusé (formulaire « simple » d'un autre site)."""
    for headers in ({"Content-Type": "text/plain"}, {}):
        res = client.put("/api/settings", content=b'{"online_mode": true}', headers=headers)
        assert res.status_code == 422
    assert client.get("/api/settings").json()["online_mode"] is False
