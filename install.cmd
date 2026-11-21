@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\statusbar-shortcut.ps1"
exit /b %errorlevel%
