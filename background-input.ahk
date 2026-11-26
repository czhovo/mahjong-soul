; Direct client-coordinate input only: no activation and no physical cursor movement.
VirtualPointerEnabled() {
    return A_Args.Length >= 3 && A_Args[3] = "--virtual-pointer"
}

VirtualPointerCommand(mode, hwnd, x := 0, y := 0) {
    if !VirtualPointerEnabled()
        return
    if mode = "--set" {
        WriteVirtualPointer(hwnd, x, y)
        return
    }
    if mode != "--prepare"
        throw Error("virtual_pointer_failed:unsupported_command")
    helper := VirtualPointerHelper()
    if !FileExist(helper)
        throw Error("virtual_pointer_helper_missing")
    report := A_ScriptDir "\queue\virtual-pointer-result.log"
    command := '"' helper '" ' mode ' ' hwnd ' ' DllCall("GetCurrentProcessId", "UInt")
    command .= ' --report "' report '"'
    code := RunWait(command, A_ScriptDir, "Hide")
    if code != 0 {
        detail := FileExist(report) ? Trim(FileRead(report, "UTF-8"), "`r`n") : "exit=" code
        throw Error("virtual_pointer_failed:" detail)
    }
}

VirtualPointerHelper() {
    ; Both table modes must use the same installed helper path.
    if FileExist(A_ScriptDir "\bin\pointer\windows-x86\virtual-pointer.exe")
        return A_ScriptDir "\bin\pointer\windows-x86\virtual-pointer.exe"
    SplitPath A_ScriptDir, , &parentDir
    return parentDir "\bin\pointer\windows-x86\virtual-pointer.exe"
}

PrepareVirtualPointer() {
    if !VirtualPointerEnabled()
        return
    windows := WinGetList("ahk_exe Jantama_MahjongSoul.exe ahk_class UnityWndClass")
    if windows.Length != 1
        throw Error("target_window_not_unique")
    VirtualPointerCommand("--prepare", windows[1])
    ConnectVirtualPointer(windows[1])
}

; Retain the mapping and writer mutex for the lifetime of this AHK worker:
; normal clicks never launch a process, enumerate modules or write a report.
ConnectVirtualPointer(hwnd) {
    global virtualPointerMapping, virtualPointerView, virtualPointerMutex
    virtualPointerMapping := 0, virtualPointerView := 0, virtualPointerMutex := 0
    gamePid := 0
    DllCall("user32\GetWindowThreadProcessId", "Ptr", hwnd, "UInt*", &gamePid, "UInt")
    try {
        virtualPointerMapping := DllCall("kernel32\OpenFileMappingW", "UInt", 6, "Int", false, "Str", "Local\Tingfeng.VirtualPointer." gamePid, "Ptr")
        if !virtualPointerMapping
            throw Error("mapping_open_failed:" A_LastError)
        virtualPointerView := DllCall("kernel32\MapViewOfFile", "Ptr", virtualPointerMapping, "UInt", 6, "UInt", 0, "UInt", 0, "UPtr", 64, "Ptr")
        if !virtualPointerView
            throw Error("mapping_view_failed:" A_LastError)
        virtualPointerMutex := DllCall("kernel32\OpenMutexW", "UInt", 0x100001, "Int", false, "Str", "Local\Tingfeng.VirtualPointer.Writer." gamePid, "Ptr")
        ; The short-lived loader closes its mutex on exit; create it again if
        ; needed. Its name and semantics remain identical for all writers.
        if !virtualPointerMutex
            virtualPointerMutex := DllCall("kernel32\CreateMutexW", "Ptr", 0, "Int", false, "Str", "Local\Tingfeng.VirtualPointer.Writer." gamePid, "Ptr")
        if !virtualPointerMutex
            throw Error("writer_mutex_failed:" A_LastError)
        ValidateVirtualPointer(hwnd)
        OnExit(CloseVirtualPointer)
    } catch as err {
        CloseVirtualPointer()
        throw Error("virtual_pointer_failed:" err.Message)
    }
}

