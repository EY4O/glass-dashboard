@echo off
rem Stops the hidden dashboard server. This window closes by itself.
start "" wscript.exe "%~dp0Stop Dashboard.vbs"
