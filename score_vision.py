from native_layout import scale_of,crop_native,glyph_features
"""Read the four visible central scores from calibrated table regions."""
from pathlib import Path
from functools import lru_cache
import cv2
import numpy as np
from vision import load

ROOT=Path(__file__).parent
REGIONS={'self':(650,362,720,383,0),'opposite':(650,279,720,302,2),
         'left':(607,305,639,358,1),'right':(727,302,758,355,3)}

def mask(image):
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    return cv2.inRange(hsv,np.array([0,45,120]),np.array([60,255,255]))

def normalized(binary):
    points=cv2.findNonZero(binary)
    if points is None:return None
    x,y,w,h=cv2.boundingRect(points)
    return glyph_features(binary[y:y+h,x:x+w],(16,28))

@lru_cache(maxsize=1)
def score_templates():
    # The central point display uses the score atlas, not the serif standalone
    # digit textures used by other table elements.
    atlas=load(str(ROOT/'static-assets/extracted/score.png'))
    return {str(n):normalized(mask(atlas[46:69,28+14*n:42+14*n])) for n in range(10)}

def read_scores(image):
    sx,sy=scale_of(image)
    templates=score_templates()
    result={}
    for seat,(x0,y0,x1,y1,turns) in REGIONS.items():
        crop=np.rot90(crop_native(image,(x0,y0,x1,y1)),turns).copy();binary=mask(crop)
        count,labels,stats,centroids=cv2.connectedComponentsWithStats(binary)
        boxes=sorted([tuple(s[:4]) for s in stats[1:] if s[4]>=5 and s[3]>=7])
        if boxes:
            typical=float(np.median([b[2] for b in boxes]))
            split=[]
            for x,y,w,h in boxes:
                if w>1.65*typical:
                    pieces=round(w/typical)
                    for i in range(pieces):
                        left=round(i*w/pieces);right=round((i+1)*w/pieces)
                        split.append((x+left,y,right-left,h))
                else:split.append((x,y,w,h))
            boxes=split
        digits=[]
        for x,y,w,h in boxes:
            sample=normalized(binary[y:y+h,x:x+w])
            scores=sorted((float(np.mean(np.abs(sample-t))),n) for n,t in templates.items())
            digits.append({'digit':scores[0][1],'error':scores[0][0],'margin':scores[1][0]-scores[0][0]})
        signs=[s for s in stats[1:] if s[4]>=3 and s[2]>=3 and s[3]<=5]
        digit_mid=float(np.median([y+h/2 for x,y,w,h in boxes])) if boxes else 0
        negative=bool(boxes and any(s[0]+s[2]<=boxes[0][0] and abs(s[1]+s[3]/2-digit_mid)<5 for s in signs))
        accepted=1<=len(digits)<=6 and all(d['error']<.28 and d['margin']>.025 for d in digits)
        value=int(''.join(d['digit'] for d in digits))*(-1 if negative else 1) if accepted else None
        if value is not None and value%100:value=None
        result[seat]={'value':value,'digits':digits,'negative':negative}
    return result
