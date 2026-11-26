"""Discover visible Mahjong Soul windows using OS window metadata only."""
import ctypes,json,os,sys
from ctypes import wintypes as w

u=ctypes.WinDLL('user32',use_last_error=True)
k=ctypes.WinDLL('kernel32',use_last_error=True)
u.SetProcessDpiAwarenessContext.argtypes=[w.HANDLE]
u.SetProcessDpiAwarenessContext(w.HANDLE(-4))
u.GetForegroundWindow.restype=w.HWND
u.GetWindowTextW.argtypes=[w.HWND,w.LPWSTR,ctypes.c_int]
u.IsWindowVisible.argtypes=[w.HWND]
u.IsIconic.argtypes=[w.HWND]
u.GetClientRect.argtypes=[w.HWND,ctypes.POINTER(w.RECT)]
u.GetWindowThreadProcessId.argtypes=[w.HWND,ctypes.POINTER(w.DWORD)]
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)]
k.CloseHandle.argtypes=[w.HANDLE]
windows=[]
@ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
def visit(hwnd,_):
    if not u.IsWindowVisible(hwnd):return True
    title=ctypes.create_unicode_buffer(512);u.GetWindowTextW(hwnd,title,len(title))
    if title.value not in ('雀魂麻將','雀魂麻将'):return True
    pid=w.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(pid));handle=k.OpenProcess(0x1000,False,pid.value)
    if not handle:return True
    try:
        path=ctypes.create_unicode_buffer(32768);length=w.DWORD(len(path))
        if not k.QueryFullProcessImageNameW(handle,0,path,ctypes.byref(length)):return True
        if os.path.basename(path.value).lower()!='jantama_mahjongsoul.exe':return True
        minimized=bool(u.IsIconic(hwnd))
        # Minimized windows may report a 0x0 client. Keep the verified game
        # handle discoverable so the resident can restore it before sizing.
        if not minimized:
            rect=w.RECT()
            if not u.GetClientRect(hwnd,ctypes.byref(rect)):return True
            width,height=rect.right,rect.bottom
            if height<568 or abs(width/height-1366/768)>.004:return True
        windows.append({'id':int(hwnd),'app':'process:'+path.value,'title':title.value,
                        'foreground':u.GetForegroundWindow()==hwnd,'minimized':minimized})
    finally:k.CloseHandle(handle)
    return True
u.EnumWindows.argtypes=[type(visit),w.LPARAM]
def discover():
    windows.clear()
    u.EnumWindows(visit,0)
    print(json.dumps(windows,ensure_ascii=False),flush=True)

if '--serve' in sys.argv:
    for line in sys.stdin:
        discover()
else:
    discover()
