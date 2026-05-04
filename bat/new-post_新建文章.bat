@echo off
chcp 65001 >nul
cd /d "%~dp0.."

:: Relaunch in Windows Terminal if not already
if "%WT_SESSION%"=="" (
    wt -w 0 nt -d "%CD%" cmd /c "%~f0" %*
    exit /b
)

python scripts\new-post.py
