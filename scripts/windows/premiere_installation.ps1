<#
.SYNOPSIS
  Première installation d'Atelier Viz sur un PC Windows vierge (rien n'est nécessaire au départ).

.DESCRIPTION
  Ce script fait tout, dans l'ordre :
    1. installe ce qui manque avec winget (le gestionnaire de logiciels de Windows) :
       Git, Python 3.13, Node.js LTS — et, si vous le souhaitez, Claude Code et Ollama ;
    2. récupère le dépôt privé Atelier_Viz depuis GitHub (une fenêtre de connexion GitHub s'ouvre) ;
    3. crée l'environnement Python du backend (backend\.venv) ;
    4. lance scripts\windows\build_app.ps1 : dépendances, interface, raccourcis du menu Démarrer.

  Lancement, depuis PowerShell (menu Démarrer → « PowerShell ») :

      powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\premiere_installation.ps1"

  Windows demandera plusieurs fois l'autorisation d'installer (« Voulez-vous autoriser… ? » → Oui).
  Le script peut être relancé sans risque : ce qui est déjà installé est conservé.

.PARAMETER Dossier
  Où placer le dépôt (défaut : <dossier personnel>\Atelier_Viz). Ignoré si le script est lancé depuis le dépôt.

.PARAMETER Branche
  Branche à utiliser (défaut : main, ou claude/windows tant que la version Windows n'y est pas fusionnée).

.PARAMETER Claude
  Installer Claude Code sans le demander. -SansClaude : ne pas l'installer.

.PARAMETER Ollama
  Installer Ollama (IA locale) sans le demander. -SansOllama : ne pas l'installer.

.PARAMETER NonInteractif
  Aucune question ni pause (intégration continue) : Claude Code et Ollama ne sont installés que s'ils sont demandés.
#>
[CmdletBinding()]
param(
  [string]$Dossier = (Join-Path $HOME 'Atelier_Viz'),
  [string]$Branche = '',
  [switch]$Claude,
  [switch]$SansClaude,
  [switch]$Ollama,
  [switch]$SansOllama,
  [switch]$NonInteractif
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Depot = 'https://github.com/m6rdxc9g4t-beep/Atelier_Viz.git'
$WingetOk = @(0, -1978335189, -1978335135)  # succès, « déjà à jour », « déjà installé »

function Titre([string]$Texte) { Write-Host ''; Write-Host $Texte -ForegroundColor Cyan }
function Info([string]$Texte) { Write-Host "  $Texte" }
function Pause-Fin {
  if (-not $NonInteractif) { Write-Host ''; Read-Host 'Appuyez sur Entrée pour fermer' | Out-Null }
}
function Echec([string]$Texte) {
  Write-Host ''
  Write-Host "Erreur : $Texte" -ForegroundColor Red
  if ($env:GITHUB_ACTIONS -eq 'true') { Write-Host "::error title=premiere_installation.ps1::$Texte" }
  Pause-Fin
  exit 1
}
function Demander([string]$Question) {
  if ($NonInteractif) { return $false }
  $reponse = Read-Host "$Question (O/N)"
  return ($reponse -match '^\s*[oOyY]')
}

# PATH relu depuis le registre : un logiciel installé à l'instant devient utilisable sans rouvrir PowerShell.
function Actualiser-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  foreach ($entry in (($machine, $user, $env:Path) -join ';').Split(';')) {
    if ($entry -and ($parts -notcontains $entry)) { $parts += $entry }
  }
  $env:Path = $parts -join ';'
}

function Commande([string]$Nom) {
  $found = Get-Command $Nom -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notlike '*\WindowsApps\python*' } | Select-Object -First 1
  if ($found) { return $found.Source }
  return $null
}

function Installer([string]$Id, [string]$Nom) {
  if (-not (Commande 'winget')) {
    Echec ("winget (le gestionnaire de logiciels de Windows) est introuvable : installez « Programme d'installation " +
      "d'application » (App Installer) depuis le Microsoft Store (https://apps.microsoft.com/detail/9nblggh4nns1), " +
      "puis relancez ce script.")
  }
  Info "Installation de $Nom (winget $Id)…"
  & winget install --exact --id $Id --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($WingetOk -notcontains $LASTEXITCODE) { Echec "l'installation de $Nom a échoué (code winget $LASTEXITCODE)." }
  Actualiser-Path
}

# Python 3.11 à 3.13 (pywebview a besoin de pythonnet, pas toujours disponible pour la toute dernière version).
function Trouver-Python {
  # « py -3.x » écrit sur la sortie d'erreur quand la version manque : sous Windows PowerShell 5.1, la
  # rediriger avec $ErrorActionPreference = 'Stop' déclencherait une erreur. Réglage local à la fonction.
  $ErrorActionPreference = 'Continue'
  $candidats = @()
  # Python déjà dans le PATH (python.org, conda…), s'il est d'une version qui convient.
  $python = Commande 'python'
  if ($python) {
    & $python -c 'import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] <= (3, 13) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) {
      $exe = (& $python -c 'import sys; print(sys.executable)' | Select-Object -First 1)
      if ($exe) { $candidats += $exe.Trim() }
    }
  }
  $py = Commande 'py'
  if ($py) {
    foreach ($v in @('3.13', '3.12', '3.11')) {
      $exe = (& $py "-$v" -c 'import sys; print(sys.executable)' 2>$null | Select-Object -First 1)
      if ($LASTEXITCODE -eq 0 -and $exe) { $candidats += $exe.Trim() }
    }
  }
  foreach ($v in @('313', '312', '311')) {
    $candidats += (Join-Path $env:LOCALAPPDATA "Programs\Python\Python$v\python.exe")
    $candidats += (Join-Path $env:ProgramFiles "Python$v\python.exe")
  }
  foreach ($exe in $candidats) {
    if ($exe -and (Test-Path -LiteralPath $exe)) { return $exe }
  }
  return $null
}

