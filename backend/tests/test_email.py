"""E-mail des alertes : configuration (mot de passe au trousseau), politique hors ligne, envoi simulé,
en-têtes sans injection, déclenchement d'une alerte, API.
"""

import asyncio
import smtplib
from datetime import UTC, datetime
from email.message import EmailMessage
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.schemas.alert import AlertInput
from app.schemas.email import EmailConfig, EmailConfigInput
from app.services.alerts import AlertService
from app.services.connectors.secrets import FileSecrets
from app.services.email import EmailError, EmailService, one_line, smtp_send
from tests.test_alerts import alert_body, upload


class Outbox:
    """Serveur d'envoi simulé : retient (configuration, IP de connexion, mot de passe, message)."""

    def __init__(self, fail: Exception | None = None) -> None:
        self.sent: list[tuple[EmailConfig, str | None, str | None, EmailMessage]] = []
        self.fail = fail

    def __call__(self, config: EmailConfig, pinned: str | None, password: str | None, message: EmailMessage) -> None:
        if self.fail:
            raise self.fail
        self.sent.append((config, pinned, password, message))


def make(tmp_path: Path, online: bool = False, resolver=lambda host: "10.0.0.5", outbox: Outbox | None = None):  # type: ignore[no-untyped-def]
    box = outbox or Outbox()
    secrets = FileSecrets(tmp_path / "secrets.json")
    svc = EmailService(tmp_path / "email.json", secrets, is_online=lambda: online, sender=box, resolver=resolver)
    return svc, box, secrets


CONFIG = {"host": "smtp.entreprise.lan", "port": 587, "username": "alertes", "from_addr": "alertes@entreprise.fr"}


def test_config_keeps_password_in_keyring_and_forgets_it_on_host_change(tmp_path: Path) -> None:
    svc, _, secrets = make(tmp_path)
    state = svc.configure(EmailConfigInput.model_validate({**CONFIG, "password": "s3cret"}))
    assert state.has_password and state.config and state.config.host == "smtp.entreprise.lan"
    assert "s3cret" not in (tmp_path / "email.json").read_text(encoding="utf-8")
    # Même serveur, mot de passe absent : gardé.
    assert svc.configure(EmailConfigInput.model_validate({**CONFIG, "port": 2525})).has_password
    # Autre serveur sans nouveau mot de passe : jamais réutilisé.
    assert not svc.configure(EmailConfigInput.model_validate({**CONFIG, "host": "smtp.autre.fr"})).has_password
    assert svc.forget().config is None


def test_offline_pins_private_ip_and_refuses_internet(tmp_path: Path) -> None:
    svc, box, _ = make(tmp_path)
    svc.configure(EmailConfigInput.model_validate({**CONFIG, "password": "p"}))
    svc.send(["direction@entreprise.fr"], "Alerte", "Corps")
    config, pinned, password, msg = box.sent[0]
    assert pinned == "10.0.0.5" and password == "p" and msg["To"] == "direction@entreprise.fr"

    public, _, _ = make(tmp_path / "pub", resolver=lambda host: None)
    (tmp_path / "pub").mkdir()
    public.configure(EmailConfigInput.model_validate({**CONFIG, "host": "smtp.gmail.com"}))
    with pytest.raises(EmailError) as err:
        public.send(["a@b.fr"], "x", "y")
    assert err.value.status_code == 403

    online, obox, _ = make(tmp_path / "on", online=True, resolver=lambda host: None)
    (tmp_path / "on").mkdir()
    online.configure(EmailConfigInput.model_validate({**CONFIG, "host": "smtp.gmail.com"}))
    online.send(["a@b.fr"], "x", "y")
    assert obox.sent[0][1] is None  # en ligne : résolution normale


def test_plaintext_login_to_internet_is_refused(tmp_path: Path) -> None:
    svc, _, _ = make(tmp_path, online=True, resolver=lambda host: None)
    svc.configure(
        EmailConfigInput.model_validate({**CONFIG, "host": "smtp.exemple.fr", "security": "none", "port": 25})
    )
    with pytest.raises(EmailError, match="non chiffrée"):
        svc.send(["a@b.fr"], "x", "y")


def test_headers_cannot_be_injected() -> None:
    assert one_line("CA\r\nBcc: espion@x.fr") == "CA Bcc: espion@x.fr"
    with pytest.raises(ValueError):
        EmailConfig.model_validate({**CONFIG, "from_addr": "a@b.fr\r\nBcc: c@d.fr"})
    with pytest.raises(ValueError):
        AlertInput.model_validate(alert_body("a" * 12, email_to=["Nom <a@b.fr>"]))


