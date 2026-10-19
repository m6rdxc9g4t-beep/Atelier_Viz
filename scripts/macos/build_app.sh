#!/usr/bin/env bash
# Crée « Atelier Viz.app » : une application macOS à double-cliquer (fenêtre native, icône dans le Dock).
#
# À lancer une fois depuis le dépôt, dans l'environnement Python du backend :
#     conda activate atelier          # ou : source backend/.venv/bin/activate
#     ./scripts/macos/build_app.sh    # → ~/Applications/Atelier Viz.app
#
# Options : ./scripts/macos/build_app.sh [dossier de destination]   (défaut : ~/Applications)
# Relancez le script après un « git pull » : il recompile l'interface et met l'application à jour.
#
# L'application utilise ce dépôt et cet environnement Python (rien n'est copié) : vos données
# restent dans backend/data, partagées avec le mode développement (uvicorn + npm run dev).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/Atelier Viz.app"
PY="${PYTHON:-$(command -v python3 || command -v python || true)}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

if [[ "$(uname)" != "Darwin" && "${ATELIER_BUILD_ANY_OS:-}" != "1" ]]; then
  fail "ce script construit une application macOS : lancez-le sur le Mac."
fi
[[ -n "$PY" ]] || fail "Python introuvable. Activez l'environnement du backend (conda activate atelier)."
PY="$("$PY" -c 'import sys; print(sys.executable)')"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "Python 3.11 ou plus récent requis ($("$PY" --version 2>&1)). Activez l'environnement : conda activate atelier"
command -v npm >/dev/null || fail "npm introuvable : installez Node.js (https://nodejs.org)."

say "1/4 · Dépendances Python ($("$PY" --version 2>&1), $PY)"
"$PY" -m pip install --quiet --disable-pip-version-check \
  -r "$ROOT/backend/requirements.txt" -r "$ROOT/backend/requirements-desktop.txt"

say "2/4 · Interface (npm run build)"
(cd "$ROOT/frontend" && npm install --no-audit --no-fund --loglevel=error && npm run build --silent)
[[ -f "$ROOT/frontend/dist/index.html" ]] || fail "la compilation de l'interface a échoué."

say "3/4 · Application ($APP)"
VERSION="$("$PY" -c "import re,sys; print(re.search(r'__version__ = \"([^\"]+)\"', open(sys.argv[1]).read()).group(1))" "$ROOT/backend/app/__init__.py")"
mkdir -p "$DEST"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Atelier Viz</string>
  <key>CFBundleDisplayName</key><string>Atelier Viz</string>
  <key>CFBundleIdentifier</key><string>fr.atelier-viz.app</string>
  <key>CFBundleExecutable</key><string>atelier-viz</string>
  <key>CFBundleIconFile</key><string>AtelierViz</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleDevelopmentRegion</key><string>fr</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.business</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Atelier Viz — BI locale</string>
</dict>
</plist>
PLIST

# Lanceur : chemins et PATH figés au moment de la construction (une application lancée depuis le
# Finder n'hérite pas du PATH du terminal : sans cela, la CLI « claude » serait introuvable).
{
  echo '#!/bin/bash'
  echo '# Généré par scripts/macos/build_app.sh — relancez ce script pour mettre à jour.'
  printf 'ROOT=%q\n' "$ROOT"
  printf 'PY=%q\n' "$PY"
  printf 'export PATH=%q\n' "$PATH"
  cat <<'LAUNCHER'
LOG_DIR="$HOME/Library/Logs/Atelier Viz"
LOG="$LOG_DIR/atelier-viz.log"
mkdir -p "$LOG_DIR"
# Journal limité : l'ancien est gardé une fois (atelier-viz.log.1).
if [[ -f "$LOG" && $(stat -f%z "$LOG" 2>/dev/null || stat -c%s "$LOG") -gt 5000000 ]]; then mv -f "$LOG" "$LOG.1"; fi

alert() {
  /usr/bin/osascript -e "display alert \"Atelier Viz\" message \"$1\" as critical" >/dev/null 2>&1 || echo "$1" >&2
}
if [[ ! -f "$ROOT/backend/desktop.py" || ! -x "$PY" ]]; then
  alert "Le dépôt ($ROOT) ou son environnement Python a changé de place. Relancez scripts/macos/build_app.sh."
  exit 1
fi
if ! "$PY" -c 'import importlib.util as u, sys; sys.exit(0 if all(u.find_spec(m) for m in ("fastapi", "uvicorn", "duckdb", "webview")) else 1)'; then
  alert "Des modules Python manquent dans $PY. Relancez scripts/macos/build_app.sh."
  exit 1
fi
cd "$ROOT/backend" || exit 1
echo "--- $(date '+%F %T') : lancement" >>"$LOG"
# exec : le processus Python reste celui de l'application (une seule icône dans le Dock).
exec "$PY" desktop.py "$@" >>"$LOG" 2>&1
LAUNCHER
} > "$APP/Contents/MacOS/atelier-viz"
chmod +x "$APP/Contents/MacOS/atelier-viz"

say "4/4 · Icône"
ICON_SRC="$ROOT/scripts/macos/icon.png"
if command -v iconutil >/dev/null && command -v sips >/dev/null; then
  SET="$(mktemp -d)/AtelierViz.iconset"
  mkdir -p "$SET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ICON_SRC" --out "$SET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$ICON_SRC" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/AtelierViz.icns"
  rm -rf "$(dirname "$SET")"
else
  cp "$ICON_SRC" "$APP/Contents/Resources/AtelierViz.png"  # hors macOS (essais) : pas d'icns
fi
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
touch "$APP"

say "✓ Atelier Viz.app est prête : $APP"
cat <<EOF

  • Double-cliquez sur « Atelier Viz » dans le Finder (dossier Applications de votre compte),
    ou lancez-la avec Spotlight (⌘ Espace, « Atelier Viz »).
  • Pour la garder dans le Dock : clic droit sur son icône pendant qu'elle tourne → Options → Garder dans le Dock.
  • Journal en cas de souci : ~/Library/Logs/Atelier Viz/atelier-viz.log
  • Après une mise à jour du code (git pull) : relancez ce script.
EOF
if [[ "$(uname)" == "Darwin" ]]; then open -R "$APP" || true; fi
