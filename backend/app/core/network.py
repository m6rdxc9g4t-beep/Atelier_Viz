"""Adresses locales : la machine elle-même (bouclage), sans dépendance vers les services.

Partagé par les schémas (validation de forme) et les connecteurs (contrôle après résolution).
"""

import ipaddress

LOOPBACK_NAMES = frozenset({"localhost"})


def is_loopback_ip(raw: str) -> bool:
    """Vrai si `raw` est une adresse IP de bouclage (127.0.0.0/8, ::1, ::ffff:127.x.x.x)."""
    try:
        ip = ipaddress.ip_address(raw.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def is_loopback_host(host: str) -> bool:
    """Vrai si `host` s'écrit comme la machine elle-même : `localhost` ou une adresse de bouclage.

    Contrôle de forme seulement (sans résolution) : sert à la validation des schémas.
    """
    name = host.strip().strip("[]").lower()
    return name in LOOPBACK_NAMES or is_loopback_ip(name)


def loopback_refusal(host: str, what: str) -> str:
    """Message de refus d'une adresse non locale."""
    return (
        f"{what} doit tourner sur cette machine : « {host} » n'est pas une adresse locale. "
        "Utilisez 127.0.0.1, localhost ou ::1 (par exemple http://127.0.0.1:3000)."
    )
