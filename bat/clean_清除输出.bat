@echo off
cd /d "%~dp0.."

:: Relaunch in Windows Terminal if not already
if "%WT_SESSION%"=="" (
    wt -w 0 nt -d "%CD%" cmd /c "%~f0" %*
    exit /b
)

if exist public (
    rmdir /s /q public
    echo Cleaned public/
) else (
    echo public/ not found
)
