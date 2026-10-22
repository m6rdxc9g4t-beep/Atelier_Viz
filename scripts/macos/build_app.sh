#!/usr/bin/env bash
# Crée « Atelier Viz.app » : une application macOS à double-cliquer (fenêtre native, icône dans le Dock).
#
# À lancer une fois depuis le dépôt, dans l'environnement Python du backend :
#     conda activate atelier          # ou : source backend/.venv/bin/activate
#     ./scripts/macos/build_app.sh    # → ~/Applications/Atelier Viz.app
#
# Options : ./scripts/macos/build_app.sh [dossier de destination]   (défaut : ~/Applications)
#
# L'application est un lanceur : elle exécute ce dépôt avec cet environnement Python (rien n'est copié) ;
# vos données restent dans backend/data, partagées avec le mode développement (uvicorn + npm run dev).
# Après un « git pull », relancez simplement l'application : elle se met à jour toute seule
# (docs/SUITE.md §8, backend/app/launcher.py). Ce script ne sert plus qu'à la construire une fois, ou à
# changer d'environnement Python ou d'emplacement du dépôt ; il fait aussi la première mise à jour.
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

# Première mise à jour, comme au lancement de l'application : dépendances Python (ce Python), npm ci,
# compilation de l'interface ; seulement ce qui est nécessaire, puis tampon (backend/.mise-a-jour.json).
say "1/3 · Mise à jour (dépendances et interface, $("$PY" --version 2>&1), $PY)"
(cd "$ROOT/backend" && "$PY" -m app.launcher --mettre-a-jour) \
  || fail "la mise à jour a échoué (journal : ~/Library/Logs/Atelier Viz/mise-a-jour.log)."
[[ -f "$ROOT/frontend/dist/index.html" ]] || fail "l'interface n'est pas compilée."

say "2/3 · Application ($APP)"
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
# Finder n'hérite pas du PATH du terminal : sans cela, la CLI « claude » serait introuvable ; Node / npm
# sont de plus cherchés par app/launcher.py dans le shell de connexion, Homebrew et nvm).
{
  echo '#!/bin/bash'
  echo '# Généré par scripts/macos/build_app.sh — à relancer seulement si le dépôt ou le Python changent de place.'
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
# Mise à jour automatique (docs/SUITE.md §8) : desktop.py compare l'état du dépôt au tampon de la dernière
# mise à jour réussie et, si besoin, affiche « Mise à jour… » (pip, npm ci, compilation) avant l'interface.
# Journal : ~/Library/Logs/Atelier Viz/mise-a-jour.log. Jamais de git pull, données jamais touchées.
cd "$ROOT/backend" || exit 1
echo "--- $(date '+%F %T') : lancement" >>"$LOG"
# exec : le processus Python reste celui de l'application (une seule icône dans le Dock).
exec "$PY" desktop.py "$@" >>"$LOG" 2>&1
LAUNCHER
} > "$APP/Contents/MacOS/atelier-viz"
chmod +x "$APP/Contents/MacOS/atelier-viz"

say "3/3 · Icône"
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
  • Journal en cas de souci : ~/Library/Logs/Atelier Viz/atelier-viz.log (mise à jour : mise-a-jour.log)
  • Après un git pull : relancez simplement l’application. Elle se met à jour toute seule (écran
    « Mise à jour… » : dépendances depuis package-lock.json / requirements*.txt, compilation de l’interface).
    Relancez ce script seulement si le dépôt ou l’environnement Python changent de place.
EOF
if [[ "$(uname)" == "Darwin" ]]; then open -R "$APP" || true; fi
