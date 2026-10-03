@echo off
REM One-click launcher for baton swarm map (Port 8766)
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-map.ps1" %*
if %ERRORLEVEL% neq 0 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-map.ps1" %*
)
