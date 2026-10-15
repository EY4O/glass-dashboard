@echo off
rem Starts the dashboard with no window (nothing stays on the taskbar) and opens it in the browser.
rem This window closes by itself. Stop the server with "Stop Dashboard.bat".
rem Add /nobrowser to start the server without opening a tab.
rem To watch the server's output instead, run "node server.mjs" in a terminal here.
start "" wscript.exe "%~dp0Start Dashboard.vbs" %*
