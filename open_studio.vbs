Set WshShell = CreateObject("WScript.Shell")
' Lanzador oficial: resuelve siempre la carpeta donde vive este archivo.
' Así, cualquier cambio en el repositorio se usa en la siguiente apertura.
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
trayPath = fso.BuildPath(baseDir, "local_ai_tray.pyw")
WshShell.Run "pythonw.exe """ & trayPath & """", 0, False

' Esperar al servidor actual y al Director Hermes antes de abrir la interfaz.
Set xhr = CreateObject("MSXML2.XMLHTTP")
ready = False
For attempt = 1 To 180
    appReady = False
    hermesReady = False
    On Error Resume Next
    xhr.Open "GET", "http://127.0.0.1:63719/api/version", False
    xhr.Send
    If Err.Number = 0 And xhr.Status = 200 Then appReady = True
    Err.Clear
    xhr.Open "GET", "http://127.0.0.1:63719/api/directml/status", False
    xhr.Send
    If Err.Number = 0 And xhr.Status = 200 Then
        hermesReady = (InStr(xhr.ResponseText, """model_loaded"":true") > 0 And InStr(xhr.ResponseText, "Hermes-3-8B-UNLOCKED-ONNX-DirectML") > 0)
    End If
    Err.Clear
    On Error GoTo 0
    ready = (appReady And hermesReady)
    If ready Then Exit For
    WScript.Sleep 500
Next

' Abrir como ventana de aplicacion de escritorio
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edgePath) Then
    WshShell.Run """" & edgePath & """ --app=http://127.0.0.1:63719/", 1, False
Else
    WshShell.Run "http://127.0.0.1:63719/", 1, False
End If
