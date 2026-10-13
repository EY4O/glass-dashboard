@echo off
rem Starts Glass Dashboard and opens it. Close this window to stop it.
cd /d "%~dp0"
start "" http://localhost:4400
node server.mjs
pause
