from native_layout import scale_of,crop_native
"""Name-bound own win/result pages; no concealed information or OCR guesses."""
from pathlib import Path
from functools import lru_cache
import cv2
import numpy as np
from settlement_vision import white,normalize,templates
from phase_vision import confirm_error,BUTTON_ERROR
from win_value_vision import read_win_values
from win_yaku import read_yaku
from player_nickname import WIN
ROOT=Path(__file__).resolve().parent

def name_match(image,box,kind,nickname):
 if nickname is None:return 0.
 return nickname.score(image,box,kind)

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
 x0,y0,x1,y1=box;im=crop_native(image,(x0,y0,x1,y1))
 if colored:
  b,g,r=[im[:,:,i].astype(float) for i in range(3)]
  binary=(((g>100)&(g>r*1.18)&(g>b*1.02))|((r>140)&(r>g*1.4)&(r>b*1.3))).astype(np.uint8)*255
 else:binary=white(im)
 _,_,stats,_=cv2.connectedComponentsWithStats(binary)
 boxes=sorted(tuple(s[:4]) for s in stats[1:] if s[4]>=8 and s[3]>=9)
 neg=bool(boxes and any(s[4]>=5 and s[3]<=6 and s[2]>=5 and s[0]+s[2]<=boxes[0][0] for s in stats[1:]))
 if not colored:
  # A leading minus scales with the score digits; at 1080p it can
  # exceed the old six-pixel limit and enter the digit candidates.
  components=sorted(tuple(s[:4]) for s in stats[1:] if s[4]>=5)
  neg=False
  if len(components)>=2:
   x,y,w,h=components[0]
   if boxes and boxes[0]==(x,y,w,h) and w>=2*h:boxes=boxes[1:]
   if boxes:
    dx,dy,dw,dh=boxes[0]
    neg=w>=2*h and h<=dh*.35 and 0<=dx-x-w<=dh*.65 and dy+.2*dh<=y+h/2<=dy+.8*dh
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
def pt_box(left,top,right,bottom):
 # Keep the final digit of a signed three-digit PT value inside every row.
 return left,top,right+8,bottom

ROWS=[((680,165,920,210),(703,211,885,275),pt_box(1077,225,1140,264)),
      ((750,323,950,365),(773,365,918,417),pt_box(1070,373,1125,409)),
      ((825,453,1030,495),(837,495,988,555),pt_box(1133,505,1194,541)),
      ((890,583,1100,628),(889,624,1060,685),pt_box(1195,633,1255,673))]

def read_rank_result(image,players,nickname=None):
 rows=ROWS[:players]
 names=[name_match(image,n,'rank',nickname) for n,_,_ in rows]
 hits=[i for i,v in enumerate(names) if v>=.75]
 if len(hits)!=1 or (nickname is not None and names[hits[0]]-max((v for j,v in enumerate(names) if j!=hits[0]),default=0)<.08):return None
 i=hits[0];score=number(image,rows[i][1]);pt=number(image,rows[i][2],True)
 return {'kind':'match-result','nameScore':names[i],'rank':i+1,'points':score['value'],'ptChange':pt['value'],'complete':score['value'] is not None and pt['value'] is not None,'evidence':{'points':score,'pt':pt}}

def ranking_scores_visible(image,players):
 # Multiple independent score rows identify the page, never the user's rank.
 hits=0
 for _,box,_ in ROWS[:players]:
  value=number(image,box)['value']
  if value is not None and value%100==0:
   hits+=1
   if hits==2:return True
 return False

def read_result_page(image,players=4,*,confirm=None,nickname=None,include_yaku=True):
 if (confirm_error(image) if confirm is None else confirm)<BUTTON_ERROR:
  page=read_rank_result(image,players,nickname)
  if page:return page
 confidence=name_match(image,WIN,'win',nickname)
 if confidence>=.8:
  totals=read_win_values(image,players=players)
  # The score appears after the han/fu badge. Leave the worker free to
  # capture that later frame before paying the cost of yaku OCR.
  suffix=read_yaku(image,totals) if include_yaku and totals['complete'] else ''
  return {'kind':'own-win-settlement','nameScore':confidence,**totals,'yakuSuffix':suffix}
 return None
