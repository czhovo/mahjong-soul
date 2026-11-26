#Requires AutoHotkey v2.0
#SingleInstance Off
#Include %A_ScriptDir%\background-input.ahk
try {
    hwnd := Integer(A_Args[1])
    target := "ahk_id " hwnd
    if StrLower(WinGetProcessName(target)) != "jantama_mahjongsoul.exe"
        throw Error("Target is not Mahjong Soul")
    RestoreWithoutActivation(hwnd)
    directClick := A_Args.Length >= 2 && A_Args[2] = "--title-click"
    if directClick {
        ; Keep the existing blank-area recovery action, addressed to the
        ; client's HWND instead of the desktop. Never raise or activate it.
        WinGetClientPos , , &width, &height, target
        if width <= 0 || height <= 0
            throw Error("invalid_client_size")
        x := Round(width * 0.05), y := Round(height * 0.95)
        ClientMouseMessage(hwnd, 0x200, x, y)
        Sleep 100
        ClientMouseButton(hwnd, x, y, true)
        try {
            Sleep 200
        } finally {
            ClientMouseButton(hwnd, x, y, false)
        }
        Sleep 160
        ClientMouseMessage(hwnd, 0x200, Round(width * 0.03), Round(height * 0.94))
        FileAppend "background_recovery_messages_sent", "*"
    } else {
        FileAppend "window_available_without_activation", "*"
    }
} catch as err {
    FileAppend err.Message, "**"
    ExitApp 1
}
ExitApp 0
