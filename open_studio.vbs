Set WshShell = CreateObject("WScript.Shell")
' Verificar y lanzar servicios si es necesario
WshShell.Run "pythonw.exe ""C:\Users\Benner\.gemini\config\plugins\local-ai-studio\local_ai_tray.pyw""", 0, False
WScript.Sleep 500

' Abrir como ventana de aplicacion de escritorio
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
Set fso = CreateObject("Scripting.FileSystemObject")
If fso.FileExists(edgePath) Then
    WshShell.Run """" & edgePath & """ --app=http://127.0.0.1:63719/", 1, False
Else
    WshShell.Run "http://127.0.0.1:63719/", 1, False
End If
