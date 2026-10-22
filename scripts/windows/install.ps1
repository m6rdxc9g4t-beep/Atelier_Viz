<#
.SYNOPSIS
    Installe Atelier Viz sur Windows pour l'utilisateur courant (docs/SUITE.md §9.1), sans droits d'administrateur.

.DESCRIPTION
    Depuis le dépôt cloné :
        powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1

    1. Vérifie les prérequis (Windows 10 21H2+ ou 11, Git, Node.js 22.12+, Python 3.11+, runtime WebView2)
       et indique la commande winget à lancer pour ce qui manque ; n'installe rien de système.
    2. Crée l'environnement Python dédié à l'application : %LOCALAPPDATA%\Atelier Viz\venv (jamais conda).
    3. Crée le lanceur : raccourci « Atelier Viz » du menu Démarrer (dossier « Atelier ») et du Bureau (sauf
       -SansBureau) : pythonw.exe du venv sur backend\desktop.py, aucune console.
    4. Fait la première mise à jour (python -m app.launcher --mettre-a-jour : pip, npm ci, compilation).
    5. Enregistre l'app dans HKCU\Software\Atelier\Apps\viz (Lanceur = raccourci du menu Démarrer, Nom) pour
       les autres apps de la suite (docs/SUITE.md §9.6).

    Relancer le script répare l'installation sans toucher aux données (backend\data). Ensuite, après un
    « git pull », il suffit de relancer Atelier Viz : il se met à jour tout seul (docs/SUITE.md §8).

.PARAMETER SansBureau
    Ne crée pas de raccourci sur le Bureau.

.PARAMETER Desinstaller
    Retire le lanceur, les raccourcis, l'enregistrement et l'environnement Python de l'app ; jamais les données.

.PARAMETER Python
    Chemin d'un python.exe 3.11+ à utiliser pour créer l'environnement (sinon « py -3 », puis « python »).
    S'il diffère de celui de l'environnement existant, l'environnement est recréé.

.PARAMETER DossierRaccourcis
    (Essais, intégration continue) Dossier où créer les raccourcis à la place du menu Démarrer et du Bureau.
