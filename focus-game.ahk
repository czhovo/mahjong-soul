#Requires AutoHotkey v2.0
#SingleInstance Off
#Include %A_ScriptDir%\background-input.ahk
try {
    hwnd := Integer(A_Args[1])
    target := "ahk_id " hwnd
    if StrLower(WinGetProcessName(target)) != "jantama_mahjongsoul.exe"
        throw Error("Target is not Mahjong Soul")
    RestoreWithoutActivation(hwnd)
    FileAppend "window_available_without_activation", "*"
} catch as err {
    FileAppend err.Message, "**"
    ExitApp 1
}
ExitApp 0
