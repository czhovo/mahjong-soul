"""Product screenshot input: Mahjong Soul's WGC window texture by HWND."""
import ctypes
from ctypes import wintypes as w
import json,sys,time
from pathlib import Path
from wgc_pixels import WgcPixels
from capture_storage import CaptureStorage
from central_pixels import central_signature
from frame_memory import FrameMemory
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from threading import Semaphore,Lock
from discard_motion import DiscardMotion
from time_reserve_vision import read_time_reserve
from modal_confirm_vision import read_modal_confirm
from modal_text import read_modal_text
import numpy as np
import cv2
cv2.setNumThreads(1)

u=ctypes.WinDLL('user32',use_last_error=True)
u.SetProcessDpiAwarenessContext.argtypes=[w.HANDLE]
u.SetProcessDpiAwarenessContext(w.HANDLE(-4))
u.GetForegroundWindow.restype=w.HWND
u.IsWindow.argtypes=[w.HWND];u.IsIconic.argtypes=[w.HWND]
u.GetClientRect.argtypes=[w.HWND,ctypes.POINTER(w.RECT)]
u.ClientToScreen.argtypes=[w.HWND,ctypes.POINTER(w.POINT)]
u.GetWindowTextW.argtypes=[w.HWND,w.LPWSTR,ctypes.c_int]
def geometry(hwnd):
    if not u.IsWindow(hwnd):
        raise ValueError('Bound game window no longer exists; rediscovery required')
    if u.IsIconic(hwnd):
        raise ValueError('Bound game must not be minimized')
    title=ctypes.create_unicode_buffer(512);u.GetWindowTextW(hwnd,title,len(title))
    if title.value not in ('雀魂麻將','雀魂麻将'):raise ValueError('Bound window title changed')
    rect=w.RECT()
    if not u.GetClientRect(hwnd,ctypes.byref(rect)):
        raise ctypes.WinError(ctypes.get_last_error())
    width,height=rect.right,rect.bottom
    if height<568 or abs(width/height-1366/768)>.004:raise ValueError('Uncalibrated game client geometry')
    return (width,height)
storage=CaptureStorage()
window_pixels=WgcPixels()
print(json.dumps({'type':'ready','captureBackend':'wgc'}),flush=True)
discard_motion=DiscardMotion()
frame_memory=FrameMemory()
archive_pool=ThreadPoolExecutor(max_workers=1)
archive_slots=Semaphore(4)
archive_jobs=[]
last_pixels=None
text_pool=ThreadPoolExecutor(max_workers=1)
text_job=None
output_lock=Lock()
def emit(value):
    with output_lock:print(json.dumps(value,ensure_ascii=False),flush=True)
def modal_text_job(image,dialog,identity):
    try:result=read_modal_text(image,dialog)
    except Exception as error:result={'text_error':str(error)}
    emit({'type':'modal_text','id':identity,'result':result})
for line in sys.stdin:
    request={}
    text_work=None
    try:
        request=json.loads(line);hwnd=int(request['hwnd']);started=time.perf_counter()
        size=geometry(hwnd);image=window_pixels.grab(hwnd)
        if geometry(hwnd)!=size:raise ValueError('WGC window resized; acquire latest frame')
        captured=time.time()*1000;capture_ms=(time.perf_counter()-started)*1000
        # Publish before archival compression/write. Recognition never waits
        # for the evidence file to exist. Bound the archival backlog in RAM.
        pending_jobs=[]
        for job in archive_jobs:
            if job.done():job.result()
            else:pending_jobs.append(job)
        archive_jobs=pending_jobs
        memory=frame_memory.publish(image)
        digest=sha256(image.tobytes()).digest();reused=digest==last_pixels;last_pixels=digest
        path=None
        if request.get('saveAllScreenshots',False):
            path=Path(request['path'])
            archive_slots.acquire()
            job=archive_pool.submit(storage.save,image,path,True,False)
            job.add_done_callback(lambda _:archive_slots.release());archive_jobs.append(job)
        motion_started=time.perf_counter()
        motion_error=None
        try:motion=discard_motion.update(cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR),captured)
        except Exception as error:
            motion=[];motion_error=str(error);discard_motion=DiscardMotion()
        motion_ms=(time.perf_counter()-motion_started)*1000
        bgr=cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR)
        modal_confirm=read_modal_confirm(bgr)
        timer=read_time_reserve(bgr) if request.get("readReserve") and not modal_confirm else None
        if modal_confirm:
            (x0,y0),(x1,y1)=modal_confirm['text_region']['corners']
            text_key=sha256(np.asarray(image)[max(0,y0):y1,max(0,x0):x1].tobytes()).digest()
            if text_job is None or text_job.done():
                text_identity=request['id']
                active_text_key=text_key
                text_work=(cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR),dict(modal_confirm),text_identity)
            if text_key==active_text_key:modal_confirm['modalTextId']=text_identity
        result={'id':request['id'],'path':str(path) if path else None,'width':image.width,'height':image.height,
                'capturedAt':captured,'captureMs':capture_ms,'captureBackend':'wgc','sourceTimestamp100ns':window_pixels.source_timestamp,'pixelsReused':reused,'discardMotion':motion,'discardMotionMs':motion_ms,'discardMotionError':motion_error,'frameMemory':memory,'centralPixelSignature':central_signature(image),'modalConfirm':modal_confirm,'writeMs':0,'timeReserve':timer}
    except Exception as error:result={'id':request.get('id'),'error':str(error)}
    emit(result)
    if text_work:text_job=text_pool.submit(modal_text_job,*text_work)
archive_pool.shutdown(wait=True)
text_pool.shutdown(wait=False)
for job in archive_jobs:job.result()
frame_memory.close()
window_pixels.close()
