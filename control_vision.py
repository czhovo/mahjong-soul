"""Calibrated reaction buttons; absence/uncertainty yields no click target."""
from pathlib import Path
import numpy as np
import cv2
from functools import lru_cache
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from vision import load

ROOT=Path(__file__).parent
BOXES={'PASS':(838,580,1005,650),'PENG':(644,580,812,650)}
ART={'CHI':'op_chi','PENG':'op_peng','GANG':'op_gang','LIZHI':'op_lizhi','RONG':'op_hu','TSUMO':'op_zimo','PASS':'op_x','KYUSHU':'op_liuju'}

@lru_cache(maxsize=8)
def artwork_templates(name):
    path=ROOT/'static-assets/extracted/controls'/(name+'.png')
    if not path.exists():return []
    raw=cv2.imdecode(np.fromfile(str(path),dtype=np.uint8),cv2.IMREAD_UNCHANGED)
    templates=[]
    for scale in (.82,.86,.90):
        resized=cv2.resize(raw,None,fx=scale*.5,fy=scale*.5,interpolation=cv2.INTER_AREA)
        templates.append((scale,resized[:,:,:3],(resized[:,:,3]>220).astype(np.uint8)*255))
    return templates

_control_pool=None
def configure_control_workers(workers=0):
    global _control_pool
    if _control_pool is not None:_control_pool.shutdown(wait=True)
    _control_pool=ThreadPoolExecutor(max_workers=workers) if workers else None

def _artwork_match(job):
    action,name,roi=job
    best=None
    for scale,rgb,mask in artwork_templates(name):
        scores=cv2.matchTemplate(roi,rgb,cv2.TM_SQDIFF_NORMED,mask=mask)
        scores[~np.isfinite(scores)]=1
        error,_,xy,_=cv2.minMaxLoc(scores)
        if best is None or error<best['error']:
            h,w=rgb.shape[:2]
            best={'center':[300+2*xy[0]+w,540+2*xy[1]+h],'error':float(error),'scale':scale}
    return action,best

def artwork_candidates(image):
    roi=cv2.resize(image[540:664,300:1200],None,fx=.5,fy=.5,interpolation=cv2.INTER_AREA)
    jobs=[(action,name,roi) for action,name in ART.items()]
    candidates=_control_pool.map(_artwork_match,jobs) if _control_pool else map(_artwork_match,jobs)
    return {action:best for action,best in candidates if best is not None}

@lru_cache(maxsize=2)
def fixed_control_template(name):
    return load(str(ROOT/'templates/controls'/f'{name}.png')).astype(float)

def _recognize_controls(image):
    result={}
    for name,candidate in artwork_candidates(image).items():
        if candidate['error']<.06:result[name]=candidate
    if 'RONG' in result:result['HU']=result['RONG']
    if 'TSUMO' in result:result['HU']=result['TSUMO']
    for name,(x0,y0,x1,y1) in BOXES.items():
        template=fixed_control_template(name)
        crop=image[y0:y1,x0:x1]
        error=float(np.mean(np.abs(crop.astype(float)-template))/255)
        if error<.035:
            result[name]={'center':[(x0+x1)//2,(y0+y1)//2],'error':error}
    return result


_last_controls=None

def recognize_controls(image):
    global _last_controls
    if image.shape[:2]!=(800,1368):raise ValueError('Uncalibrated control layout')
    # This union contains every pixel used by artwork and fixed templates.
    # Compare original pixels, before resizing; no approximate image reuse.
    crop=image[540:664,300:1200]
    if _last_controls is not None and np.array_equal(crop,_last_controls[0]):
        return deepcopy(_last_controls[1])
    result=_recognize_controls(image)
    _last_controls=(crop.copy(),deepcopy(result))
    return result
