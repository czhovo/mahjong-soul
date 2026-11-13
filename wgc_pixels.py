"""Capture a window's own WGC texture by HWND, then retain v7 pixel coordinates."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path
from PIL import Image


def calibrated_window(image, client):
    x,y,width,height=client
    if min(width,height)<=0 or x<0 or y<0 or x+width>image.width or y+height>image.height:
        raise ValueError('WGC client geometry changed; acquire latest frame')
    # Preserve the established one-pixel border and 31-pixel title offset.
    # Crop/padding only: never rescale observed pixels.
    return image.crop((x-1,y-31,x+width+1,y+height+1))


class WgcPixels:
    def __init__(self, library=None):
        path=Path(library) if library else Path(__file__).parent/'runtime/wgc/wgc-capture.dll'
        if not path.is_file():
            raise RuntimeError('WGC backend missing; run build-wgc.ps1: '+str(path))
        self.lib=c.CDLL(str(path))
        self.lib.wgc_open.argtypes=[w.HWND];self.lib.wgc_open.restype=c.c_void_p
        self.lib.wgc_close.argtypes=[c.c_void_p];self.lib.wgc_close.restype=None
        self.lib.wgc_error.argtypes=[];self.lib.wgc_error.restype=c.c_char_p
        self.lib.wgc_grab.argtypes=[c.c_void_p,c.c_void_p,c.c_int]+[c.POINTER(c.c_int)]*6+[c.POINTER(c.c_longlong),c.c_int]
        self.lib.wgc_grab.restype=c.c_int
        self.user=c.WinDLL('user32',use_last_error=True)
        self.user.GetClientRect.argtypes=[w.HWND,c.POINTER(w.RECT)]
        self.handle=None;self.hwnd=None;self.buffer=None;self.capacity=0
        self.source_timestamp=None

    def error(self):
        return RuntimeError((self.lib.wgc_error() or b'WGC capture failed').decode('utf-8',errors='replace'))

    def grab(self, hwnd):
        if self.hwnd!=hwnd:
            self.close()
            self.handle=self.lib.wgc_open(hwnd)
            if not self.handle:raise self.error()
            self.hwnd=hwnd
        rect=w.RECT()
        if not self.user.GetClientRect(hwnd,c.byref(rect)):raise c.WinError(c.get_last_error())
        capacity=(rect.right+128)*(rect.bottom+256)*4
        if capacity<=0 or capacity>192000000:raise ValueError('Unsupported WGC frame size')
        if self.capacity<capacity:
            self.buffer=c.create_string_buffer(capacity);self.capacity=capacity
        fields=[c.c_int() for _ in range(6)];stamp=c.c_longlong()
        if not self.lib.wgc_grab(self.handle,self.buffer,self.capacity,*[c.byref(v) for v in fields],c.byref(stamp),2500):raise self.error()
        width,height,x,y,cw,ch=[v.value for v in fields]
        image=Image.frombytes('RGB',(width,height),c.string_at(self.buffer,width*height*4),'raw','BGRX')
        self.source_timestamp=stamp.value
        return calibrated_window(image,(x,y,cw,ch))

    def close(self):
        if self.handle:self.lib.wgc_close(self.handle)
        self.handle=None;self.hwnd=None
        self.buffer=None;self.capacity=0

    def __enter__(self):return self
    def __exit__(self,*args):self.close()
