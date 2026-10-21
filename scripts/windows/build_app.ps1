<#
.SYNOPSIS
  Installe « Atelier Viz » sous Windows : raccourcis du menu Démarrer et du Bureau (fenêtre native WebView2).

.DESCRIPTION
  À lancer une fois depuis le dépôt, dans l'environnement Python du backend :

      backend\.venv\Scripts\Activate.ps1        # ou : conda activate atelier
      .\scripts\windows\build_app.ps1            # ou double-clic sur scripts\windows\build_app.cmd

  Relancez-le après un « git pull » : il installe les dépendances et recompile l'interface.
  L'application utilise ce dépôt et cet environnement Python (rien n'est copié) : vos données restent
  dans backend\data, partagées avec le mode développement (uvicorn + npm run dev).
  Au lancement, l'application ne télécharge jamais rien (pas de « npm install », pas de « pip install »).

.PARAMETER Python
  Interpréteur Python à utiliser (défaut : celui de l'environnement actif, sinon le lanceur « py -3 »).

.PARAMETER NoDesktopShortcut
  Ne pas créer de raccourci sur le Bureau (le raccourci du menu Démarrer est toujours créé).

.PARAMETER Uninstall
  Retire les raccourcis et les réglages du lanceur. Le dépôt et vos données (backend\data) sont conservés.

.PARAMETER SkipInstall
  Ne réinstalle pas les dépendances Python et npm (réseau) : recompile seulement et recrée les raccourcis.
#>
[CmdletBinding()]
param(
  [string]$Python = $env:PYTHON,
  [switch]$NoDesktopShortcut,
  [switch]$Uninstall,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$AppName = 'Atelier Viz'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Backend = Join-Path $Root 'backend'
$Frontend = Join-Path $Root 'frontend'
$Icon = Join-Path $PSScriptRoot 'icon.ico'
$StartMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) "$AppName.lnk"
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
$LocalData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
$ConfigDir = Join-Path $LocalData $AppName
$ConfigFile = Join-Path $ConfigDir 'launcher.json'
$LogFile = Join-Path $ConfigDir 'Logs\atelier-viz.log'

function Say([string]$Text) { Write-Host $Text -ForegroundColor Cyan }
function Fail([string]$Text) {
  Write-Host "Erreur : $Text" -ForegroundColor Red
  if ($env:GITHUB_ACTIONS -eq 'true') { Write-Host "::error title=build_app.ps1::$Text" }
  exit 1
}

# --- Désinstallation ----------------------------------------------------------------------------
if ($Uninstall) {
  foreach ($item in @($StartMenuLink, $DesktopLink, $ConfigFile)) {
    if (Test-Path -LiteralPath $item) {
      Remove-Item -LiteralPath $item -Force
      Write-Host "Supprimé : $item"
    }
  }
  Say "Raccourcis retirés. Le dépôt et vos données (backend\data) sont conservés."
  exit 0
}

# --- Python -------------------------------------------------------------------------------------
# Exécutable « python » de l'environnement actif ; jamais l'alias du Microsoft Store (WindowsApps),
# qui ouvre le Store au lieu de lancer Python.
$PyExe = $null
$PyPre = @()
if ($Python) {
  $PyExe = $Python
} else {
  $found = Get-Command python -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -First 1
  if ($found) {
    $PyExe = $found.Source
  } elseif (Get-Command py -CommandType Application -ErrorAction SilentlyContinue) {
    $PyExe = 'py'
    $PyPre = @('-3')
  }
}
if (-not $PyExe) {
  Fail "Python introuvable. Installez Python 3.12 ou 3.13 (https://www.python.org/downloads/windows/) ou activez l'environnement du backend (backend\.venv\Scripts\Activate.ps1)."
}
$Py = (& $PyExe @PyPre -c 'import sys; print(sys.executable)' | Select-Object -First 1)
if (-not $Py -or -not (Test-Path -LiteralPath $Py)) { Fail "Python ne répond pas ($PyExe)." }
$Py = $Py.Trim()
& $Py -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
if ($LASTEXITCODE -ne 0) {
  $version = & $Py --version
  Fail "Python 3.11 ou plus récent requis ($version, $Py)."
}
$PyW = Join-Path (Split-Path -Parent $Py) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $PyW)) { Fail "pythonw.exe introuvable à côté de $Py : cet environnement Python ne convient pas." }