Write-Host 'Atelier Viz — première installation sur Windows' -ForegroundColor Green
Write-Host 'Durée : 10 à 20 minutes selon la connexion. Laissez cette fenêtre ouverte.'

# --- 1. Logiciels -------------------------------------------------------------------------------
Titre '1/5 · Logiciels nécessaires'
Actualiser-Path
if (Commande 'git') { Info 'Git : déjà installé.' } else { Installer 'Git.Git' 'Git' }
if (-not (Commande 'git')) { Echec 'Git reste introuvable après installation : fermez PowerShell, rouvrez-le et relancez ce script.' }

$Python = Trouver-Python
if ($Python) { Info "Python : déjà installé ($Python)." } else {
  Installer 'Python.Python.3.13' 'Python 3.13'
  $Python = Trouver-Python
}
if (-not $Python) { Echec 'Python 3.13 reste introuvable après installation : fermez PowerShell, rouvrez-le et relancez ce script.' }

if (Commande 'npm.cmd') { Info 'Node.js : déjà installé.' } else { Installer 'OpenJS.NodeJS.LTS' 'Node.js LTS' }
if (-not (Commande 'npm.cmd')) { Echec 'Node.js reste introuvable après installation : fermez PowerShell, rouvrez-le et relancez ce script.' }

# --- 2. Options : Claude Code et Ollama ------------------------------------------------------------
Titre '2/5 · Intelligence artificielle (facultatif)'
$avecClaude = $Claude
if (-not $Claude -and -not $SansClaude -and -not (Commande 'claude')) {
  Info "Claude Code permet d'utiliser Claude dans Atelier Viz (abonnement claude.ai Pro ou Max requis)."
  $avecClaude = Demander '  Installer Claude Code ?'
}
if (Commande 'claude') { Info 'Claude Code : déjà installé.' }
elseif ($avecClaude) { Installer 'Anthropic.ClaudeCode' 'Claude Code' }
else { Info 'Claude Code : non installé (possible plus tard : winget install Anthropic.ClaudeCode).' }

$avecOllama = $Ollama
if (-not $Ollama -and -not $SansOllama -and -not (Commande 'ollama')) {
  Info "Ollama est une IA qui tourne sur votre PC, sans Internet (environ 2 Go à télécharger pour le modèle)."
  $avecOllama = Demander '  Installer Ollama ?'
}
if (Commande 'ollama') { Info 'Ollama : déjà installé.' }
elseif ($avecOllama) { Installer 'Ollama.Ollama' 'Ollama' }
else { Info 'Ollama : non installé (possible plus tard : winget install Ollama.Ollama).' }

