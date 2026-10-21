# -*- mode: python ; coding: utf-8 -*-
# Paquet autonome d'Atelier Viz (PyInstaller) : lancez `python scripts/standalone/build.py`, pas ce fichier.
# macOS → « Atelier Viz.app » ; Windows → dossier « Atelier Viz » avec « Atelier Viz.exe » ; Linux → dossier « atelier-viz ».
import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

ROOT = Path(SPECPATH).resolve().parents[1]  # noqa: F821 — fourni par PyInstaller
BACKEND = ROOT / "backend"
VERSION = re.search(r'__version__ = "([^"]+)"', (BACKEND / "app" / "__init__.py").read_text(encoding="utf-8")).group(1)
NAME = "Atelier Viz" if sys.platform in ("darwin", "win32") else "atelier-viz"

datas = [
    (str(ROOT / "frontend" / "dist"), "frontend_dist"),
    (str(ROOT / "samples"), "samples"),
    (str(ROOT / "scripts" / "macos" / "icon.png"), "scripts/macos"),
]
# Paquets qui lisent leurs métadonnées ou leurs fichiers à l'exécution.
for pkg in ("keyring", "anthropic", "fastapi", "pydantic", "uvicorn", "duckdb", "openpyxl"):
    try:
        datas += copy_metadata(pkg)
    except Exception:  # noqa: BLE001 — paquet sans métadonnées : rien à copier
        pass
# Fenêtre native : Cocoa (macOS) ou WebView2 (Windows). Sous Linux, l'interface s'ouvre dans le navigateur
# par défaut (pas de Qt / GTK embarqués : le paquet resterait plusieurs fois plus lourd).
LINUX = sys.platform.startswith("linux")
WEBVIEW = [] if LINUX else ["webview"]
if not LINUX:
    datas += collect_data_files("webview")

hiddenimports = ["main"] + collect_submodules("app") + collect_submodules("uvicorn") + collect_submodules("keyring.backends") + WEBVIEW
# Pilotes des connecteurs (requirements-connectors.txt) : inclus s'ils sont installés pour la construction.
for optional in ("pymssql", "psycopg", "psycopg_binary", "pymysql"):
    try:
        __import__(optional)
        hiddenimports.append(optional)
    except ImportError:
        pass

a = Analysis(  # noqa: F821
    [str(BACKEND / "standalone.py")],
    pathex=[str(BACKEND)],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "ruff", "IPython", "matplotlib", "PyInstaller"]
    + (["webview", "PyQt5", "PyQt6", "PySide2", "PySide6", "qtpy", "gi"] if LINUX else []),
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821
icon = str(ROOT / "scripts" / "macos" / "icon.png")
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=NAME,
    console=sys.platform.startswith("linux"),  # Linux : lancé depuis un terminal ou un raccourci
    icon=icon,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name=NAME, upx=False)  # noqa: F821
if sys.platform == "darwin":
    app = BUNDLE(  # noqa: F821
        coll,
        name=f"{NAME}.app",
        icon=icon,
        bundle_identifier="fr.atelier-viz.app",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": NAME,
            "CFBundleShortVersionString": VERSION,
            "CFBundleVersion": VERSION,
            "CFBundleDevelopmentRegion": "fr",
            "LSMinimumSystemVersion": "11.0",
            "LSApplicationCategoryType": "public.app-category.business",
            "NSHighResolutionCapable": True,
            "NSHumanReadableCopyright": "Atelier Viz — BI locale",
        },
    )
