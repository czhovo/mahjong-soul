#Requires AutoHotkey v2.0
#SingleInstance Off
#NoTrayIcon
#Include %A_ScriptDir%\background-input.ahk
#Include %A_ScriptDir%\click-focus.ahk

try {
    hwnd := Integer(A_Args[1])
    if !hwnd || !WinExist("ahk_id " hwnd " ahk_exe Jantama_MahjongSoul.exe ahk_class UnityWndClass")
        throw Error("decision_target_window_missing")
    ctx := CaptureClickContext(hwnd)
    try {
        RestoreWithoutActivation(hwnd)
        ActivateClickWindow(hwnd)
        FileAppend "ready`n", "*", "UTF-8-RAW"
        ; EOF also releases focus if the controller terminates unexpectedly.
        DllCall("ReadFile", "Ptr", DllCall("GetStdHandle", "Int", -10, "Ptr"), "Ptr", Buffer(1), "UInt", 1, "UInt*", &count := 0, "Ptr", 0)
    } finally {
        RestoreClickContext(hwnd, ctx)
    }
} catch as err {
    FileAppend err.Message "`n", "**", "UTF-8-RAW"
    ExitApp 1
}
