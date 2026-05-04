@echo off
cd /d "%~dp0.."

:: Relaunch in Windows Terminal if not already
if "%WT_SESSION%"=="" (
    wt -w 0 nt -d "%CD%" cmd /c "%~f0" %*
    exit /b
)

hugo
echo Build complete. Output in public/
