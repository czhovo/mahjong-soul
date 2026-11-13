"""Capture visible screen pixels in a rectangle, without a full-desktop copy."""
import ctypes as c
from ctypes import wintypes as w
from PIL import Image

class Header(c.Structure):
    _fields_=[('size',w.DWORD),('width',w.LONG),('height',w.LONG),
              ('planes',w.WORD),('bits',w.WORD),('compression',w.DWORD),
              ('image_size',w.DWORD),('xppm',w.LONG),('yppm',w.LONG),
              ('colors',w.DWORD),('important',w.DWORD)]

class WindowPixels:
    def __init__(self):
        self.u=c.WinDLL('user32',use_last_error=True)
        self.g=c.WinDLL('gdi32',use_last_error=True)
        for dll,name,args,result in [
            (self.u,'GetDC',[w.HWND],w.HDC),
            (self.u,'ReleaseDC',[w.HWND,w.HDC],c.c_int),
            (self.g,'CreateCompatibleDC',[w.HDC],w.HDC),
            (self.g,'DeleteDC',[w.HDC],w.BOOL),
            (self.g,'DeleteObject',[w.HANDLE],w.BOOL),
            (self.g,'SelectObject',[w.HDC,w.HANDLE],w.HANDLE),
            (self.g,'CreateDIBSection',[w.HDC,c.POINTER(Header),w.UINT,c.POINTER(c.c_void_p),w.HANDLE,w.DWORD],w.HANDLE),
            (self.g,'BitBlt',[w.HDC,c.c_int,c.c_int,c.c_int,c.c_int,w.HDC,c.c_int,c.c_int,w.DWORD],w.BOOL),
            (self.g,'GdiFlush',[],w.BOOL)]:
            fn=getattr(dll,name);fn.argtypes=args;fn.restype=result
        self.screen=self.u.GetDC(None)
        self.dc=self.g.CreateCompatibleDC(self.screen)
        self.bitmap=None;self.original=None;self.size=None
        if not self.screen or not self.dc:
            self.close();raise c.WinError(c.get_last_error())

    def grab(self,box):
        x,y,right,bottom=map(int,box);width,height=right-x,bottom-y
        if width<=0 or height<=0:raise ValueError('Invalid capture rectangle')
        if self.size!=(width,height):
            self._release_bitmap()
            header=Header(c.sizeof(Header),width,-height,1,32,0,0,0,0,0,0)
            self.bits=c.c_void_p()
            self.bitmap=self.g.CreateDIBSection(self.screen,c.byref(header),0,c.byref(self.bits),None,0)
            if not self.bitmap:raise c.WinError(c.get_last_error())
            self.original=self.g.SelectObject(self.dc,self.bitmap)
            self.size=(width,height)
        if not self.g.BitBlt(self.dc,0,0,width,height,self.screen,x,y,0x40CC0020):
            raise c.WinError(c.get_last_error())
        self.g.GdiFlush()
        # Copy before the reusable DIB is overwritten by the next capture.
        return Image.frombytes('RGB',(width,height),c.string_at(self.bits,width*height*4),'raw','BGRX')

    def _release_bitmap(self):
        if self.bitmap:
            self.g.SelectObject(self.dc,self.original)
            self.g.DeleteObject(self.bitmap);self.bitmap=None

    def close(self):
        self._release_bitmap()
        if self.dc:self.g.DeleteDC(self.dc);self.dc=None
        if self.screen:self.u.ReleaseDC(None,self.screen);self.screen=None

    def __enter__(self):return self
    def __exit__(self,*args):self.close()
