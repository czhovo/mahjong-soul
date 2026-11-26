"""Bounded Windows named shared memory for live RGB frames (no image files)."""
import mmap,struct,uuid
import cv2
import numpy as np

class FrameMemory:
    def __init__(self,slots=8):
        self.slots=slots;self.buffers=[];self.size=0;self.sequence=0;self.token=uuid.uuid4().hex
    def publish(self,image,raw=None):
        if raw is None:
            raw=image.tobytes()
        raw_bytes=memoryview(raw).cast('B')
        size=len(raw_bytes)+16
        if size!=self.size:
            self.close();self.size=size;self.token=uuid.uuid4().hex
            self.buffers=[mmap.mmap(-1,size,tagname=f'tingfeng-{self.token}-{i}') for i in range(self.slots)]
        self.sequence+=1;i=self.sequence%self.slots;buf=self.buffers[i]
        buf[:16]=struct.pack('<QQ',0,0)
        buf[16:]=raw_bytes
        buf[:16]=struct.pack('<QQ',self.sequence,len(raw_bytes))
        return {'name':f'tingfeng-{self.token}-{i}','sequence':self.sequence,'width':image.width,'height':image.height,'bytes':size}
    def close(self):
        for b in self.buffers:b.close()
        self.buffers=[]

def read_memory(frame):
    width,height=frame['width'],frame['height'];size=width*height*3
    if min(width,height)<1 or size>48000000 or frame['bytes']!=size+16:raise ValueError('Invalid memory frame dimensions')
    with mmap.mmap(-1,size+16,tagname=frame['name'],access=mmap.ACCESS_READ) as b:
        before=b[:16]
        if struct.unpack('<QQ',before)!=(frame['sequence'],size):
            raise ValueError('Memory frame expired; acquire latest frame')
        # Zero-copy view into shared memory + SIMD RGB->BGR conversion (~6ms vs ~30-120ms strided numpy copy).
        rgb=np.frombuffer(b,dtype=np.uint8,count=size,offset=16).reshape(height,width,3)
        bgr=cv2.cvtColor(rgb,cv2.COLOR_RGB2BGR)
        del rgb
        after=b[:16]
    if before!=after:
        raise ValueError('Memory frame expired; acquire latest frame')
    return bgr