ValidateVirtualPointer(hwnd) {
    global virtualPointerView
    if !IsSet(virtualPointerView) || !virtualPointerView
        throw Error("mapping_not_connected")
    view := virtualPointerView
    gamePid := 0
    DllCall("user32\GetWindowThreadProcessId", "Ptr", hwnd, "UInt*", &gamePid, "UInt")
    if !gamePid || NumGet(view, 0, "UInt") != 0x56505446 || NumGet(view, 4, "UInt") != 1 || NumGet(view, 8, "UInt") != 20261114 || NumGet(view, 12, "UInt") != gamePid
        throw Error("incompatible_virtual_pointer_helper")
    if NumGet(view, 20, "UInt") != DllCall("kernel32\GetCurrentProcessId", "UInt")
        throw Error("virtual_pointer_owned_by_another_controller")
    if NumGet(view, 48, "Int") != 1 || NumGet(view, 52, "Int") <= 0
        throw Error("virtual_pointer_hook_not_ready:" NumGet(view, 56, "Int"))
}

WriteVirtualPointer(hwnd, x, y) {
    global virtualPointerView, virtualPointerMutex
    try {
        ValidateVirtualPointer(hwnd)
        client := Buffer(16, 0)
        if !DllCall("user32\GetClientRect", "Ptr", hwnd, "Ptr", client, "Int") || x < 0 || y < 0 || x >= NumGet(client, 8, "Int") || y >= NumGet(client, 12, "Int")
            throw Error("invalid_virtual_pointer_target")
        acquired := DllCall("kernel32\WaitForSingleObject", "Ptr", virtualPointerMutex, "UInt", 100, "UInt")
        if acquired != 0 && acquired != 0x80
            throw Error("virtual_pointer_writer_busy")
        try {
            ValidateVirtualPointer(hwnd)
            view := virtualPointerView
            sequence := NumGet(view, 16, "UInt")
            if sequence & 1
                throw Error("virtual_pointer_writer_incomplete")
            ; The bundled AutoHotkey64.exe is x64. Aligned DWORD stores are
            ; atomic and x86/x64 preserves their order. Separate NumPut calls
            ; cannot be reordered by the interpreter. The game-side reader
            ; retains its Interlocked sequence reads and full memory barrier.
            ; InterlockedIncrement is an intrinsic, not a kernel32 x64 export.
            NumPut("UInt", (sequence + 1) & 0xFFFFFFFF, view, 16)
            NumPut("UInt", hwnd, view, 24)
            NumPut("Int", x, view, 28)
            NumPut("Int", y, view, 32)
            NumPut("UInt", DllCall("kernel32\GetTickCount", "UInt"), view, 36)
            NumPut("UInt", 2500, view, 40)
            NumPut("Int", 1, view, 44)
            NumPut("UInt", (sequence + 2) & 0xFFFFFFFF, view, 16)
        } finally {
            DllCall("kernel32\ReleaseMutex", "Ptr", virtualPointerMutex, "Int")
        }
    } catch as err {
        throw Error("virtual_pointer_failed:" err.Message)
    }
}

CloseVirtualPointer(*) {
    global virtualPointerMapping, virtualPointerView, virtualPointerMutex
    if IsSet(virtualPointerView) && virtualPointerView {
        DllCall("kernel32\UnmapViewOfFile", "Ptr", virtualPointerView, "Int")
        virtualPointerView := 0
    }
    if IsSet(virtualPointerMapping) && virtualPointerMapping {
        DllCall("kernel32\CloseHandle", "Ptr", virtualPointerMapping, "Int")
        virtualPointerMapping := 0
    }
    if IsSet(virtualPointerMutex) && virtualPointerMutex {
        DllCall("kernel32\CloseHandle", "Ptr", virtualPointerMutex, "Int")
        virtualPointerMutex := 0
    }

}

CheckBackgroundTarget(hwnd) {
    if !DllCall("user32\IsWindow", "Ptr", hwnd, "Int")
        throw Error("target_window_closed")
    if DllCall("user32\IsIconic", "Ptr", hwnd, "Int")
        throw Error("target_window_minimized")
}

ClientMouseMessage(hwnd, message, x, y, buttons := 0) {
    CheckBackgroundTarget(hwnd)
    if message != 0x200
        throw Error("unsupported_background_mouse_message")
    VirtualPointerCommand("--set", hwnd, x, y)
    position := ((y & 0xFFFF) << 16) | (x & 0xFFFF)
    reply := Buffer(A_PtrSize, 0)
    ; Deliver the client-coordinate move to the window procedure before the
    ; following button event. A reply still is not proof of an in-game effect.
    if !DllCall("user32\SendMessageTimeoutW", "Ptr", hwnd, "UInt", message, "UPtr", buttons, "Ptr", position, "UInt", 3, "UInt", 750, "Ptr", reply, "Ptr")
        throw Error("background_message_failed:" A_LastError)
}

