Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(baseDir, "launch_local_ai_studio.ps1")

' Unico punto de entrada: el script resuelve el servidor y la UI desde esta carpeta.
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & launcher & """", 0, False
