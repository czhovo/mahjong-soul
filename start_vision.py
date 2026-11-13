from native_layout import crop_native,reference_pixels,pixel_box,layout_points,scale_of
"""Visible lobby button recognition, using calibrated client coordinates."""
import json
from pathlib import Path
import cv2
import numpy as np
from functools import lru_cache
from vision import load

ROOT=Path(__file__).parent/'templates/start'
REGIONS=json.loads((ROOT/'regions.json').read_text(encoding='utf-8'))
TEMPLATES={k:cv2.cvtColor(load(str(ROOT/(k+'.png'))),cv2.COLOR_BGR2GRAY) for k in REGIONS}

@lru_cache(None)
def mode_label(name):
    rgba=cv2.imread(str(ROOT/(name+'.png')),cv2.IMREAD_UNCHANGED)
    white=(rgba[:,:,:3].min(axis=2)>140).astype(np.uint8)*255
    if rgba.shape[2]==4:white[rgba[:,:,3]<128]=0
    x,y,w,h=cv2.boundingRect(cv2.findNonZero(white))
    return white[y:y+h,x:x+w]

def sanma_east(image):
    # Find the actual label in the right mode panel, rather than reuse the
    # four-player button coordinate. A four-player label must not win.
    x0,y0,x1,y1=pixel_box(image,(820,200,1200,700))
    area=image[y0:y1,x0:x1]
    sx,sy=scale_of(image)
    ink=((area.min(axis=2)>140)&(np.ptp(area.astype(np.int16),axis=2)<90)).astype(np.uint8)*255
    best={};candidate_box=None
    for name in ('w_sanrendong','w_sirendong'):
        if name=='w_sirendong':
            if candidate_box is None:return None
            x,y,w,h=candidate_box
            ink=ink[max(0,y-8):y+h+8,max(0,x-8):x+w+8]
        ref=mode_label(name);best[name]=(-1,None)
        for scale in np.arange(.45,1.11,.025):
            t=cv2.resize(ref,None,fx=float(scale)*sx,fy=float(scale)*sy)
            if t.shape[0]>ink.shape[0] or t.shape[1]>ink.shape[1]:continue
            _,score,_,loc=cv2.minMaxLoc(cv2.matchTemplate(ink,t,cv2.TM_CCOEFF_NORMED))
            if score>best[name][0]:
                best[name]=(score,layout_points([[x0+loc[0]+t.shape[1]/2,y0+loc[1]+t.shape[0]/2]],image)[0].tolist())
                if name=='w_sanrendong':candidate_box=(*loc,t.shape[1],t.shape[0])
    score,center=best['w_sanrendong']
    return {'center':center,'score':score} if score>=.88 and score>best['w_sirendong'][0]+.015 else None

def recognize_start(image,sanma=False):
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    scores={}
    for key,region in REGIONS.items():
        x0,y0,x1,y1=region['box']
        area=crop_native(gray,(x0-4,y0-4,x1+4,y1+4))
        ref=reference_pixels(TEMPLATES[key],crop_native(gray,(x0,y0,x1,y1)).shape)
        scores[key]=float(cv2.minMaxLoc(cv2.matchTemplate(area,ref,cv2.TM_CCOEFF_NORMED))[1])
    controls={}
    page=None
    if scores['rank']>=.88:
        page='lobby';controls={'RANK':{'center':REGIONS['rank']['center'][:]}}
    elif scores['bronze']>=.88 and scores['silver']>=.88:
        page='rooms';controls={k.upper():{'center':REGIONS[k]['center'][:]} for k in ('bronze','silver')}
        if scores.get('gold',0)>=.88:
            controls['GOLD']={'center':REGIONS['gold']['center'][:]}
            # The fourth room is partly clipped by the list viewport. Its
            # visible upper section is clickable at the next fixed row.
            step=REGIONS['silver']['center'][1]-REGIONS['bronze']['center'][1]
            controls['JADE']={'center':[REGIONS['gold']['center'][0],REGIONS['gold']['center'][1]+step]}
    elif sanma:
        target=sanma_east(image)
        if target:page='modes';controls={'EAST':target}
    elif scores['east']>=.88:
        page='modes';controls={'EAST':{'center':REGIONS['east']['center'][:]}}
    return {'page':page,'controls':controls,'scores':scores}
