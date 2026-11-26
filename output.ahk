#Requires AutoHotkey v2.0
#SingleInstance Off
; Explicit #SingleInstance Off: helper modes (--check / --geometry) must never
; prompt or terminate an active resident --worker instance.
#Include background-input.ahk
#Include click-focus.ahk
; All clicks operate silently in the background without stealing OS foreground focus:
; tile discards use direct background client clicks; UI buttons, toggles, modals, paired
; sequences, and retries additionally send WM_ACTIVATE(WA_ACTIVE) so Unity's EventSystem
; processes UGUI onClick while keeping the window in the background, with no post-click teardown.
if A_Args.Length && A_Args[1] = "--check"
    ExitApp 0
if A_Args.Length && A_Args[1] = "--geometry" {
    targets := WinGetList("ahk_exe Jantama_MahjongSoul.exe ahk_class UnityWndClass")
    if targets.Length != 1
        ExitApp 2
    WinGetClientPos &cx, &cy, &cw, &ch, "ahk_id " targets[1]
    FileAppend cx "`t" cy "`t" cw "`t" ch "`n", "*", "UTF-8"
    ExitApp 0
}

; Output only. The recognizer owns tile identification and post-click verification.
; Line format: id<TAB>expiry_unix_seconds<TAB>client_width<TAB>client_height<TAB>action<TAB>x<TAB>y[<TAB>nextX<TAB>nextY]
; Coordinates are CLIENT coordinates, excluding the window title bar.
queueDir := A_ScriptDir "\queue"
DirCreate queueDir
lastId := ""
hStdIn := DllCall("kernel32\GetStdHandle", "Int", -10, "Ptr")
hStdOut := DllCall("kernel32\GetStdHandle", "Int", -11, "Ptr")

try {
    PrepareVirtualPointer()
} catch as err {
    FileAppend err.Message "`n", "**", "UTF-8"
    ExitApp 1
}

if A_Args.Length >= 2 && A_Args[1] = "--worker" {
    RunPipeWorker(A_Args[2])
    ExitApp 0
}

if A_Args.Length && A_Args[1] = "--once" {
    DispatchFileOnce()
    ExitApp 0
}

Persistent
SetTimer DispatchFileOnce, 50
F12::ExitApp

WritePipeLine(text) {
    global hStdOut
    line := text "`n"
    size := StrPut(line, "UTF-8") - 1
    if size <= 0
        return
    buf := Buffer(size)
    StrPut(line, buf, size, "UTF-8")
    written := 0
    DllCall("kernel32\WriteFile", "Ptr", hStdOut, "Ptr", buf, "UInt", size, "UInt*", &written, "Ptr", 0)
}

RunPipeWorker(readyToken) {
    global hStdIn
    WritePipeLine(readyToken "`tready")
    pending := ""
    chunk := Buffer(4096)
    Loop {
        bytes := 0
        ok := DllCall("kernel32\ReadFile", "Ptr", hStdIn, "Ptr", chunk, "UInt", 4096, "UInt*", &bytes, "Ptr", 0)
        if !ok || bytes = 0
            break
        pending .= StrGet(chunk, bytes, "UTF-8")
        while (pos := InStr(pending, "`n")) {
            line := RTrim(SubStr(pending, 1, pos - 1), "`r")
            pending := SubStr(pending, pos + 1)
            if line = ""
                continue
            if line = "__quit__"
                return
            try {
                ack := HandleRequestLine(line)
            } catch as err {
                clean := StrReplace(StrReplace(err.Message, "`t", " "), "`n", " ")
                ack := "unknown`trejected`tunhandled_worker_error:" clean
            }
            WritePipeLine(ack)
        }
    }
}

DispatchFileOnce() {
    global queueDir
    request := queueDir "\request.tsv"
    if !FileExist(request)
        return
    processing := queueDir "\processing.tsv"
    ack := "unknown`trejected`tfile_dispatch_failed"
    try {
        FileMove request, processing, 1
        line := Trim(FileRead(processing, "UTF-8"), "`r`n")
        ack := HandleRequestLine(line)
    } catch as err {
        clean := StrReplace(StrReplace(err.Message, "`t", " "), "`n", " ")
        ack := "unknown`trejected`t" clean
    }
    FileAppend ack "`n", queueDir "\ack.tsv", "UTF-8"
    if FileExist(processing)
        FileMove processing, queueDir "\last-request.tsv", 1
}

