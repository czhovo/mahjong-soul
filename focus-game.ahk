#Requires AutoHotkey v2.0
#SingleInstance Off
try {
    hwnd := Integer(A_Args[1])
    target := "ahk_id " hwnd
    if StrLower(WinGetProcessName(target)) != "jantama_mahjongsoul.exe"
        throw Error("Target is not Mahjong Soul")
    if WinGetMinMax(target) = -1
        WinRestore target
    directClick := A_Args.Length >= 2 && A_Args[2] = "--title-click"
    if !directClick {
        ; Foreground recovery must actually raise the target. A screen click
        ; alone can hit the window covering Mahjong Soul.
        if DllCall("GetForegroundWindow", "Ptr") != hwnd {
            WinActivate target
            WinWaitActive target, , 0.35
        }
        if DllCall("GetForegroundWindow", "Ptr") = hwnd && WinGetMinMax(target) != -1 {
            FileAppend "foreground_restored", "*"
            ExitApp 0
        }
    }
    ; A frozen window may not answer activation or hit-test messages. Use its
    ; OS-maintained rectangle and send a physical bottom-left blank-area click directly.
    WinGetPos &wx, &wy, &ww, &wh, target
    x := wx + Round(ww * 0.05), y := wy + wh - Round(wh * 0.05)
    CoordMode "Mouse", "Screen"
    MouseGetPos &oldX, &oldY
    ; Release any lower-priority click interrupted during its mouse hold.
    Click "Up"
    Click x, y
    MouseMove oldX, oldY, 0
    if directClick {
        FileAppend "recovery_blank_clicked", "*"
    } else {
        ; Activation failure still gets the requested physical recovery click,
        ; but sending that click is not proof that focus was recovered.
        WinWaitActive target, , 0.2
        if DllCall("GetForegroundWindow", "Ptr") != hwnd || WinGetMinMax(target) = -1
            throw Error("Unable to activate Mahjong Soul after recovery click")
        FileAppend "foreground_restored_after_recovery_click", "*"
    }
} catch as err {
    FileAppend err.Message, "**"
    ExitApp 1
}
ExitApp 0