ClientMouseButton(hwnd, x, y, down) {
    CheckBackgroundTarget(hwnd)
    VirtualPointerCommand("--set", hwnd, x, y)
    position := ((y & 0xFFFF) << 16) | (x & 0xFFFF)
    message := down ? 0x201 : 0x202
    buttons := down ? 1 : 0
    reply := Buffer(A_PtrSize, 0)
    ; Deliver WM_LBUTTONDOWN / WM_LBUTTONUP with a bounded timeout (SMTO_BLOCK | SMTO_ABORTIFHUNG = 3)
    ; so a momentary Unity frame stall never hangs the driver indefinitely while remaining
    ; 100% compatible with the virtual-pointer hook and background non-activating clicks.
    if !DllCall("user32\SendMessageTimeoutW", "Ptr", hwnd, "UInt", message, "UPtr", buttons, "Ptr", position, "UInt", 3, "UInt", 750, "Ptr", reply, "Ptr")
        throw Error("background_message_failed:" A_LastError)
}

SilentWindowActivate(hwnd, active) {
    CheckBackgroundTarget(hwnd)
    ; Deliver WM_ACTIVATE (WA_ACTIVE=1 / WA_INACTIVE=0) directly to Unity's WndProc without
    ; calling SetForegroundWindow/WinActivate. Unity updates Application.isFocused and
    ; EventSystem.m_HasFocus so UGUI buttons & toggles fire onClick in the background
    ; without stealing OS foreground focus, raising Z-order, or moving the physical cursor.
    if active {
        reply := Buffer(A_PtrSize, 0)
        if !DllCall("user32\SendMessageTimeoutW", "Ptr", hwnd, "UInt", 0x0006, "UPtr", 1, "Ptr", 0, "UInt", 3, "UInt", 750, "Ptr", reply, "Ptr")
            throw Error("background_activate_failed:" A_LastError)
    } else {
        ; Use SendNotifyMessageW (NOT PostMessageW): cross-thread SendNotifyMessageW returns
        ; immediately without blocking during scene loads, while staying in the Win32
        ; sent-message queue in strict FIFO order with subsequent SendMessageTimeoutW(WA_ACTIVE)
        ; and real OS foreground activations (preventing sent-before-posted reordering).
        if !DllCall("user32\SendNotifyMessageW", "Ptr", hwnd, "UInt", 0x0006, "UPtr", 0, "Ptr", 0, "Int")
            throw Error("background_deactivate_failed:" A_LastError)
        ; Unity's WndProc calls SetFocus(hwnd) on WM_ACTIVATE(WA_ACTIVE), which leaves the
        ; game thread's THREADINFO->hwndActive/hwndFocus stuck on hwnd even after WA_INACTIVE.
        ; Clear that background thread-active state via an invisible HWND_MESSAGE window so a
        ; later minimized restore (SW_SHOWNOACTIVATE) never steals OS foreground focus.
        ClearBackgroundThreadActive(hwnd)
    }
}

GetMessageOnlyDummyWindow() {
    global silentMessageDummyHwnd
    if IsSet(silentMessageDummyHwnd) && silentMessageDummyHwnd && DllCall("user32\IsWindow", "Ptr", silentMessageDummyHwnd, "Int")
        return silentMessageDummyHwnd
    ; WS_EX_NOACTIVATE (0x08000000) + WS_DISABLED (0x08000000) + HWND_MESSAGE (-3):
    ; invisible disabled message-only window that clears gameTid's THREADINFO->hwndActive
    ; via SetActiveWindow without ever becoming the OS foreground window.
    silentMessageDummyHwnd := DllCall("user32\CreateWindowExW", "UInt", 0x08000000, "Str", "STATIC", "Str", "", "UInt", 0x08000000, "Int", 0, "Int", 0, "Int", 0, "Int", 0, "Ptr", -3, "Ptr", 0, "Ptr", 0, "Ptr", 0, "Ptr")
    return silentMessageDummyHwnd
}

