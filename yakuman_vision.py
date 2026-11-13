from functools import lru_cache
from pathlib import Path
import cv2
import numpy as np
from native_layout import crop_native

def ink(bgr):
 h,s,v=cv2.split(cv2.cvtColor(bgr,cv2.COLOR_BGR2HSV))
 return (((h<40)|(h>170))&(s>110)&(v>85)).astype(np.uint8)*255

@lru_cache(None)
def glyph(name,scale):
 p=Path(__file__).parent/'templates/yakuman'/('word_'+name+'.png')
 a=cv2.imdecode(np.fromfile(str(p),np.uint8),cv2.IMREAD_UNCHANGED)
 t=ink(a[:,:,:3]);t[a[:,:,3]<128]=0
 return cv2.resize(t,None,fx=scale,fy=scale)

def read_yakuman(image):
 # Reference-space coordinates on the lower central title only.
 mask=ink(cv2.resize(crop_native(image,(175,607,1165,790)),(990,183)))
 if cv2.countNonZero(mask)<2000:return None
 def match(name,scale,x0=0,x1=990,y0=0,y1=183):
  t=glyph(name,scale);x0=max(0,x0);y0=max(0,y0)
  a=mask[y0:y1,x0:x1]
  if min(a.shape[0]-t.shape[0],a.shape[1]-t.shape[1])<0:return 0,0,0
  _,v,_,(x,y)=cv2.minMaxLoc(cv2.matchTemplate(a,t,cv2.TM_CCORR_NORMED))
  return v,x+x0,y+y0
 for scale in (1.15,1.10,1.0,.90,.80,.70):
  v,x,y=match('yi',scale)
  if v<.85:continue
  pitch=round(118*scale)
  def adjacent(name,offset):
   xx=x+offset*pitch;t=glyph(name,scale)
   return match(name,scale,xx-24,xx+t.shape[1]+24,y-18,y+t.shape[0]+18)[0]
  if adjacent('man',1)<.85:continue
  if adjacent('bei',-1)>=.82:
   scores=sorted(((adjacent(n,-2),i) for i,n in enumerate(('liang','san','si','wu','liu'),2)),reverse=True)
   if scores[0][0]>=.83 and scores[0][0]-scores[1][0]>.04:return scores[0][1]
  elif abs(175+x+pitch-683)<45:return 1
 return None
