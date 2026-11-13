from native_layout import crop_native
"""Read the total han/fu badge and lower-right win points, on calibrated frames."""
import cv2
import numpy as np
from settlement_vision import white,normalize,templates
from win_value_validation import validate_win_values
from yakuman_vision import read_yakuman

def glyph(mask):
 v=normalize(mask)
 if v is None:return None
 scores=sorted((float(np.mean(abs(v-t))),n) for n,t in templates('ww').items())
 return {'digit':scores[0][1],'error':scores[0][0],'margin':scores[1][0]-scores[0][0]}

def digits(mask,min_height=10):
 _,_,stats,_=cv2.connectedComponentsWithStats(mask)
 boxes=sorted(tuple(map(int,s[:4])) for s in stats[1:] if s[4]>=10 and s[3]>=min_height)
 out=[]
 for x,y,w,h in boxes:
  sample=mask[y:y+h,x:x+w]
  # Small adjacent fu digits can share antialiased pixels. Compare both
  # segmentation hypotheses, penalizing an unnecessary split.
  single=glyph(sample);choices=[]
  if single:choices.append((single['error'],[single]))
  if w/h>.85:
   for cut in range(max(2,int(w*.3)),min(w-2,int(w*.7)+1)):
    a,b=glyph(sample[:,:cut]),glyph(sample[:,cut:])
    if a and b:choices.append(((a['error']+b['error'])/2+.035,[a,b]))
  if choices:out.extend(min(choices,key=lambda c:c[0])[1])
 ok=bool(out) and all(d['error']<.22 and d['margin']>.025 for d in out)
 return {'value':int(''.join(d['digit'] for d in out)) if ok else None,'digits':out}

def read_win_values(image,players=4):
 # Total badge only: individual yaku rows are deliberately excluded.
 badge=crop_native(image,(920,345,1002,420))
 hsv=cv2.cvtColor(badge,cv2.COLOR_BGR2HSV)
 han=digits(cv2.inRange(hsv,np.array([10,120,160]),np.array([40,255,255])),20)
 fu=digits(white(crop_native(image,(920,425,960,453))))
 points=digits(white(crop_native(image,(850,565,1210,710))),35)
 if points['value'] is None or points['value']>=24000 or han['value'] is None:
  multiple=read_yakuman(image)
  if multiple:
   total=points['value']
   return {'han':None,'fu':None,'yakuman':multiple,'points':total,'complete':total is not None,
           'evidence':{'yakuman':multiple,'points':points}}
 return {**validate_win_values(han['value'],fu['value'],points['value'],players),
         'evidence':{'han':han,'fu':fu,'points':points}}