HandleRequestLine(rawLine) {
    global lastId
    id := "unknown"
    status := "rejected"
    detail := ""
    silentActivated := false, activationMs := 0
    sentCount := 0
    started := A_TickCount
    hwnd := 0
    try {
        fields := StrSplit(Trim(rawLine, "`r`n"), "`t")
        if fields.Length != 7 && fields.Length != 9
            throw Error("invalid_field_count")
        paired := fields[5] = "call_choice" || fields[5] = "riichi_discard"
        if (fields.Length = 9) != paired
            throw Error("invalid_sequence_fields")
        id := fields[1]
        if !RegExMatch(id, "^[A-Za-z0-9_-]{1,80}$") || id = lastId
            throw Error("invalid_or_duplicate_id")
        lastId := id
        now := DateDiff(A_NowUTC, "19700101000000", "Seconds")
        expires := Number(fields[2])
        if expires < now || expires > now + 15
            throw Error("expired_or_excessive_deadline")
        action := fields[5]
        if action = "ping" {
            status := "input_sent"
            detail := "pong;driver_ms=" (A_TickCount - started)
            return id "`t" status "`t" detail
        }
        if action != "retry_click" && action != "click" && action != "ui_click" && action != "double_click_500" && action != "startup_focus" && action != "modal_confirm" && !paired
            throw Error("unsupported_action")
        windows := WinGetList("ahk_exe Jantama_MahjongSoul.exe ahk_class UnityWndClass")
        if windows.Length != 1
            throw Error("target_window_not_unique")
        hwnd := windows[1]
        needsSilentActivate := paired || action = "click" || action = "ui_click" || action = "modal_confirm" || action = "retry_click" || action = "double_click_500"
        if action = "startup_focus" {
            if hwnd != Number(fields[3]) || Number(fields[4]) != 0 || Number(fields[6]) != 0 || Number(fields[7]) != 0
                throw Error("startup_target_mismatch")
            detail := StartupFocusProbe(hwnd)
            status := "input_sent"
        } else {
            ; Capture foreground BEFORE RestoreWithoutActivation so any accidental OS activation
            ; during minimized restore is honestly detected rather than masked.
            foreground := DllCall("user32\GetForegroundWindow", "Ptr")
            RestoreWithoutActivation(hwnd)
            WinGetClientPos , , &width, &height, "ahk_id " hwnd
            if width != Number(fields[3]) || height != Number(fields[4])
                throw Error("window_size_changed")
            x := Number(fields[6]), y := Number(fields[7])
            if x < 0 || y < 0 || x >= width || y >= height
                throw Error("coordinate_out_of_bounds")
            if paired {
                nextX := Number(fields[8]), nextY := Number(fields[9])
                if nextX < 0 || nextY < 0 || nextX >= width || nextY >= height
                    throw Error("coordinate_out_of_bounds")
            }
            if needsSilentActivate && DllCall("user32\GetForegroundWindow", "Ptr") != hwnd {
                activationStarted := A_TickCount
                ; Pre-position virtual pointer before WA_ACTIVE so Unity never hovers over the
                ; user's physical cursor position during the 30ms activation settle window.
                VirtualPointerCommand("--set", hwnd, x, y)
                SilentWindowActivate(hwnd, true)
                silentActivated := true
                Sleep 30
                activationMs := A_TickCount - activationStarted
            }
            Loop (paired ? 2 : 1) {
                if A_Index = 2 {
                    x := nextX, y := nextY
                }
                WinGetClientPos , , &currentWidth, &currentHeight, "ahk_id " hwnd
                if currentWidth != width || currentHeight != height
                    throw Error("window_size_changed")
                if DateDiff(A_NowUTC, "19700101000000", "Seconds") > expires
                    throw Error("expired_before_message")
                ClientMouseMessage(hwnd, 0x200, x, y)
                moved := A_TickCount
                Sleep 100
                ClientMouseButton(hwnd, x, y, true)
                sentCount += 1
                pressed := A_TickCount
                try {
                    Sleep 100
                } finally {
                    ClientMouseButton(hwnd, x, y, false)
                }
                if action = "double_click_500" {
                    Sleep 500
                    ClientMouseButton(hwnd, x, y, true)
                    sentCount += 1
                    try {
                        Sleep 100
                    } finally {
                        ClientMouseButton(hwnd, x, y, false)
                    }
                }
                released := A_TickCount
                ; Keep inter-step delay ONLY between step 1 and step 2 of a paired sequence.
                if paired && A_Index = 1
                    Sleep 130
            }
            settled := A_TickCount
            status := "input_sent"
            method := VirtualPointerEnabled() ? "virtual_pointer" : "send_message_timeout"
            detail := "requires_fresh_visual_confirmation;method=" method ";silent_activate=" (silentActivated ? 1 : 0) ";target=" x "," y ";foreground_before=" foreground ";activation_ms=" activationMs ";pre_down_ms=" (pressed - moved) ";hold_ms=" (released - pressed) ";post_up_ms=" (settled - released) ";driver_ms=" (A_TickCount - started)
        }
    } catch as err {
        detail := StrReplace(StrReplace(err.Message, "`t", " "), "`n", " ")
        if sentCount > 0 {
            status := "partial_input"
            detail := "sent=" sentCount ";" detail
        }
    }
    if status = "input_sent" && IsSet(foreground) {
        afterForeground := DllCall("user32\GetForegroundWindow", "Ptr")
        detail .= ";foreground_after=" afterForeground ";foreground_preserved=" (foreground = afterForeground ? 1 : 0)
    }
    return id "`t" status "`t" detail
}
