"""Jeton du forfait Claude (`claude setup-token`) : lu une fois, jamais montré.

Décision de l'utilisateur : « je veux que Claude forfait cli soit actif car c'est personnel ça sera mon forfait
Claude ». Sur un serveur, il n'y a pas de session `claude` connectée : la CLI isolée (`services/ai/claude_cli.py`)
s'authentifie avec le jeton d'un an que `claude setup-token` affiche, fourni au processus par la variable
d'environnement `CLAUDE_OAUTH_TOKEN` (contrat commun aux applications de la suite).

- Le jeton est lu **une seule fois**, au démarrage (`capture`), puis **retiré de l'environnement du processus** :
  aucun autre sous-processus (git, npm, pip de la mise à jour, pilote de base, autre application ouverte…) n'en
  hérite. Seule la CLI Claude le reçoit, sous le nom `CLAUDE_CODE_OAUTH_TOKEN`, et seulement pour répondre.
- Il n'est lu que dans l'environnement : ni dans `backend/.env`, ni dans `Settings`. Il n'est écrit nulle part et
  n'apparaît dans aucune réponse d'API, erreur, journal ou argument de ligne de commande (`Token` : jamais dans un
  `repr` ; `scrub` : masqué dans tout texte venu de la CLI).
- Sans cette variable, rien ne change (session `claude` de l'utilisateur, ou clé API selon `CLAUDE_MODE`).

Bibliothèque standard seulement : l'application de bureau l'importe avant sa mise à jour (aucune dépendance).
"""

from __future__ import annotations

import os
import re
import stat
from collections.abc import MutableMapping
from pathlib import Path
from typing import NoReturn

TOKEN_ENV = "CLAUDE_OAUTH_TOKEN"
"""Variable lue par Atelier Viz (la même dans toutes les applications de la suite)."""
CLI_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN"
"""Variable que lit la CLI Claude Code : posée dans SON environnement seulement."""
PRIVATE_HOME_NAME = "claude-forfait"
"""Dossier privé de la CLI en mode jeton, sous le dossier de données (`DATA_DIR`)."""
MASK = "[jeton masqué]"
_TOKEN_SHAPE = re.compile(r"sk-ant-[A-Za-z0-9_\-]{8,}")
"""Forme des jetons d'Anthropic (forfait `sk-ant-oat…`, clé `sk-ant-api…`) : masquée même si ce n'est pas le nôtre."""


class Token:
    """Jeton gardé en mémoire : sa valeur ne sort que par `reveal()`, jamais par `repr`, `str` ou un journal."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        """La valeur du jeton, pour l'environnement de la CLI seulement."""
        return self._value

    def __repr__(self) -> str:
        return "Token(***)"

    __str__ = __repr__

    def __reduce__(self) -> NoReturn:  # jamais sérialisé (pickle, copie vers un autre processus)
        raise TypeError("Le jeton du forfait Claude ne se sérialise pas.")


_captured: tuple[Token | None] | None = None
"""(jeton,) une fois l'environnement lu ; None tant qu'il ne l'a pas été."""


def capture(environ: MutableMapping[str, str] | None = None) -> Token | None:
    """Lit `CLAUDE_OAUTH_TOKEN` une seule fois et le retire de l'environnement du processus.

    Les appels suivants rendent le jeton gardé en mémoire, sans relire l'environnement. Avec `environ` (tests,
    environnement préparé à la main), rien n'est gardé : la variable est seulement retirée du dictionnaire reçu.
    """
    global _captured
    if environ is not None:
        return _take(environ)
    if _captured is None:
        _captured = (_take(os.environ),)
    return _captured[0]


def _take(environ: MutableMapping[str, str]) -> Token | None:
    raw = ""
    for name in [k for k in environ if k.upper() == TOKEN_ENV]:  # Windows : noms sans casse
        raw = raw or (environ.pop(name, "") or "").strip()
    return Token(raw) if raw else None


def forget() -> None:
    """Oublie le jeton lu (tests : chaque test repart de son propre environnement)."""
    global _captured
    _captured = None


def scrub(text: str, token: Token | None = None) -> str:
    """Le texte sans le jeton, ni rien qui ait la forme d'un jeton d'Anthropic."""
    if token is not None:
        text = text.replace(token.reveal(), MASK)
    return _TOKEN_SHAPE.sub(MASK, text)


def private_home(data_dir: Path) -> Path:
    """Dossier privé de la CLI en mode jeton (`HOME` ; `CLAUDE_CONFIG_DIR` = son `.claude`), en chemin absolu."""
    return (data_dir / PRIVATE_HOME_NAME).resolve()


def ensure_private_home(home: Path) -> Path:
    """Crée le dossier privé et son `.claude` (droits 700) ; rend le dossier de configuration de la CLI."""
    config = home / ".claude"
    for folder in (home, config):
        folder.mkdir(parents=True, exist_ok=True)
        # Hors Windows : lisible par ce seul utilisateur (sous Windows, droits du profil).
        if os.name != "nt" and stat.S_IMODE(folder.stat().st_mode) != 0o700:
            folder.chmod(0o700)
    return config
