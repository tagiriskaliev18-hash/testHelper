' Silent background launcher for ICA Test Helper Live AI Bridge (hides console via WScript style 0)
Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strDir = fso.GetParentFolderName(WScript.ScriptFullName)
objShell.CurrentDirectory = strDir

strUser = objShell.ExpandEnvironmentStrings("%USERPROFILE%")
strAppData = objShell.ExpandEnvironmentStrings("%APPDATA%")

strPython = ""
arrCandidates = Array( _
  strAppData & "\uv\python\cpython-3.12-windows-x86_64-none\python.exe", _
  strUser & "\Downloads\NewGenMMLLM\.venv\Scripts\python.exe", _
  strAppData & "\uv\python\cpython-3.12-windows-x86_64-none\pythonw.exe" _
)

For Each cand In arrCandidates
  If fso.FileExists(cand) Then
    strPython = cand
    Exit For
  End If
Next

If strPython = "" Then
  strPython = "python.exe"
End If

objShell.Run """" & strPython & """ """ & strDir & "\bridge_server.py""", 0, False
