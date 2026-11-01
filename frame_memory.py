"""Bounded Windows named shared memory for live RGB frames (no image files)."""
import mmap,struct,uuid
import numpy as np

class FrameMemory:
    def __init__(self,slots=8):
        self.slots=slots;self.buffers=[];self.size=0;self.sequence=0;self.token=uuid.uuid4().hex
    def publish(self,image):
        raw=image.tobytes();size=len(raw)+16
        if size!=self.size:
            self.close();self.size=size;self.token=uuid.uuid4().hex
            self.buffers=[mmap.mmap(-1,size,tagname=f'tingfeng-{self.token}-{i}') for i in range(self.slots)]
        self.sequence+=1;i=self.sequence%self.slots;buf=self.buffers[i]
        buf[:16]=struct.pack('<QQ',0,0)
        buf[16:]=raw
        buf[:16]=struct.pack('<QQ',self.sequence,len(raw))
        return {'name':f'tingfeng-{self.token}-{i}','sequence':self.sequence,'width':image.width,'height':image.height,'bytes':size}
    def close(self):
        for b in self.buffers:b.close()
        self.buffers=[]

def read_memory(frame):
    width,height=frame['width'],frame['height'];size=width*height*3
    if min(width,height)<1 or size>48000000 or frame['bytes']!=size+16:raise ValueError('Invalid memory frame dimensions')
    with mmap.mmap(-1,size+16,tagname=frame['name'],access=mmap.ACCESS_READ) as b:
        before=b[:16];raw=b[16:];after=b[:16]
    if before!=after or struct.unpack('<QQ',before)!=(frame['sequence'],size):
        raise ValueError('Memory frame expired; acquire latest frame')
    # Recognizer input is BGR, matching vision.load.
    return np.frombuffer(raw,np.uint8).reshape(height,width,3)[:,:,::-1].copy()
