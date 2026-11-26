CaptureClickContext(hwnd) {
    pos := Buffer(8)
    if !DllCall("user32\GetCursorPos", "Ptr", pos, "Int")
        throw Error("cursor_snapshot_failed")
    return {previous: DllCall("user32\GetForegroundWindow", "Ptr"), cursor: pos, minimized: DllCall("user32\IsIconic", "Ptr", hwnd, "Int")}
}

ActivateClickWindow(hwnd) {
    target := "ahk_id " hwnd
    if !WinActive(target) {
        try WinActivate target
        catch
            throw Error("click_target_not_foreground")
        if !WinWaitActive(target,, 0.4)
            throw Error("click_target_not_foreground")
    }
}

RestoreClickContext(hwnd, ctx) {
    try {
        ; Do not take focus away from a third window selected during the click.
        ; Skip immediately if the previous foreground window no longer exists,
        ; is hidden, or is minimized to avoid pointless focus-wait stalls.
        ownsFocus := WinActive("ahk_id " hwnd)
        prevValid := ctx.previous && ctx.previous != hwnd
            && DllCall("user32\IsWindow", "Ptr", ctx.previous, "Int")
            && DllCall("user32\IsWindowVisible", "Ptr", ctx.previous, "Int")
            && !DllCall("user32\IsIconic", "Ptr", ctx.previous, "Int")
        if ownsFocus && prevValid {
            WinActivate "ahk_id " ctx.previous
            if !WinWaitActive("ahk_id " ctx.previous,, 0.18)
                throw Error("previous_foreground_not_restored")
        }
    } finally {
        try {
            if ctx.minimized && WinExist("ahk_id " hwnd)
                WinMinimize "ahk_id " hwnd
        } finally {
            if !DllCall("user32\SetCursorPos", "Int", NumGet(ctx.cursor, 0, "Int"), "Int", NumGet(ctx.cursor, 4, "Int"), "Int")
                throw Error("cursor_not_restored")
        }
    }
}