# --- 3. Dépôt -----------------------------------------------------------------------------------
Titre '3/5 · Code d''Atelier Viz (GitHub)'
$ici = (Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue)
if ($ici -and (Test-Path (Join-Path $ici.Path 'backend\main.py')) -and (Test-Path (Join-Path $ici.Path 'frontend\package.json'))) {
  $Racine = $ici.Path
  Info "Dépôt déjà présent : $Racine"
} else {
  $Racine = $Dossier
  if (Test-Path (Join-Path $Racine '.git')) {
    Info "Mise à jour de $Racine (git pull)…"
    & git -C $Racine pull --ff-only
    if ($LASTEXITCODE -ne 0) { Echec "git pull a échoué dans $Racine." }
  } else {
    if ((Test-Path $Racine) -and (Get-ChildItem -LiteralPath $Racine -Force | Select-Object -First 1)) {
      Echec "le dossier $Racine existe déjà et n'est pas vide. Choisissez-en un autre : -Dossier C:\chemin\Atelier_Viz"
    }
    Info 'Une fenêtre de connexion GitHub va s''ouvrir (dépôt privé) : connectez-vous avec votre compte GitHub.'
    & git clone $Depot $Racine
    if ($LASTEXITCODE -ne 0) { Echec 'la récupération du dépôt a échoué (connexion GitHub refusée ou annulée ?).' }
  }
}

# Branche : celle demandée, sinon main si elle contient la version Windows, sinon claude/windows.
if (Test-Path (Join-Path $Racine '.git')) {
  $cible = $Branche
  if (-not $cible -and -not (Test-Path (Join-Path $Racine 'scripts\windows\build_app.ps1'))) { $cible = 'claude/windows' }
  if ($cible) {
    Info "Branche : $cible"
    & git -C $Racine fetch origin $cible
    if ($LASTEXITCODE -ne 0) { Echec "branche $cible introuvable sur GitHub." }
    & git -C $Racine checkout $cible
    if ($LASTEXITCODE -ne 0) { Echec "impossible de passer sur la branche $cible." }
  }
}
if (-not (Test-Path (Join-Path $Racine 'scripts\windows\build_app.ps1'))) { Echec 'scripts\windows\build_app.ps1 est introuvable dans le dépôt.' }

# --- 4. Environnement Python --------------------------------------------------------------------
Titre '4/5 · Environnement Python (backend\.venv)'
$venv = Join-Path $Racine 'backend\.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
  & $Python -m venv $venv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) { Echec "création de l'environnement Python impossible ($Python)." }
}
Info $venvPython
& $venvPython -m pip install --quiet --disable-pip-version-check --upgrade pip
$envExample = Join-Path $Racine 'backend\.env.example'
$envFile = Join-Path $Racine 'backend\.env'
if ((Test-Path -LiteralPath $envExample) -and -not (Test-Path -LiteralPath $envFile)) { Copy-Item -LiteralPath $envExample -Destination $envFile }

# --- 5. Application -----------------------------------------------------------------------------
Titre '5/5 · Application (build_app.ps1)'
& (Join-Path $Racine 'scripts\windows\build_app.ps1') -Python $venvPython
if ($LASTEXITCODE -ne 0) { Echec "build_app.ps1 a échoué (voir les messages ci-dessus)." }

# --- Connexions facultatives -------------------------------------------------------------------
$claudeExe = Commande 'claude'
if ($claudeExe -and -not $NonInteractif -and (Demander 'Se connecter maintenant à Claude avec votre compte claude.ai ?')) {
  & $claudeExe auth login
}
$ollamaExe = Commande 'ollama'
if ($ollamaExe -and -not $NonInteractif -and (Demander 'Télécharger maintenant le modèle Ollama llama3.2 (≈ 2 Go) ?')) {
  & $ollamaExe pull llama3.2
}

Write-Host ''
Write-Host '✓ Installation terminée.' -ForegroundColor Green
Write-Host "  • Lancez Atelier Viz : menu Démarrer → « Atelier Viz » (ou l'icône du Bureau)."
Write-Host "  • Dossier du projet : $Racine"
Write-Host '  • Mettre à jour plus tard : relancez ce script (il fait git pull puis réinstalle).'
Pause-Fin