ClearBackgroundThreadActive(hwnd) {
    if !DllCall("user32\IsWindow", "Ptr", hwnd, "Int")
        return
    if DllCall("user32\GetForegroundWindow", "Ptr") = hwnd
        return
    gameTid := DllCall("user32\GetWindowThreadProcessId", "Ptr", hwnd, "Ptr", 0, "UInt")
    myTid := DllCall("kernel32\GetCurrentThreadId", "UInt")
    if !gameTid || gameTid = myTid
        return
    ; Check GetGUIThreadInfo first; skip AttachThreadInput when already clean.
    gtiSize := A_PtrSize = 8 ? 72 : 48
    gti := Buffer(gtiSize, 0)
    NumPut("UInt", gtiSize, gti, 0)
    if DllCall("user32\GetGUIThreadInfo", "UInt", gameTid, "Ptr", gti, "Int") {
        activeOff := 8
        focusOff := activeOff + A_PtrSize
        if NumGet(gti, activeOff, "Ptr") != hwnd && NumGet(gti, focusOff, "Ptr") != hwnd
            return
    }
    dummy := GetMessageOnlyDummyWindow()
    if !dummy
        return
    if DllCall("user32\GetForegroundWindow", "Ptr") = hwnd
        return
    if DllCall("user32\AttachThreadInput", "UInt", myTid, "UInt", gameTid, "Int", true, "Int") {
        try {
            if DllCall("user32\GetForegroundWindow", "Ptr") != hwnd {
                DllCall("user32\SetActiveWindow", "Ptr", dummy, "Ptr")
                DllCall("user32\SetFocus", "Ptr", 0, "Ptr")
            }
        } finally {
            DllCall("user32\AttachThreadInput", "UInt", myTid, "UInt", gameTid, "Int", false, "Int")
        }
    }
}

GetWindowExStyle(hwnd) {
    fn := A_PtrSize = 8 ? "user32\GetWindowLongPtrW" : "user32\GetWindowLongW"
    return DllCall(fn, "Ptr", hwnd, "Int", -20, "Ptr")
}

SetWindowExStyle(hwnd, style) {
    fn := A_PtrSize = 8 ? "user32\SetWindowLongPtrW" : "user32\SetWindowLongW"
    return DllCall(fn, "Ptr", hwnd, "Int", -20, "Ptr", style, "Ptr")
}

RestoreWithoutActivation(hwnd) {
    if !DllCall("user32\IsWindow", "Ptr", hwnd, "Int")
        throw Error("target_window_closed")
    if !DllCall("user32\IsIconic", "Ptr", hwnd, "Int")
        return
    ; Clear any stale background THREADINFO->hwndActive before un-minimizing so
    ; SW_SHOWNOACTIVATE never promotes the restored window to OS foreground.
    ClearBackgroundThreadActive(hwnd)
    origEx := GetWindowExStyle(hwnd)
    addedNoActivate := !(origEx & 0x08000000)
    if addedNoActivate
        SetWindowExStyle(hwnd, origEx | 0x08000000)
    try {
        DllCall("user32\ShowWindowAsync", "Ptr", hwnd, "Int", 4, "Int")
        client := Buffer(16, 0)
        restored := false
        Loop 20 {
            if !DllCall("user32\IsIconic", "Ptr", hwnd, "Int")
                && DllCall("user32\GetClientRect", "Ptr", hwnd, "Ptr", client, "Int")
                && NumGet(client, 8, "Int") > 0 && NumGet(client, 12, "Int") > 0 {
                restored := true
                break
            }
            Sleep 50
        }
        if !restored
            throw Error("target_window_minimized")
        DllCall("user32\SetWindowPos", "Ptr", hwnd, "Ptr", 1, "Int", 0, "Int", 0, "Int", 0, "Int", 0, "UInt", 0x0013, "Int")
    } finally {
        if addedNoActivate && DllCall("user32\IsWindow", "Ptr", hwnd, "Int")
            SetWindowExStyle(hwnd, origEx)
    }
}

MinimizeWithoutActivation(hwnd) {
    if !DllCall("user32\IsWindow", "Ptr", hwnd, "Int") || DllCall("user32\IsIconic", "Ptr", hwnd, "Int")
        return
    ; SW_SHOWMINNOACTIVE (7) minimizes without activating another window or shifting focus.
    DllCall("user32\ShowWindowAsync", "Ptr", hwnd, "Int", 7, "Int")
    Loop 20 {
        if DllCall("user32\IsIconic", "Ptr", hwnd, "Int")
            return
        Sleep 50
    }
}
