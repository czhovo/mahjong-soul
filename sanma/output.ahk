#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent
CoordMode "Mouse", "Client"
; Unity must receive distinct mouse events over rendered frames.
SendMode "Input"
SetMouseDelay 10
SetWinDelay 0
if A_Args.Length && A_Args[1] = "--check"
    ExitApp 0
if A_Args.Length && A_Args[1] = "--geometry" {
    targets := WinGetList("ahk_exe Jantama_MahjongSoul.exe")
    if targets.Length != 1
        ExitApp 2
    WinGetClientPos &cx, &cy, &cw, &ch, "ahk_id " targets[1]
    FileAppend cx "`t" cy "`t" cw "`t" ch "`n", "*", "UTF-8"
    ExitApp 0
}

; Output only. The recognizer owns tile identification and post-click verification.
; request.tsv: id<TAB>expiry_unix_seconds<TAB>client_width<TAB>client_height<TAB>click<TAB>x<TAB>y
; Coordinates are CLIENT coordinates, excluding the window title bar.
queueDir := A_ScriptDir "\queue"
DirCreate queueDir
lastId := ""
if A_Args.Length >= 2 && A_Args[1] = "--worker"
    FileAppend A_Args[2] "`tready`n", queueDir "\ack.tsv", "UTF-8"
if A_Args.Length && A_Args[1] = "--once" {
    Dispatch()
    ExitApp 0
}
SetTimer Dispatch, 50
F12::ExitApp

ClickRecoveryTitle(hwnd) {
    ; Physical click works without a responsive activation/hit-test message.
    WinGetPos &wx, &wy, &ww, &wh, "ahk_id " hwnd
    CoordMode "Mouse", "Screen"
    try {
        Click "Up"
        Click wx + Round(ww * 0.02), wy + wh - 12
    } finally {
        CoordMode "Mouse", "Client"
    }
}

Dispatch() {
    global queueDir, lastId
    request := queueDir "\request.tsv"
    if !FileExist(request)
        return
    SetTimer Dispatch, 0
    id := "unknown"
    status := "rejected"
    detail := ""
    sentCount := 0
    started := A_TickCount
    processing := queueDir "\processing.tsv"
    try {
        FileMove request, processing, 1
        fields := StrSplit(Trim(FileRead(processing, "UTF-8"), "`r`n"), "`t")
        if fields.Length != 7 && fields.Length != 9
            throw Error("invalid_field_count")
        if (fields.Length = 9) != (fields[5] = "call_choice")
            throw Error("invalid_sequence_fields")
        id := fields[1]
        if !RegExMatch(id, "^[A-Za-z0-9_-]{1,80}$") || id = lastId
            throw Error("invalid_or_duplicate_id")
        lastId := id
        now := DateDiff(A_NowUTC, "19700101000000", "Seconds")
        expires := Number(fields[2])
        if expires < now || expires > now + 15
            throw Error("expired_or_excessive_deadline")
        if fields[5] != "click" && fields[5] != "double_click_500" && fields[5] != "modal_confirm" && fields[5] != "call_choice"
            throw Error("unsupported_action")
        windows := WinGetList("ahk_exe Jantama_MahjongSoul.exe")
        if windows.Length != 1
            throw Error("target_window_not_unique")
        hwnd := windows[1]
        if true {
        WinGetClientPos , , &width, &height, "ahk_id " hwnd
        if width != Number(fields[3]) || height != Number(fields[4])
            throw Error("window_size_changed")
        x := Number(fields[6]), y := Number(fields[7])
        if x < 0 || y < 0 || x >= width || y >= height
            throw Error("coordinate_out_of_bounds")
        if fields[5] = "call_choice" {
            nextX := Number(fields[8]), nextY := Number(fields[9])
            if nextX < 0 || nextY < 0 || nextX >= width || nextY >= height
                throw Error("coordinate_out_of_bounds")
        }
        if !WinActive("ahk_id " hwnd)
            WinActivate "ahk_id " hwnd
        if !WinWaitActive("ahk_id " hwnd, , 1) {
            if fields[5] = "modal_confirm"
                throw Error("activation_failed")
            ClickRecoveryTitle(hwnd)
            if !WinWaitActive("ahk_id " hwnd, , 0.25)
                throw Error("activation_failed")
        }
        if DateDiff(A_NowUTC, "19700101000000", "Seconds") > expires
            throw Error("expired_after_activation")
        activated := A_TickCount
        Loop (fields[5] = "call_choice" ? 2 : 1) {
        if A_Index = 2 {
            x := nextX, y := nextY
            WinGetClientPos , , &currentWidth, &currentHeight, "ahk_id " hwnd
            if currentWidth != width || currentHeight != height
                throw Error("window_size_changed")
        }
        MouseMove x, y, 0
        moved := A_TickCount
        Sleep 100
        MouseGetPos &downX, &downY
        if !WinActive("ahk_id " hwnd) {
            if fields[5] = "modal_confirm"
                throw Error("activation_failed")
            ClickRecoveryTitle(hwnd)
            if !WinWaitActive("ahk_id " hwnd, , 0.25)
                throw Error("activation_failed")
            MouseMove x, y, 0
            Sleep 30
            MouseGetPos &downX, &downY
        }
        ; Correct pointer drift while still on the same verified game window.
        ; Never click a different foreground window or skip the final check.
        if WinActive("ahk_id " hwnd) && (Abs(downX-x)>2 || Abs(downY-y)>2) {
            MouseMove x, y, 0
            Sleep 30
            MouseGetPos &downX, &downY
        }
        if !WinActive("ahk_id " hwnd) || Abs(downX-x)>2 || Abs(downY-y)>2
            throw Error("focus_or_pointer_changed_before_down")
        Click "Down"
        sentCount += 1
        pressed := A_TickCount
        try {
            Sleep (fields[5] = "double_click_500" ? 30 : 200)
        } finally {
            Click "Up"
        }
        if fields[5] = "double_click_500" {
            Sleep 500
            Click "Down"
            try {
                Sleep 30
            } finally {
                Click "Up"
            }
        }
        released := A_TickCount
        Sleep 160
        }
        settled := A_TickCount
        MouseGetPos &upX, &upY
        stillActive := WinActive("ahk_id " hwnd) ? 1 : 0
        status := "input_sent"
        ; Leave the tile row immediately, so the next observation has no
        ; hover-raised hand tile. This does not click the parking location.
        ; Keep the cursor out of all hand, river, meld and score regions.
        ; The former center/65% location covered the third own-river row.
        MouseMove Round(width * 0.03), Round(height * 0.94), 0
        MouseGetPos &parkX, &parkY
        detail := "requires_fresh_visual_confirmation;target=" x "," y ";down=" downX "," downY ";up=" upX "," upY ";active_after=" stillActive ";park=" parkX "," parkY ";activation_ms=" (activated-started) ";move_ms=" (moved-activated) ";pre_down_ms=" (pressed-moved) ";hold_ms=" (released-pressed) ";post_up_ms=" (settled-released) ";park_ms=" (A_TickCount-settled) ";driver_ms=" (A_TickCount-started)
        }
    } catch as err {
        detail := StrReplace(StrReplace(err.Message, "`t", " "), "`n", " ")
        if sentCount > 0 {
            status := "partial_input"
            detail := "sent=" sentCount ";" detail
        }
    }
    FileAppend id "`t" status "`t" detail "`n", queueDir "\ack.tsv", "UTF-8"
    if FileExist(processing)
        FileMove processing, queueDir "\last-request.tsv", 1
    SetTimer Dispatch, 50
}