def test_alert_sends_one_email_on_crossing(client: TestClient, tmp_path: Path) -> None:
    ds = upload(client)
    svc, box, _ = make(tmp_path)
    svc.configure(EmailConfigInput.model_validate(CONFIG))
    app = client.app  # type: ignore[attr-defined]
    alerts = AlertService(
        tmp_path / "alertes.json",
        app.state.dataset_store,
        app.state.database,
        is_online=lambda: False,
        clock=lambda: datetime(2026, 11, 9, 8, 0, tzinfo=UTC),
        email=svc,
    )
    name = "CA élevé\nBcc: espion@x.fr"
    a = alerts.create(
        AlertInput.model_validate(
            {**alert_body(ds, notify=False, system=False), "name": name, "email_to": ["dg@entreprise.fr"]}
        )
    )
    res = asyncio.run(alerts.evaluate(a.id, "refresh"))
    assert res.history[0].fired and res.history[0].email_sent == 1 and res.history[0].email_error is None
    msg = box.sent[0][3]
    assert "\n" not in msg["Subject"] and "Bcc" not in msg.keys()
    assert "180" in msg.get_content()
    # Condition toujours vraie : pas de second e-mail (anti-rebond).
    asyncio.run(alerts.evaluate(a.id, "refresh"))
    assert len(box.sent) == 1


def test_alert_email_error_is_recorded(client: TestClient, tmp_path: Path) -> None:
    ds = upload(client)
    svc, _, _ = make(tmp_path, outbox=Outbox(fail=EmailError("Envoi impossible : SMTPServerDisconnected.", 502)))
    svc.configure(EmailConfigInput.model_validate(CONFIG))
    app = client.app  # type: ignore[attr-defined]
    alerts = AlertService(
        tmp_path / "a.json", app.state.dataset_store, app.state.database, is_online=lambda: False, email=svc
    )
    a = alerts.create(AlertInput.model_validate(alert_body(ds, email_to=["dg@entreprise.fr"])))
    res = asyncio.run(alerts.evaluate(a.id, "refresh"))
    assert res.history[0].email_error and "SMTPServerDisconnected" in res.history[0].email_error


def test_smtp_errors_are_readable(monkeypatch: pytest.MonkeyPatch) -> None:
    class Refusing(smtplib.SMTP):
        def connect(self, host="localhost", port=0, source_address=None):  # type: ignore[no-untyped-def]
            raise ConnectionRefusedError

    monkeypatch.setattr("app.services.email.smtplib.SMTP", Refusing)
    with pytest.raises(EmailError, match="ConnectionRefusedError"):
        smtp_send(EmailConfig.model_validate(CONFIG), None, None, EmailMessage())


def test_email_api(client: TestClient) -> None:
    assert client.get("/api/email").json() == {"config": None, "has_password": False}
    r = client.put("/api/email", json={**CONFIG, "password": "p"})
    assert r.status_code == 200 and r.json()["has_password"] is True and "password" not in r.json()["config"]
    assert client.put("/api/email", json={**CONFIG, "from_addr": "pas une adresse"}).status_code == 422
    # Hors ligne, serveur introuvable (pas de DNS en test) : refusé avant tout envoi.
    res = client.post("/api/email/test", json={"to": ["a@b.fr"]})
    assert res.status_code == 403
    assert client.post("/api/email/test", json={"to": []}).status_code == 422
    assert client.delete("/api/email").json()["config"] is None


def test_online_still_connects_to_the_validated_private_ip(tmp_path: Path) -> None:
    """En ligne aussi, un serveur privé validé reçoit la connexion à cette IP (pas de seconde résolution :
    une connexion non chiffrée avec identifiant ne peut pas être détournée vers Internet)."""
    svc, box, _ = make(tmp_path, online=True)
    svc.configure(EmailConfigInput.model_validate({**CONFIG, "security": "none", "port": 25, "password": "p"}))
    svc.send(["a@b.fr"], "x", "y")
    assert box.sent[0][1] == "10.0.0.5"


def test_bracketed_ipv6_host_is_normalized() -> None:
    assert EmailConfig.model_validate({**CONFIG, "host": "[::1]"}).host == "::1"
    with pytest.raises(ValueError):
        EmailConfig.model_validate({**CONFIG, "host": "a[b]"})


def test_accented_credentials_give_a_readable_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class Ascii(smtplib.SMTP):
        def connect(self, host="localhost", port=0, source_address=None):  # type: ignore[no-untyped-def]
            return (220, b"ok")

        def starttls(self, *a, **k):  # type: ignore[no-untyped-def]
            return (220, b"ok")

        def login(self, user, password, *, initial_response_ok=True):  # type: ignore[no-untyped-def]
            password.encode("ascii")  # comme smtplib (AUTH PLAIN / LOGIN)

        def close(self) -> None:
            pass

    monkeypatch.setattr("app.services.email.smtplib.SMTP", Ascii)
    with pytest.raises(EmailError, match="sans accent"):
        smtp_send(EmailConfig.model_validate(CONFIG), None, "mötdepasse", EmailMessage())


def test_unexpected_send_error_never_breaks_the_alert(client: TestClient, tmp_path: Path) -> None:
    ds = upload(client)
    svc, _, _ = make(tmp_path, outbox=Outbox(fail=RuntimeError("imprévu")))
    svc.configure(EmailConfigInput.model_validate(CONFIG))
    app = client.app  # type: ignore[attr-defined]
    alerts = AlertService(
        tmp_path / "a.json", app.state.dataset_store, app.state.database, is_online=lambda: False, email=svc
    )
    a = alerts.create(AlertInput.model_validate(alert_body(ds, email_to=["dg@entreprise.fr"])))
    res = asyncio.run(alerts.evaluate(a.id, "refresh"))
    assert res.history[0].fired and res.history[0].email_error == "Envoi impossible : RuntimeError."