#>
[CmdletBinding()]
param(
    [switch]$SansBureau,
    [switch]$Desinstaller,
    [string]$Python = '',
    [string]$DossierRaccourcis = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$NomApp = 'Atelier Viz'
$IdApp = 'viz'
$Depot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$Backend = Join-Path $Depot 'backend'
$Local = $env:LOCALAPPDATA
if (-not $Local) { $Local = [Environment]::GetFolderPath('LocalApplicationData') }
$DossierApp = Join-Path $Local $NomApp
$Venv = Join-Path $DossierApp 'venv'
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
$VenvPythonw = Join-Path $Venv 'Scripts\pythonw.exe'
$AncienLanceur = Join-Path $DossierApp "$NomApp.lnk"  # versions précédentes : retiré à la réparation
$Journal = Join-Path (Join-Path $DossierApp 'Logs') 'mise-a-jour.log'
$Icone = Join-Path $PSScriptRoot 'atelier-viz.ico'
$Tampon = Join-Path $Backend '.mise-a-jour.json'
$CleApps = 'HKCU:\Software\Atelier\Apps'
$CleApp = "$CleApps\$IdApp"
if ($DossierRaccourcis) {
    $Menu = Join-Path (Join-Path $DossierRaccourcis 'Menu Démarrer') 'Atelier'
    $Bureau = Join-Path $DossierRaccourcis 'Bureau'
} else {
    $Menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Atelier'
    $Bureau = [Environment]::GetFolderPath('Desktop')
}
$RaccourciMenu = Join-Path $Menu "$NomApp.lnk"
$RaccourciBureau = Join-Path $Bureau "$NomApp.lnk"
$Lanceur = $RaccourciMenu  # §9.6 : le lanceur inscrit est le raccourci du menu Démarrer

# Sortie des programmes Python en UTF-8 (chemins avec accents : C:\Users\François\…).
$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Write-Etape([string]$Texte) { Write-Host "`n» $Texte" -ForegroundColor Cyan }
function Write-Ok([string]$Texte) { Write-Host "  ✓ $Texte" -ForegroundColor Green }
function Write-Attention([string]$Texte) { Write-Host "  ! $Texte" -ForegroundColor Yellow }
function Stop-Installation([string]$Texte) {
    Write-Host "`nErreur : $Texte" -ForegroundColor Red
    exit 1
}

function Invoke-Natif {
    <# Lance un programme (arguments en tableau, jamais une ligne de commande construite) ; @{ Code ; Sortie }. #>
    param([string]$Exe, [string[]]$Arguments = @())
    $ancien = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'  # PowerShell 5.1 : une ligne sur stderr ne doit pas arrêter le script
    try {
        $sortie = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
        return @{ Code = $LASTEXITCODE; Sortie = (@($sortie) -join "`n").Trim() }
    } catch {
        return @{ Code = -1; Sortie = "$_" }
    } finally {
        $ErrorActionPreference = $ancien
    }
}

function Remove-CleVide([string]$Cle) {
    if (-not (Test-Path -LiteralPath $Cle)) { return }
    $item = Get-Item -LiteralPath $Cle
    if ($item.SubKeyCount -eq 0 -and $item.ValueCount -eq 0) { Remove-Item -LiteralPath $Cle -Force }
}

# --- Désinstallation ------------------------------------------------------------------------------------

if ($Desinstaller) {
    Write-Etape "Désinstallation d'$NomApp (les données ne sont pas touchées)"
    foreach ($chemin in @($RaccourciMenu, $RaccourciBureau, $AncienLanceur)) {
        if (Test-Path -LiteralPath $chemin) { Remove-Item -LiteralPath $chemin -Force; Write-Ok "Retiré : $chemin" }
    }
    if ((Test-Path -LiteralPath $Menu) -and -not (Get-ChildItem -LiteralPath $Menu -Force)) {
        Remove-Item -LiteralPath $Menu -Force
    }
    if (Test-Path -LiteralPath $CleApp) { Remove-Item -LiteralPath $CleApp -Recurse -Force; Write-Ok "Enregistrement retiré ($CleApp)" }
    Remove-CleVide $CleApps
    Remove-CleVide 'HKCU:\Software\Atelier'
    if (Test-Path -LiteralPath $Venv) {
        try {
            Remove-Item -LiteralPath $Venv -Recurse -Force
            Write-Ok "Environnement Python retiré ($Venv)"
        } catch {
            Write-Attention "Environnement Python non retiré (Atelier Viz est-il ouvert ?) : $Venv"
        }
    }
    if (Test-Path -LiteralPath $Tampon) { Remove-Item -LiteralPath $Tampon -Force }
    Write-Host "`n$NomApp est désinstallé. Vos données restent dans $(Join-Path $Backend 'data') (et le dépôt est intact)."
    exit 0
}

# --- Prérequis ------------------------------------------------------------------------------------------

Write-Etape 'Vérification des prérequis'
$manque = @()

if (-not (Test-Path -LiteralPath (Join-Path $Backend 'desktop.py'))) {
    Stop-Installation "backend\desktop.py introuvable : lancez ce script depuis le dépôt Atelier Viz ($Depot)."
}

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19044) {
    Write-Attention "Windows 10 21H2 (build 19044) ou plus récent est recommandé (build actuel : $build)."
} else {
    Write-Ok "Windows (build $build)"
}

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if ($git) {
    Write-Ok "Git ($($git.Path))"
    if (-not (Test-Path -LiteralPath (Join-Path $Depot '.git'))) {
        Write-Attention 'Ce dossier n''est pas un clone git : la mise à jour suivra les fichiers, sans « git pull » possible.'
    }
} else {
    $manque += 'Git : winget install --id Git.Git -e'
}

$node = $null
$candidatsNode = @()
$cmdNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmdNode) { $candidatsNode += $cmdNode.Path }
foreach ($base in @($env:ProgramFiles, $env:NVM_SYMLINK, (Join-Path $Local 'Programs'))) {
    if ($base) {
        $candidatsNode += (Join-Path $base 'node.exe')
        $candidatsNode += (Join-Path (Join-Path $base 'nodejs') 'node.exe')
    }
}
foreach ($candidat in $candidatsNode) {
    if (-not (Test-Path -LiteralPath $candidat)) { continue }
    $r = Invoke-Natif $candidat @('--version')
    if ($r.Code -eq 0 -and $r.Sortie -match '^v(\d+)\.(\d+)') {
        $majeure = [int]$Matches[1]; $mineure = [int]$Matches[2]
        $dossierNode = Split-Path -Parent $candidat
        # npm est lancé par node.exe sur npm-cli.js (sans shell, §9.6) : il doit être à côté de node.exe.
        $npmCli = Join-Path $dossierNode 'node_modules\npm\bin\npm-cli.js'
        if (-not (Test-Path -LiteralPath $npmCli)) { continue }
        if (($majeure -eq 22 -and $mineure -ge 12) -or $majeure -ge 23) {
            $node = $candidat
            Write-Ok "Node.js $($r.Sortie) ($candidat)"
            break
        }
        Write-Attention "Node.js $($r.Sortie) est trop ancien ($candidat)."
    }
}
if (-not $node) {
    $manque += 'Node.js 22.12 ou plus récent : winget install OpenJS.NodeJS.LTS   (puis ouvrez un nouveau terminal)'
}