# --- 1/4 Dépendances Python ---------------------------------------------------------------------
$step = (& $Py --version)
Say "1/4 · Dépendances Python ($step, $Py)"
if (-not $SkipInstall) {
  & $Py -m pip install --quiet --disable-pip-version-check `
    -r (Join-Path $Backend 'requirements.txt') -r (Join-Path $Backend 'requirements-desktop.txt')
  if ($LASTEXITCODE -ne 0) {
    Fail "l'installation des dépendances Python a échoué (pywebview a besoin de pythonnet : préférez Python 3.12 ou 3.13)."
  }
}

# --- 2/4 Interface ------------------------------------------------------------------------------
Say '2/4 · Interface (npm run build)'
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npm) { Fail "npm introuvable : installez Node.js LTS (https://nodejs.org)." }

# Réseau d'entreprise qui inspecte le HTTPS (proxy avec son propre certificat racine) : npm ne connaît que
# ses propres autorités et échoue (SELF_SIGNED_CERT_IN_CHAIN). On lui fait utiliser le magasin de certificats
# de Windows — celui que Git, pip et le navigateur utilisent déjà —, sans jamais désactiver la vérification.
function Test-NodeSystemCa {
  $ErrorActionPreference = 'Continue'
  $node = Join-Path (Split-Path -Parent $npm.Source) 'node.exe'
  if (-not (Test-Path -LiteralPath $node)) { return $false }
  & $node --use-system-ca -e '0' 2>$null
  return ($LASTEXITCODE -eq 0)
}
if (Test-NodeSystemCa) {
  if (-not $env:NODE_OPTIONS) { $env:NODE_OPTIONS = '--use-system-ca' }
  elseif ($env:NODE_OPTIONS -notlike '*--use-system-ca*') { $env:NODE_OPTIONS = "$env:NODE_OPTIONS --use-system-ca" }
}
Push-Location $Frontend
try {
  if (-not $SkipInstall) {
    & $npm.Source install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) {
      Fail ("npm install a échoué. Sur un réseau d'entreprise, vérifiez que Node.js est à jour (22.15 ou plus " +
        "récent : winget upgrade OpenJS.NodeJS.LTS) ; sinon, demandez au service informatique le certificat " +
        "racine du proxy et indiquez son chemin dans la variable NODE_EXTRA_CA_CERTS.")
    }
  }
  & $npm.Source run build --silent
  if ($LASTEXITCODE -ne 0) { Fail "la compilation de l'interface a échoué." }
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath (Join-Path $Frontend 'dist\index.html'))) { Fail "la compilation de l'interface a échoué." }

# --- 3/4 Réglages du lanceur --------------------------------------------------------------------
# PATH figé au moment de l'installation : le lanceur le reprend (CLI « claude », node / npm, DLL d'un
# environnement conda), comme le lanceur macOS. Aucun secret n'est écrit ici.
Say "3/4 · Réglages du lanceur ($ConfigFile)"
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$settings = [ordered]@{
  root    = $Root
  python  = $PyW
  path    = $env:PATH
  built   = (Get-Date).ToString('s')
}
$json = $settings | ConvertTo-Json
[System.IO.File]::WriteAllText($ConfigFile, $json, (New-Object System.Text.UTF8Encoding($false)))

# --- 4/4 Raccourcis -----------------------------------------------------------------------------
Say '4/4 · Raccourcis'
$shell = New-Object -ComObject WScript.Shell
$links = @($StartMenuLink)
if (-not $NoDesktopShortcut) { $links += $DesktopLink }
foreach ($link in $links) {
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.TargetPath = $PyW
  # -X utf8 : fichiers et sous-processus en UTF-8, quelle que soit la page de code de Windows.
  $shortcut.Arguments = '-X utf8 -m app.windows_launcher'
  $shortcut.WorkingDirectory = $Backend
  $shortcut.IconLocation = "$Icon,0"
  $shortcut.Description = 'Atelier Viz — BI locale'
  $shortcut.Save()
  Write-Host "  $link"
}

# --- Moteur d'affichage ---------------------------------------------------------------------------
$webview2 = $null
$clients = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
foreach ($key in $clients) {
  $item = Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue
  if ($item -and $item.pv -and $item.pv -ne '0.0.0.0') { $webview2 = $item.pv; break }
}

Write-Host ''
Say "✓ $AppName est prête."
Write-Host @"

  • Menu Démarrer → « $AppName » (clic droit → Épingler à la barre des tâches pour la garder).
  • Journal en cas de souci : $LogFile
  • Après une mise à jour du code (git pull) : l'interface est recompilée au lancement si besoin
    (npm run build, sans réseau) ; relancez ce script si des dépendances (npm ou Python) ont changé.
  • Désinstaller : .\scripts\windows\build_app.ps1 -Uninstall (vos données sont conservées).
"@
if (-not $webview2) {
  Write-Host "  ! Moteur Microsoft Edge WebView2 introuvable : installez « WebView2 Runtime »" -ForegroundColor Yellow
  Write-Host "    (https://developer.microsoft.com/microsoft-edge/webview2/), sinon la fenêtre ne s'ouvrira pas." -ForegroundColor Yellow
}
