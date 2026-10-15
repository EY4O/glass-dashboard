' Starts the dashboard server with no window (nothing on the taskbar), then opens it in the browser.
' If it's already running, this just opens the browser. Stop it with "Stop Dashboard.vbs".
' Add /nobrowser to start the server without opening a tab (handy for starting at sign-in).
' The port comes from dashboard.config.local.json if it exists, otherwise dashboard.config.json.
' Server messages go to server.log in this folder.
Option Explicit

Dim sh, fso, dir, url, i, openBrowser

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:" & ConfigPort(dir) & "/"
openBrowser = True
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "/nobrowser" Then openBrowser = False
Next

Function ConfigPort(folder)
  Dim f, path, text, re, m
  ConfigPort = 4400
  For Each f In Array("dashboard.config.local.json", "dashboard.config.json")
    path = fso.BuildPath(folder, f)
    If fso.FileExists(path) Then
      text = fso.OpenTextFile(path, 1).ReadAll()
      Set re = New RegExp
      re.Pattern = """port""\s*:\s*(\d+)"
      Set m = re.Execute(text)
      If m.Count > 0 Then ConfigPort = CLng(m(0).SubMatches(0))
      Exit Function
    End If
  Next
End Function

Sub Notify(msg, style)
  ' A dialog when double-clicked; plain text when run from a command line
  If InStr(LCase(WScript.FullName), "cscript") > 0 Then WScript.Echo msg Else MsgBox msg, style, "Dashboard"
End Sub

Function IsRunning()
  Dim http
  IsRunning = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 500, 1000
  http.open "GET", url, False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 Then IsRunning = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

If Not IsRunning() Then
  sh.CurrentDirectory = dir
  ' Window style 0 = hidden; False = don't wait. The full path lets "Stop Dashboard.vbs" recognise this server.
  sh.Run "cmd /c node """ & fso.BuildPath(dir, "server.mjs") & """ > server.log 2>&1", 0, False
  ' Give it up to 15 seconds to start listening
  For i = 1 To 30
    WScript.Sleep 500
    If IsRunning() Then Exit For
  Next
  If Not IsRunning() Then
    Notify "The dashboard server didn't start. See server.log in:" & vbCrLf & dir, vbExclamation
    WScript.Quit 1
  End If
End If

If openBrowser Then sh.Run url, 1, False
If InStr(LCase(WScript.FullName), "cscript") > 0 Then WScript.Echo "Dashboard running at " & url
