@echo off
cd /d "%~dp0"
chcp 65001 >nul
node resident.mjs %*
if errorlevel 1 pause
