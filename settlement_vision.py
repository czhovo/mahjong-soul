from native_layout import scale_of,crop_native,glyph_features
"""Read only the four fixed settlement score regions; no table-center OCR."""
from pathlib import Path
from functools import lru_cache
import cv2
import numpy as np

ROOT = Path(__file__).parent
REGIONS = {'opposite': (683,267,863,313), 'left': (355,443,541,492),
           'right': (1002,443,1186,494), 'self': (680,648,863,696)}

def white(image):
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    return cv2.inRange(hsv, np.array([0,0,170]), np.array([179,65,255]))

def normalize(mask):
    points = cv2.findNonZero(mask)
    if points is None: return None
    x,y,w,h = cv2.boundingRect(points)
    return glyph_features(mask[y:y+h,x:x+w],(24,40))

@lru_cache(maxsize=2)
def templates(prefix='ww'):
    result = {}
    for digit in range(10):
        path = ROOT/'static-assets/extracted/settlement'/f'{prefix}_{digit}.png'
        img = cv2.imdecode(np.fromfile(path,dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        binary = white(img[:,:,:3])
        if img.shape[2] == 4: binary[img[:,:,3]<128] = 0
        result[str(digit)] = normalize(binary)
    return result

def read_settlement(image):
    sx,sy=scale_of(image)
    refs = templates(); result = {}
    for position,(x0,y0,x1,y1) in REGIONS.items():
        binary = white(crop_native(image,(x0,y0,x1,y1)))
        _,_,stats,_ = cv2.connectedComponentsWithStats(binary)
        boxes = sorted(tuple(s[:4]) for s in stats[1:] if s[4]>=30*sx*sy and s[3]>=19*sy)
        # A leading minus is short and wide; do not silently turn debt positive.
        signs=[tuple(s[:4]) for s in stats[1:] if s[4]>=12*sx*sy and 8*sx<=s[2]<=30*sx and 2*sy<=s[3]<=12*sy]
        negative=bool(boxes and any(x+w<=boxes[0][0] and abs((y+h/2)-binary.shape[0]/2)<10*sy for x,y,w,h in signs))
        digits=[]
        for x,y,w,h in boxes:
            sample=normalize(binary[y:y+h,x:x+w])
            errors=sorted((float(np.mean(np.abs(sample-ref))),digit) for digit,ref in refs.items())
            digits.append({'digit':errors[0][1], 'error':errors[0][0], 'margin':errors[1][0]-errors[0][0]})
        accepted=1<=len(digits)<=6 and all(d['error']<.22 and d['margin']>.025 for d in digits)
        value=int(''.join(d['digit'] for d in digits))*(-1 if negative else 1) if accepted else None
        if value is not None and value%100: value=None
        result[position]={'value':value,'digits':digits,'negative':negative}
    return {'scores':result,'complete':all(s['value'] is not None for s in result.values()),'source':'settlement-fixed-regions'}
