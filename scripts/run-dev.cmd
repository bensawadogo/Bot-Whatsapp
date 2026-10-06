@echo off
REM AfriBot - lance le serveur de developpement (ts-node-dev) en tache de fond.
REM Usage : scripts\run-dev.cmd [fichier-log]
REM Ecrit stdout+stderr dans le fichier-log passe en argument (obligatoire pour
REM une execution non interactive : sinon ts-node-dev reste attache au terminal).
cd /d "%~dp0.."
npm run dev > "%~1" 2>&1
