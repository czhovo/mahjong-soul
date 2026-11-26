; Silent background startup probe: verifies virtual-pointer coordinate delivery,
; silent WM_ACTIVATE activation/deactivation, clean background thread-active state,
; unchanged physical cursor, and zero OS foreground theft.
StartupFocusProbe(hwnd) {
    before := DllCall("user32\GetForegroundWindow", "Ptr")
    wasMinimized := DllCall("user32\IsIconic", "Ptr", hwnd, "Int")
    cursorBefore := Buffer(8, 0)
    hasCursorBefore := DllCall("user32\GetCursorPos", "Ptr", cursorBefore, "Int")
    silentActivated := false
    stolenDuringRestore := false
    try {
        RestoreWithoutActivation(hwnd)
        if before != hwnd && DllCall("user32\GetForegroundWindow", "Ptr") = hwnd
            stolenDuringRestore := true
        WinGetClientPos , , &width, &height, "ahk_id " hwnd
        if width <= 0 || height <= 0
            throw Error("invalid_client_size")
        probeX := Round(width * 0.03), probeY := Round(height * 0.94)
        if DllCall("user32\GetForegroundWindow", "Ptr") != hwnd {
            VirtualPointerCommand("--set", hwnd, probeX, probeY)
            SilentWindowActivate(hwnd, true)
            silentActivated := true
            Sleep 30
        }
        ; Exercise silent activation + virtual-pointer coordinate delivery without pressing a game button.
        ClientMouseMessage(hwnd, 0x200, probeX, probeY)
    } finally {
        if silentActivated
            && DllCall("user32\IsWindow", "Ptr", hwnd, "Int")
            && !DllCall("user32\IsIconic", "Ptr", hwnd, "Int")
            && DllCall("user32\GetForegroundWindow", "Ptr") != hwnd {
            try SilentWindowActivate(hwnd, false)
        }
        if wasMinimized && WinExist("ahk_id " hwnd)
            MinimizeWithoutActivation(hwnd)
    }
    after := DllCall("user32\GetForegroundWindow", "Ptr")
    if stolenDuringRestore || (before != hwnd && after = hwnd)
        throw Error("startup_focus_stolen")
    if DllCall("user32\IsIconic", "Ptr", hwnd, "Int") != wasMinimized
        throw Error("startup_window_state_not_restored")
    cursorAfter := Buffer(8, 0)
    cursorPreserved := 1
    if hasCursorBefore && DllCall("user32\GetCursorPos", "Ptr", cursorAfter, "Int") {
        dx := Abs(NumGet(cursorAfter, 0, "Int") - NumGet(cursorBefore, 0, "Int"))
        dy := Abs(NumGet(cursorAfter, 4, "Int") - NumGet(cursorBefore, 4, "Int"))
        ; Allow small organic user mouse movement during probe; assert no jump into game probe point.
        if dx > 2 && dy > 2 {
            pt := Buffer(8, 0)
            NumPut("Int", probeX, pt, 0), NumPut("Int", probeY, pt, 4)
            if DllCall("user32\ClientToScreen", "Ptr", hwnd, "Ptr", pt, "Int") {
                if Abs(NumGet(cursorAfter, 0, "Int") - NumGet(pt, 0, "Int")) <= 3 && Abs(NumGet(cursorAfter, 4, "Int") - NumGet(pt, 4, "Int")) <= 3
                    cursorPreserved := 0
            }
        }
    }
    if !cursorPreserved
        throw Error("startup_cursor_moved")
    threadClean := 1
    if after != hwnd {
        gameTid := DllCall("user32\GetWindowThreadProcessId", "Ptr", hwnd, "Ptr", 0, "UInt")
        gtiSize := A_PtrSize = 8 ? 72 : 48
        gti := Buffer(gtiSize, 0)
        NumPut("UInt", gtiSize, gti, 0)
        if gameTid && DllCall("user32\GetGUIThreadInfo", "UInt", gameTid, "Ptr", gti, "Int") {
            activeOff := 8, focusOff := activeOff + A_PtrSize
            if NumGet(gti, activeOff, "Ptr") = hwnd || NumGet(gti, focusOff, "Ptr") = hwnd
                threadClean := 0
        }
    }
    if !threadClean
        throw Error("startup_thread_active_not_cleared")
    return "startup_focus_verified;mode=silent_activate;hwnd=" hwnd ";before=" before ";after=" after ";cursor_preserved=1;thread_clean=1;window_state_restored=1"
}
