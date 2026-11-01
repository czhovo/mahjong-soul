"""Visible white per-action and yellow reserve timer, never table-state inference."""
from pathlib import Path
from functools import lru_cache
import cv2
import numpy as np
from settlement_vision import white, normalize, templates

BOX=(1040,565,1240,657)
@lru_cache(None)
def plus_template():
 return normalize(cv2.imread(str(Path(__file__).parent/'templates/timer-plus.png'),cv2.IMREAD_GRAYSCALE))

@lru_cache(None)
def yellow_one_template():
 return normalize(cv2.imread(str(Path(__file__).parent/'templates/timer-yellow-1.png'),cv2.IMREAD_GRAYSCALE))

def read_digits(mask,minimum,allow_plus=False):
 _,_,stats,_=cv2.connectedComponentsWithStats(mask)
 boxes=sorted(tuple(map(int,s[:4])) for s in stats[1:] if s[4]>=30 and s[3]>=minimum)
 digits=[];errors=[]
 for index,(x,y,w,h) in enumerate(boxes):
  v=normalize(mask[y:y+h,x:x+w])
  if allow_plus and index==0 and float(np.mean(abs(v-plus_template())))<.12:continue
  scores=sorted((float(np.mean(abs(v-t))),n) for n,t in templates('ww').items())
  if allow_plus:
   # The timer's narrow yellow 1 is not the settlement font's 1. The old
   # stretched template confidently classified both 1 and 10 as 7 and 70.
   one_error=float(np.mean(abs(v-yellow_one_template())))
   if one_error<.14:
    scores=sorted([(e,n) for e,n in scores if n!='1']+[(one_error,'1')])
  errors.append({'error':scores[0][0],'margin':scores[1][0]-scores[0][0]})
  if scores[0][0]>=.27 or scores[1][0]-scores[0][0]<=.035:return None,False,errors
  digits.append(scores[0][1])
 if not digits:return None,not boxes,errors
 value=int(''.join(digits))
 return (value if len(digits)<=2 and value<=99 else None),False,errors

def read_time_reserve(image):
 x0,y0,x1,y1=BOX;roi=image[y0:y1,x0:x1]
 hsv=cv2.cvtColor(roi,cv2.COLOR_BGR2HSV)
 yellow=cv2.inRange(hsv,np.array([8,100,150]),np.array([40,255,255]))
 reserve,yellow_absent,yellow_scores=read_digits(yellow,18,True)
 action,white_absent,white_scores=read_digits(white(roi),30)
 # A lone yellow number is reserve; a lone white number means reserve
 # exhausted. Unreadable yellow pixels do not count as absence.
 exhausted=reserve is None and yellow_absent and action is not None
 if exhausted:reserve=0
 return {'reserve_seconds':reserve,'action_seconds':action,
         'countdown_absent':bool(yellow_absent and white_absent),
         'verified':reserve is not None,'source':'white-only' if exhausted else 'yellow' if reserve is not None else 'unreadable',
         'scores':{'reserve':yellow_scores,'action':white_scores}}
