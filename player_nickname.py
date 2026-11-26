"""Read the local player's nameplate and compare whole labels in memory."""
import base64
import cv2
import numpy as np
from native_layout import crop_native,scale_of
from settlement_vision import white

SOURCE={'table':(265,622,380,641),'lobby':(189,107,298,131)}
WIN=(12,627,238,689)

def ink(image,box,kind):
    mask=white(crop_native(image,box))
    sx,sy=scale_of(image)
    if kind=='rank':
        # The third and fourth name regions can include the left stroke of
        # the score-change badge at the far right. It is clipped by the ROI.
        _,labels,stats,_=cv2.connectedComponentsWithStats(mask)
        for i,(x,y,w,h,area) in enumerate(stats[1:],1):
            if x+w==mask.shape[1] and x>mask.shape[1]-9*sx:mask[labels==i]=0
    if kind=='win':
        # The result ribbon rises towards the right. Straighten it before
        # measuring the entire name; ignore the character artwork outside it.
        h,w=mask.shape
        yy,xx=np.ogrid[:h,:w]
        mid=(659-box[1])*sy-(xx-(122-box[0])*sx)*.087
        mask[np.abs(yy-mid)>14*sy]=0
        rotation=cv2.getRotationMatrix2D((w/2,h/2),-5,1)
        mask=(cv2.warpAffine(mask,rotation,(w,h))>=110).astype(np.uint8)*255
    x,y,w,h=cv2.boundingRect(mask)
    if not w or h<3*sy or w<2*sx:return None
    if kind in SOURCE and (x==0 or x+w>=mask.shape[1] or y==0 or y+h>=mask.shape[0]):return None
    return mask[y:y+h,x:x+w].copy()

def similarity(a,b):
    if a is None or b is None:return 0.
    ah,aw=a.shape;bh,bw=b.shape
    if not .80<aw*bh/(bw*ah)<1.25:return 0.
    size=(max(4,min(640,round(32*aw/ah))),32)
    def std(m):
        v=cv2.resize(m,size,interpolation=cv2.INTER_LINEAR)
        return cv2.GaussianBlur(v,(5,5),1.2).astype(np.float32)
    x,y=std(a),std(b)
    # Include the blank border for very short names (e.g. one letter).
    x,y=(cv2.copyMakeBorder(v,3,3,3,3,cv2.BORDER_CONSTANT,value=0) for v in (x,y))
    def corr(l,r):return float(cv2.matchTemplate(l,r,cv2.TM_CCOEFF_NORMED)[0,0])
    score=corr(x,y)
    if score>=.75 and size[0]>=64:
        # A long shared prefix must not hide a different last character.
        for col in np.linspace(0,x.shape[1]-32,max(2,(size[0]+15)//24),dtype=int):
            if corr(x[:,col:col+32],y[:,col:col+32])<.58:return 0.
        # Same rendering and identical prefix, but a distinct end glyph:
        # a high whole-line score alone can mistake "Kite" for "Kita".
        v=[corr(x[3:-3,col:col+16],y[3:-3,col:col+16]) for col in
           np.linspace(3,x.shape[1]-19,max(3,size[0]//7),dtype=int)]
        if max(v)>.985 and min(v)<.70:return 0.
    return score

class Nickname:
    def __init__(self):
        self.refs={};self.candidates={};self.table_checked=False
    def observe(self,image,source,frame_id):
        if source=='table' and self.table_checked:return False
        m=ink(image,SOURCE[source],source)
        previous=self.candidates.get(source)
        if m is None:
            self.candidates.pop(source,None);return False
        self.candidates[source]=(frame_id,m)
        if previous is None or previous[0]==frame_id or similarity(previous[1],m)<.93:return False
        if source=='table':self.table_checked=True
        if similarity(self.refs.get(source),m)>.94:return False
        # A new lobby account supersedes the previous table identity.
        if source=='lobby':
            self.table_checked=False;self.refs.pop('table',None);self.candidates.pop('table',None)
        elif 'lobby' in self.refs and similarity(self.refs['lobby'],m)<.75:
            self.refs.pop('lobby')
        self.refs[source]=m
        return True
    def score(self,image,box,kind):
        if not self.refs:return 0.
        m=ink(image,box,kind)
        return max(similarity(ref,m) for ref in self.refs.values())
    def pack(self):
        return {k:base64.b64encode(cv2.imencode('.png',v)[1]).decode('ascii') for k,v in self.refs.items()}
    def restore(self,payload):
        self.refs={k:cv2.imdecode(np.frombuffer(base64.b64decode(v),np.uint8),cv2.IMREAD_GRAYSCALE) for k,v in payload.items() if k in SOURCE}