# Python 3.11+ : -Python, puis « py -3 », puis « python » (docs/SUITE.md §9.3). Jamais conda.
$pythonTrouve = $null  # (les variables PowerShell ignorent la casse : distinct du paramètre -Python)
$candidatsPython = @()
if ($Python) {
    $candidatsPython += , @($Python)
} else {
    if (Get-Command py.exe -ErrorAction SilentlyContinue) { $candidatsPython += , @('py.exe', '-3') }
    if (Get-Command python.exe -ErrorAction SilentlyContinue) { $candidatsPython += , @('python.exe') }
}
foreach ($candidat in $candidatsPython) {
    $exe = $candidat[0]
    $prefixe = @($candidat | Select-Object -Skip 1)
    $r = Invoke-Natif $exe ($prefixe + @('-c', 'import sys; print(''%d.%d'' % sys.version_info[:2])'))
    if ($r.Code -eq 0 -and $r.Sortie -match '^(\d+)\.(\d+)$') {
        if ([version]$r.Sortie -ge [version]'3.11') {
            $pythonTrouve = $candidat
            Write-Ok "Python $($r.Sortie) ($($candidat -join ' '))"
            break
        }
        Write-Attention "Python $($r.Sortie) est trop ancien ($($candidat -join ' '))."
    }
}
if (-not $pythonTrouve -and -not (Test-Path -LiteralPath $VenvPython)) {
    if ($Python) { Stop-Installation "Python 3.11+ introuvable à l'emplacement indiqué : $Python" }
    $manque += 'Python 3.11+ : winget install Python.Python.3.12   (puis ouvrez un nouveau terminal)'
}

if ($manque.Count -gt 0) {
    Write-Host "`nIl manque :" -ForegroundColor Red
    foreach ($ligne in $manque) { Write-Host "  - $ligne" -ForegroundColor Red }
    Stop-Installation 'installez ce qui manque, puis relancez ce script.'
}

