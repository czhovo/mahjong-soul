"""Name-bound own win/result pages; no concealed information or OCR guesses."""
from pathlib import Path
from functools import lru_cache
import cv2
import numpy as np
from settlement_vision import white,normalize,templates
from phase_vision import title_similarity
from win_value_vision import read_win_values
ROOT=Path(__file__).resolve().parent
OWN_NAME='風を聴く'

@lru_cache(None)
def name_template(kind):
 im=cv2.imread(str(ROOT/'templates/result-pages'/f'own-{kind}.png'))
 return white(im)

def name_match(image,box,kind):
 x0,y0,x1,y1=box;mask=white(image[y0:y1,x0:x1]);ref=name_template(kind);best=0.
 for factor in (.85,.9,.95,1.,1.05,1.1,1.15,1.2,1.3):
  t=cv2.resize(ref,None,fx=factor,fy=factor)
  if t.shape[0]>mask.shape[0] or t.shape[1]>mask.shape[1]:continue
  best=max(best,float(cv2.minMaxLoc(cv2.matchTemplate(mask,t,cv2.TM_CCOEFF_NORMED))[1]))
 return best

@lru_cache(None)
def pt_templates():
 result={}
 for digit in range(10):
  im=cv2.imread(str(ROOT/'static-assets/extracted/settlement'/f'h_{digit}.png'),cv2.IMREAD_UNCHANGED)
  result[str(digit)]=normalize((im[:,:,3]>128).astype(np.uint8)*255)
 return result

def number_value(digits,negative=False,colored=False):
 # PT glyphs can narrowly exceed the normal error limit after scaling.
 # Accept that narrow band only when the runner-up is clearly worse.
 def accepted(d):
  return (d['error']<.27 and d['margin']>.015 or
          colored and d['error']<.28 and d['margin']>.05)
 if not digits or not all(accepted(d) for d in digits):return None
 return int(''.join(d['digit'] for d in digits))*(-1 if negative else 1)

def number(image,box,colored=False):
 x0,y0,x1,y1=box;im=image[y0:y1,x0:x1]
 if colored:
  b,g,r=[im[:,:,i].astype(float) for i in range(3)]
  binary=(((g>100)&(g>r*1.18)&(g>b*1.02))|((r>140)&(r>g*1.4)&(r>b*1.3))).astype(np.uint8)*255
 else:binary=white(im)
 _,_,stats,_=cv2.connectedComponentsWithStats(binary)
 boxes=sorted(tuple(s[:4]) for s in stats[1:] if s[4]>=8 and s[3]>=9)
 neg=bool(boxes and any(s[4]>=5 and s[3]<=6 and s[2]>=5 and s[0]+s[2]<=boxes[0][0] for s in stats[1:]))
 # Ignore the plus sign; a short isolated horizontal stroke is the minus.
 # A leading 4 also has full horizontal/vertical strokes. A negative value
 # cannot start with a plus, and a plus must cross near its centre.
 if colored and boxes and not neg:
  x,y,w,h=boxes[0];p=binary[y:y+h,x:x+w]
  rows=(p>0).mean(axis=1);columns=(p>0).mean(axis=0)
  if (.5<w/h<1.4 and rows.max()>.95 and columns.max()>.95
      and .3<=rows.argmax()/h<=.6 and .3<=columns.argmax()/w<=.7):boxes=boxes[1:]
 refs=templates('ww');digits=[]
 for x,y,w,h in boxes:
  v=normalize(binary[y:y+h,x:x+w]);scores=sorted((min(float(np.mean(abs(v-t))),float(np.mean(abs(v-pt_templates()[n])))) if colored else float(np.mean(abs(v-t))),n) for n,t in refs.items())
  digits.append({'digit':scores[0][1],'error':scores[0][0],'margin':scores[1][0]-scores[0][0]})
 return {'value':number_value(digits,neg,colored),'digits':digits}

# Coordinates normalized to the established 1368x800 window geometry.
ROWS=[((680,165,920,210),(703,211,885,275),(1077,225,1140,264)),
      ((750,323,950,365),(773,365,918,417),(1070,373,1125,409)),
      ((825,453,1030,495),(837,495,988,555),(1133,505,1194,541)),
      ((890,583,1100,628),(914,624,1040,685),(1195,633,1255,673))]

def read_result_page(image):
 if title_similarity(image)>=.85:
  names=[name_match(image,n,'rank') for n,_,_ in ROWS]
  hits=[i for i,v in enumerate(names) if v>=.75]
  if len(hits)==1:
   i=hits[0];score=number(image,ROWS[i][1]);pt=number(image,ROWS[i][2],True)
   return {'kind':'match-result','name':OWN_NAME,'nameScore':names[i],'rank':i+1,'points':score['value'],'ptChange':pt['value'],'complete':score['value'] is not None and pt['value'] is not None,'evidence':{'points':score,'pt':pt}}
 confidence=name_match(image,(65,630,250,690),'win')
 if confidence>=.8:
  return {'kind':'own-win-settlement','name':OWN_NAME,'nameScore':confidence,**read_win_values(image)}
 return None
