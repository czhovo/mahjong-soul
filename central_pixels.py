"""Exact central-table pixel signature; no semantic recognition or sampling."""
from hashlib import sha256

def central_signature(image):
    # Coordinates in the recognizer's 1368 x 800 screenshot calibration.
    # Includes the square table display, turn lights and counters.
    sx=(image.width-2)/1366
    sy=(image.height-32)/768
    box=(round(1+583*sx),round(31+213*sy),round(1+783*sx),round(31+413*sy))
    crop=image.crop(box).convert('RGB')
    return sha256(str(crop.size).encode('ascii')+crop.tobytes()).hexdigest()


def outside_central_signature(image):
    """Hash every pixel except the same central square, without resizing."""
    sx=(image.width-2)/1366;sy=(image.height-32)/768
    x0,y0,x1,y1=(round(1+583*sx),round(31+213*sy),round(1+783*sx),round(31+413*sy))
    digest=sha256(str(image.size).encode('ascii'))
    for box in ((0,0,image.width,y0),(0,y1,image.width,image.height),(0,y0,x0,y1),(x1,y0,image.width,y1)):
        digest.update(image.crop(box).convert('RGB').tobytes())
    return digest.hexdigest()


class TolerantScene:
    """Compare with last accepted scene, so gradual changes cannot disappear."""
    def __init__(self):
        from uuid import uuid4
        self.token=uuid4().hex
        self.reference=None
        self.size=None
        self.generation=0
    def signature(self,image):
        import cv2
        import numpy as np
        pixels=cv2.resize(np.asarray(image.convert('RGB')),(684,400),interpolation=cv2.INTER_AREA)
        pixels=cv2.GaussianBlur(pixels,(3,3),0)
        # In-memory side channel: recognition compares against its own accepted
        # frame, not intervening capture generations that it never consumed.
        import base64,zlib
        self.sample={'size':list(image.size),'rgb':base64.b64encode(zlib.compress(pixels.tobytes(),1)).decode('ascii')}
        changed=self.reference is None or self.size!=image.size
        if not changed:
            difference=cv2.absdiff(pixels,self.reference)
            mask=cv2.bitwise_not(cv2.inRange(difference,(0,0,0),(24,24,24)))
            mask[122:222,292:392]=0
            count,labels,stats,centers=cv2.connectedComponentsWithStats(mask,8)
            changed=bool(np.any(stats[1:,cv2.CC_STAT_AREA]>=40))
        if changed:
            self.reference=pixels;self.size=image.size;self.generation+=1
        return 'tolerant:'+self.token+':'+str(self.generation)
