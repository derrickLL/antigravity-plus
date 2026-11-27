@echo off
setlocal
set "PSModulePath="
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Manage.ps1" %*
exit /b %ERRORLEVEL%
