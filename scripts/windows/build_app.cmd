@echo off
rem Installe Atelier Viz (raccourcis menu Demarrer et Bureau) : double-cliquez ce fichier,
rem ou lancez-le depuis une invite de commandes ou l'environnement Python du backend est active.
rem Options : voir build_app.ps1 (exemple : build_app.cmd -NoDesktopShortcut).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_app.ps1" %*
set CODE=%ERRORLEVEL%
pause
exit /b %CODE%