# WebView2 : moteur de la fenêtre (présent sur Windows 11 et sur Windows 10 à jour).
$webview2 = $false
$client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
foreach ($cle in @(
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$client",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$client",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$client")) {
    try {
        $pv = (Get-ItemProperty -LiteralPath $cle -Name pv -ErrorAction Stop).pv
        if ("$pv" -match '^(\d+)\.' -and [int]$Matches[1] -ge 86) { $webview2 = $true; Write-Ok "WebView2 $pv"; break }
    } catch { }
}
if (-not $webview2) {
    Write-Attention 'Runtime Microsoft Edge WebView2 introuvable : sans lui, Atelier Viz s''ouvrira dans votre navigateur.'
    Write-Attention 'Pour la fenêtre de l''application : winget install Microsoft.EdgeWebView2Runtime (sans droits'
    Write-Attention 'd''administrateur : https://developer.microsoft.com/microsoft-edge/webview2/ , « Evergreen Bootstrapper »).'
}

# --- Environnement Python de l'application --------------------------------------------------------------

Write-Etape "Environnement Python de l'application ($Venv)"
$recreer = $true
if (Test-Path -LiteralPath $VenvPython) {
    $r = Invoke-Natif $VenvPython @('-c', 'import sys; print(''%d.%d'' % sys.version_info[:2])')
    $recreer = -not ($r.Code -eq 0 -and $r.Sortie -match '^\d+\.\d+$' -and [version]$r.Sortie -ge [version]'3.11')
    if (-not $recreer -and $Python) {
        # Autre Python demandé explicitement : l'environnement est recréé à partir de lui.
        $cfg = Join-Path $Venv 'pyvenv.cfg'
        $home_ = (Get-Content -LiteralPath $cfg -Encoding UTF8 | Where-Object { $_ -match '^\s*home\s*=' } | Select-Object -First 1)
        $voulu = Split-Path -Parent (Resolve-Path -LiteralPath $Python).Path
        if (-not $home_ -or ($home_ -replace '^\s*home\s*=\s*', '').TrimEnd('\') -ne $voulu.TrimEnd('\')) { $recreer = $true }
    }
    if ($recreer) { Write-Attention 'Environnement existant inutilisable ou d''un autre Python : il est recréé.' }
}
if ($recreer) {
    if (-not $pythonTrouve) { Stop-Installation 'Python 3.11+ introuvable : winget install Python.Python.3.12' }
    if (Test-Path -LiteralPath $Venv) {
        try { Remove-Item -LiteralPath $Venv -Recurse -Force }
        catch { Stop-Installation "impossible de remplacer $Venv (fermez Atelier Viz, puis relancez ce script)." }
    }
    New-Item -ItemType Directory -Force -Path $DossierApp | Out-Null
    $exe = $pythonTrouve[0]
    $prefixe = @($pythonTrouve | Select-Object -Skip 1)
    $r = Invoke-Natif $exe ($prefixe + @('-m', 'venv', $Venv))
    if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath $VenvPythonw)) {
        Stop-Installation "création de l'environnement Python impossible :`n$($r.Sortie)"
    }
    # Environnement neuf : la prochaine mise à jour réinstalle les dépendances Python.
    if (Test-Path -LiteralPath $Tampon) { Remove-Item -LiteralPath $Tampon -Force }
    Write-Ok 'Environnement créé'
} else {
    Write-Ok 'Environnement existant conservé'
}

# --- Lanceur et raccourcis ------------------------------------------------------------------------------

Write-Etape 'Lanceur et raccourcis'
function New-Raccourci([string]$Chemin) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Chemin) | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Chemin)
    $lnk.TargetPath = $VenvPythonw  # pythonw.exe : aucune fenêtre de console
    $lnk.Arguments = '"' + (Join-Path $Backend 'desktop.py') + '"'
    $lnk.WorkingDirectory = $Backend
    if (Test-Path -LiteralPath $Icone) { $lnk.IconLocation = "$Icone,0" }
    $lnk.Description = "$NomApp : BI locale (se met à jour depuis le dépôt au lancement)"
    $lnk.WindowStyle = 1
    $lnk.Save()
    Write-Ok $Chemin
}
New-Item -ItemType Directory -Force -Path $DossierApp | Out-Null
if (Test-Path -LiteralPath $AncienLanceur) { Remove-Item -LiteralPath $AncienLanceur -Force }
New-Raccourci $RaccourciMenu
if ($SansBureau) {
    if (Test-Path -LiteralPath $RaccourciBureau) { Remove-Item -LiteralPath $RaccourciBureau -Force }
} else {
    New-Raccourci $RaccourciBureau
}

# --- Première mise à jour -------------------------------------------------------------------------------

Write-Etape 'Première mise à jour (dépendances Python, npm ci, compilation de l''interface)'
$ancien = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
Push-Location -LiteralPath $Backend
try {
    & $VenvPython -m app.launcher --mettre-a-jour
    $code = $LASTEXITCODE
} finally {
    Pop-Location
    $ErrorActionPreference = $ancien
}
if ($code -ne 0) {
    Stop-Installation ("la mise à jour a échoué. Journal : $Journal`n" +
        "Corrigez le problème (réseau, Node.js…) puis relancez ce script, ou ouvrez Atelier Viz : elle sera retentée.")
}

# --- Enregistrement pour la suite (docs/SUITE.md §9.4) ---------------------------------------------------

Write-Etape 'Enregistrement pour les autres apps de la Suite Atelier'
if (-not (Test-Path -LiteralPath $CleApp)) { New-Item -Path $CleApp -Force | Out-Null }
New-ItemProperty -LiteralPath $CleApp -Name 'Lanceur' -Value $Lanceur -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $CleApp -Name 'Nom' -Value $NomApp -PropertyType String -Force | Out-Null
New-ItemProperty -LiteralPath $CleApp -Name 'Depot' -Value $Depot -PropertyType String -Force | Out-Null
Write-Ok "$CleApp"

Write-Host "`n$NomApp est installé." -ForegroundColor Green
Write-Host @"
  • Ouvrez « $NomApp » depuis le menu Démarrer (dossier « Atelier »)$(if (-not $SansBureau) { ' ou le Bureau' }).
  • Après un « git pull », relancez simplement l'application : elle se met à jour toute seule.
  • Journaux : $(Split-Path -Parent $Journal)
  • Vos données : $(Join-Path $Backend 'data')
  • Réparer : relancez ce script. Désinstaller : powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -Desinstaller
"@
exit 0
