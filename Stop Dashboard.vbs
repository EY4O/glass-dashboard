' Stops the hidden dashboard server started by "Start Dashboard.vbs".
' Only stops the process listening on the dashboard's port, and only if it's node running this folder's server.mjs.
Option Explicit

Dim fso, dir, port, script, conns, c, pid, procs, p, stopped

Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
script = LCase(fso.BuildPath(dir, "server.mjs"))
port = ConfigPort(dir)

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

' Who is listening on the port? (State 2 = Listen). WMI, so no console window flashes.
pid = 0
Set conns = GetObject("winmgmts:\\.\root\StandardCimv2").ExecQuery("SELECT OwningProcess FROM MSFT_NetTCPConnection WHERE LocalPort = " & port & " AND State = 2")
For Each c In conns
  pid = c.OwningProcess
  Exit For
Next

stopped = False
If pid > 0 Then
  Set procs = GetObject("winmgmts:\\.\root\cimv2").ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId = " & pid)
  For Each p In procs
    If LCase(p.Name) = "node.exe" And InStr(LCase(p.CommandLine & ""), script) > 0 Then
      p.Terminate
      stopped = True
    End If
  Next
End If

If stopped Then
  Notify "The dashboard server has stopped.", vbInformation
ElseIf pid = 0 Then
  Notify "The dashboard server isn't running.", vbInformation
Else
  Notify "Port " & port & " is in use by another program (process " & pid & "), so nothing was stopped." & vbCrLf & _
    "If you started the dashboard from a terminal, close that window instead.", vbExclamation
End If
