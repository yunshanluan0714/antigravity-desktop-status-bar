@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\statusbar-shortcut.ps1" -Remove
exit /b %errorlevel%
