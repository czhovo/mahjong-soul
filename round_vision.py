from native_layout import scale_of,crop_native
"""Visible round and wall counter OCR; null means unrecognized."""
from pathlib import Path
from functools import lru_cache
import cv2
import numpy as np
from vision import load
from score_vision import normalized,mask as gold
from settlement_vision import templates as white_templates,white,normalize

ROOT=Path(__file__).parent

def public_counters(image):
    refs=white_templates('w');values={}
    for name,(x0,y0,x1,y1) in {'riichi_sticks':(79,124,117,158),'honba':(179,124,217,158)}.items():
        binary=white(crop_native(image,(x0,y0,x1,y1)));_,_,stats,_=cv2.connectedComponentsWithStats(binary)
        boxes=sorted(tuple(s[:4]) for s in stats[1:] if s[4]>8 and s[3]>=10)
        digits=[]
        for x,y,w,h in boxes:
            sample=normalize(binary[y:y+h,x:x+w]);ranked=sorted((float(np.mean(abs(sample-ref))),digit) for digit,ref in refs.items())
            if ranked[0][0]>.22 or ranked[1][0]-ranked[0][0]<.03:break
            digits.append(ranked[0][1])
        values[name]=int(''.join(digits)) if len(digits)==len(boxes) and 1<=len(digits)<=2 else None
    return values

def read_seats(image):
    boxes={'self':(570,380,615,421),'right':(750,380,795,421),
           'opposite':(750,253,795,287),'left':(570,253,615,287)}
    counts={}
    for position,(x0,y0,x1,y1) in boxes.items():
        hsv=cv2.cvtColor(crop_native(image,(x0,y0,x1,y1)),cv2.COLOR_BGR2HSV)
        counts[position]=int(np.count_nonzero(((hsv[:,:,0]<10)|(hsv[:,:,0]>170))&(hsv[:,:,1]>140)&(hsv[:,:,2]>110)))
    candidates=[p for p,n in counts.items() if n>100*np.prod(scale_of(image))]
    if len(candidates)!=1:return {'verified':False,'counts':counts}
    order=['self','right','opposite','left'];dealer=order.index(candidates[0])
    return {'verified':True,'seats':{p:(i-dealer)%4 for i,p in enumerate(order)},'dealer':candidates[0]}

def read_turn(image):
    boxes={'self':(648,386,718,405),'opposite':(648,265,718,285),
           'left':(587,303,609,364),'right':(761,303,784,364)}
    counts={}
    for p,(x0,y0,x1,y1) in boxes.items():
        hsv=cv2.cvtColor(crop_native(image,(x0,y0,x1,y1)),cv2.COLOR_BGR2HSV)
        counts[p]=int(np.count_nonzero((hsv[:,:,0]>=18)&(hsv[:,:,0]<=42)&(hsv[:,:,1]>100)&(hsv[:,:,2]>180)))
    active=[p for p,n in counts.items() if n>70*np.prod(scale_of(image))]
    return {'position':active[0] if len(active)==1 else None,'counts':counts}

def cyan(image):
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    return cv2.inRange(hsv,np.array([65,35,100]),np.array([110,255,255]))

def read_number(crop,templates,min_margin=.015,variants=None,*,max_error=.34):
    binary=cyan(crop)
    count,labels,stats,centroids=cv2.connectedComponentsWithStats(binary)
    boxes=sorted([tuple(s[:4]) for s in stats[1:] if s[4]>=5 and s[3]>=6])
    digits=[]
    for x,y,w,h in boxes:
        sample=normalized(binary[y:y+h,x:x+w])
        ranking=sorted((min(float(np.mean(abs(sample-t))),
                           *(float(np.mean(abs(sample-v))) for v in (variants or {}).get(n,[]))),n)
                       if (variants or {}).get(n) else (float(np.mean(abs(sample-t))),n)
                       for n,t in templates.items())
        digits.append({'digit':ranking[0][1],'error':ranking[0][0],'margin':ranking[1][0]-ranking[0][0]})
    accepted=1<=len(digits)<=2 and all(d['error']<max_error and d['margin']>min_margin for d in digits)
    return {'value':int(''.join(d['digit'] for d in digits)) if accepted else None,'digits':digits}

@lru_cache(maxsize=1)
def round_templates():
    atlas=load(str(ROOT/'static-assets/extracted/num_left.png'))
    templates={str(n):normalized(cyan(atlas[:,20*n:20*(n+1)])) for n in range(10)}
    # Actual rendered counter glyph, recorded from a visually verified 55.
    # Tested independently against the earlier 59 frame; never infer a value
    # from expected game progression when its pixels are ambiguous.
    fives=[cv2.imread(str(ROOT/'test-evidence'/name),cv2.IMREAD_GRAYSCALE) for name in ['visible-wall-digit-5.png','visible-wall-digit-5b.png']]
    variants={'5':[normalized(five) for five in fives if five is not None]}
    six=cv2.imread(str(ROOT/'test-evidence/visible-wall-digit-6.png'),cv2.IMREAD_GRAYSCALE)
    if six is not None:variants['6']=[normalized(six)]
    for name in ('visible-wall-digit-6-0.png','visible-wall-digit-6-1.png'):
        sample=cv2.imread(str(ROOT/'test-evidence'/name),cv2.IMREAD_GRAYSCALE)
        if sample is not None:variants.setdefault('6',[]).append(normalized(sample))
    eight=cv2.imread(str(ROOT/'test-evidence/visible-wall-digit-8.png'),cv2.IMREAD_GRAYSCALE)
    if eight is not None:variants['8']=[normalized(eight)]
    three=cv2.imread(str(ROOT/'test-evidence/visible-wall-digit-3.png'),cv2.IMREAD_GRAYSCALE)
    if three is not None:variants['3']=[normalized(three)]
    hand_templates={str(n):normalized(gold(load(str(ROOT/'static-assets/extracted'/f'{n}.png')))) for n in range(1,5)}
    wind_atlas=load(str(ROOT/'static-assets/extracted/chang.png'))
    winds=[normalized(cyan(wind_atlas[:,29*(n+1):29*(n+2)])) for n in range(4)]
    hand_variants={}
    four=cv2.imread(str(ROOT/'test-evidence/visible-hand-digit-4.png'),cv2.IMREAD_GRAYSCALE)
    if four is not None:hand_variants['4']=[normalized(four)]
    return templates,variants,hand_templates,winds,hand_variants

def read_round(image,*,include_seats=True):
    templates,variants,hand_templates,winds,hand_variants=round_templates()
    wind_sample=normalized(cyan(crop_native(image,(653,308,677,331))))
    wind_scores=[]
    if wind_sample is not None:
        for n in range(4):
            template=winds[n]
            wind_scores.append((float(np.mean(abs(wind_sample-template))),n))
    wind_scores.sort()
    wind=wind_scores[0][1] if wind_scores and wind_scores[0][0]<.34 and wind_scores[1][0]-wind_scores[0][0]>.015 else None
    return {'remaining':read_number(crop_native(image,(677,335,711,355)),templates,min_margin=.04,variants=variants),
            'hand_number':read_number(crop_native(image,(678,309,693,329)),hand_templates,variants=hand_variants,max_error=.4),
            'wind':wind,'wind_candidates':wind_scores,'counters':public_counters(image),'seat_identity':read_seats(image) if include_seats else {},'turn':read_turn(image),'verified':False}
