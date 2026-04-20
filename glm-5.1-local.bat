@echo off
:: Launch Claude Code with working directory set to wherever this bat is placed
start "" wt.exe -d "%~dp0." -p "Windows PowerShell" -- cmd /k claude --model glm-5.1 --dangerously-skip-permissions
