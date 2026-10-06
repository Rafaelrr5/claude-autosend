' Claude Autosend - abre o painel no navegador.
' Roda o Node.js que vem junto (pasta app\runtime) sem janela de console e
' espera ele terminar; se terminar com erro, mostra a mensagem do programa.
' Texto sem acentos de proposito: arquivos .vbs nao sao lidos como UTF-8.
Option Explicit

Dim fso, shell, baseDir, nodeExe, launcher, exitCode, errorFile, message
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(baseDir, "app\runtime\node.exe")
launcher = fso.BuildPath(baseDir, "app\launcher.cjs")

If Not (fso.FileExists(nodeExe) And fso.FileExists(launcher)) Then
  Show "Arquivos do programa nao encontrados." & vbCrLf & vbCrLf & _
    "Extraia (descompacte) o arquivo ZIP inteiro para uma pasta e abra este arquivo de dentro dela."
  WScript.Quit 1
End If

' Start in the user folder: the app never works inside its own folder.
shell.CurrentDirectory = shell.ExpandEnvironmentStrings("%USERPROFILE%")
exitCode = shell.Run("""" & nodeExe & """ """ & launcher & """", 0, True)

If exitCode <> 0 Then
  errorFile = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\3R Studios\Claude Autosend\logs\ultimo-erro.txt"
  message = "O Claude Autosend parou por um erro inesperado."
  If fso.FileExists(errorFile) Then message = Replace(ReadUtf8(errorFile), vbLf, vbCrLf)
  Show message
End If
WScript.Quit exitCode

' A dialog for double-clicks; plain output under cscript (tests, terminals).
Sub Show(text)
  If InStr(LCase(WScript.FullName), "cscript.exe") > 0 Then
    WScript.Echo text
  Else
    MsgBox text, vbExclamation, "Claude Autosend"
  End If
End Sub

Function ReadUtf8(file)
  Dim stream
  Set stream = CreateObject("ADODB.Stream")
  stream.Type = 2
  stream.Charset = "utf-8"
  stream.Open
  stream.LoadFromFile file
  ReadUtf8 = stream.ReadText
  stream.Close
End Function
