@echo off
cd /d "%~dp0"
taskkill /F /IM hugo.exe >nul 2>&1
hugo server -D
pause
