from native_layout import scale_of,crop_native,pixel_box,reference_pixels
"""Calibrated reaction buttons; absence/uncertainty yields no click target."""
from pathlib import Path
import numpy as np
import cv2
from functools import lru_cache
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from vision import load
try:
    from scipy.fft import rfft2,irfft2,next_fast_len
except ImportError:
    # Existing NumPy-only installs still work; SciPy uses single-precision FFTs.
    def rfft2(a,s=None,axes=(-2,-1),workers=1):return np.fft.rfft2(a,s=s,axes=axes)
    def irfft2(a,s=None,axes=(-2,-1),workers=1):return np.fft.irfft2(a,s=s,axes=axes)
    def next_fast_len(n):return 1<<(n-1).bit_length()

ROOT=Path(__file__).parent
BOXES={'PASS':(838,580,1005,650),'PENG':(644,580,812,650)}
ART={'CHI':'op_chi','PENG':'op_peng','GANG':'op_gang','LIZHI':'op_lizhi','RONG':'op_hu','TSUMO':'op_zimo','PASS':'op_x','KYUSHU':'op_liuju'}

@lru_cache(maxsize=32)
def artwork_templates(name,sx=1.,sy=1.):
    path=ROOT/'static-assets/extracted/controls'/(name+'.png')
    if not path.exists():return []
    raw=cv2.imdecode(np.fromfile(str(path),dtype=np.uint8),cv2.IMREAD_UNCHANGED)
    templates=[]
    for scale in (.86,.82,.90):
        resized=cv2.resize(raw,None,fx=scale*sx,fy=scale*sy,interpolation=cv2.INTER_AREA)
        templates.append((scale,resized[:,:,:3],(resized[:,:,3]>220).astype(np.uint8)*255))
    return templates

_control_pool=None
def configure_control_workers(workers=0):
    global _control_pool
    if _control_pool is not None:_control_pool.shutdown(wait=True)
    _control_pool=ThreadPoolExecutor(max_workers=workers) if workers else None

@lru_cache(maxsize=96)
def correlation_template(name,sx,sy,index):
    _,rgb,mask=artwork_templates(name,sx,sy)[index]
    weight=(mask>0).astype(np.float32)
    template=rgb.astype(np.float32)*weight[:,:,None]
    return template,weight,float(np.sum(template*template,dtype=np.float64))

@lru_cache(maxsize=192)
def correlation_spectrum(name,sx,sy,index,shape):
    template,weight,energy=correlation_template(name,sx,sy,index)
    channels=np.concatenate((np.moveaxis(template,-1,0),weight[None]),axis=0)
    return rfft2(channels,s=shape,axes=(-2,-1),workers=1).conj(),energy

def roi_spectrum(roi):
    pixels=np.moveaxis(roi.astype(np.float32),-1,0)
    channels=np.concatenate((pixels,np.sum(pixels*pixels,axis=0)[None]),axis=0)
    shape=(next_fast_len(roi.shape[0]),next_fast_len(roi.shape[1]))
    return rfft2(channels,s=shape,axes=(-2,-1),workers=1),shape

def spectral_squared_error(spectrum,shape,ref,energy,height,width):
    cross=np.sum(spectrum[:3]*ref[:3],axis=0)
    observed=spectrum[3]*ref[3]
    # Circular correlation is exact over valid placements; every sampled
    # template stays inside the original ROI. No captured pixels are resized.
    values=irfft2(np.stack((cross,observed)),s=shape,axes=(-2,-1),workers=1)[:,:height,:width]
    dot,squared=values
    numerator=np.maximum(squared+energy-2*dot,0)
    denominator=np.sqrt(np.maximum(squared*energy,0))
    return np.divide(numerator,denominator,out=np.ones_like(dot),where=denominator>0)

def _artwork_match(job):
    action,name,roi,sx,sy,px,py,spectrum,shape=job
    best=None
    for index,(scale,rgb,mask) in enumerate(artwork_templates(name,sx,sy)):
        if roi.shape[0]<rgb.shape[0] or roi.shape[1]<rgb.shape[1]:continue
        ref,energy=correlation_spectrum(name,sx,sy,index,shape)
        scores=spectral_squared_error(spectrum,shape,ref,energy,roi.shape[0]-rgb.shape[0]+1,roi.shape[1]-rgb.shape[1]+1)
        scores[~np.isfinite(scores)]=1
        error,_,xy,_=cv2.minMaxLoc(scores)
        if best is None or error<best['error']:
            h,w=rgb.shape[:2]
            best={'center':[1+(px+xy[0]+w/2-1)/sx,31+(py+xy[1]+h/2-31)/sy],'error':float(error),'scale':scale}
        if best is not None and best['error']<.06:break
    return action,best

def buttons_may_be_present(image):
    """Cheap, deliberately permissive absence test for the button band.

    Every supported button has bright neutral lettering/highlights. Ordinary
    table pixels do not. This only rejects an empty band; passing this test
    never authorizes an action or supplies a click target.
    """
    sx,sy=scale_of(image)
    # A reaction row occupies its rightmost slot first (normally PASS).
    # Do not mistake avatars in the unused left slots for action buttons.
    return any(slot_action_candidates(crop_native(image,box),sx,sy) for box in (BUTTON_SLOTS[0],UPPER_SLOTS[0]))

# Right-aligned action row: adding an option fills the next slot to its left.
# Reference pixels only; native image pixels are never resized. Extra space
# to the right accommodates the observed entrance animation.
BUTTON_SLOTS=tuple((max(3,c-112),540,min(1200,c+172),664) for c in (939,733,527,321,115))
UPPER_SLOTS=tuple((x0,425,x1,584) for x0,_,x1,_ in BUTTON_SLOTS)
BUTTON_HUES={'CHI':85,'PENG':99,'GANG':154,'LIZHI':12,'RONG':0,'TSUMO':170,'KYUSHU':124}

def slot_action_candidates(crop,sx,sy):
    bright=cv2.inRange(crop,(128,128,128),(255,255,255))
    if cv2.countNonZero(bright)<max(8,round(32*sx*sy)):return []
    hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
    hue=hsv[:,:,0].astype(np.int16)
    chromatic=(hsv[:,:,1]>80)&(hsv[:,:,2]>65)
    actions=['KITA'] if 'KITA' in ART else []
    for action,target in BUTTON_HUES.items():
        if action=='CHI' and 'KITA' in ART:continue
        distance=np.abs(hue-target);distance=np.minimum(distance,180-distance)
        if np.count_nonzero(chromatic&(distance<=6))>=max(12,round(120*sx*sy)):
            actions.append(action)
    # PASS has a neutral grey body; do not confuse mere white lettering with
    # a grey button. Color only selects templates, never authorizes a click.
    grey=(hsv[:,:,1]<55)&(hsv[:,:,2]>=45)&(hsv[:,:,2]<=180)
    if np.count_nonzero(grey)>=max(12,round(500*sx*sy)):actions.append('PASS')
    return actions

def artwork_candidates(image):
    sx,sy=scale_of(image);jobs=[]
    for box in BUTTON_SLOTS+UPPER_SLOTS:
        roi=crop_native(image,box);px,py,_,_=pixel_box(image,box)
        actions=slot_action_candidates(roi,sx,sy)
        if not actions:continue
        spectrum,shape=roi_spectrum(roi)
        for action in actions:
            jobs.append((action,ART[action],roi,sx,sy,px,py,spectrum,shape))
    candidates=_control_pool.map(_artwork_match,jobs) if _control_pool else map(_artwork_match,jobs)
    result={}
    for action,best in candidates:
        if best is not None and (action not in result or best['error']<result[action]['error']):result[action]=best
    return result

@lru_cache(maxsize=2)
def fixed_control_template(name):
    return load(str(ROOT/'templates/controls'/f'{name}.png')).astype(float)

def _recognize_controls(image):
    if not buttons_may_be_present(image):return {}
    result={}
    for name,candidate in artwork_candidates(image).items():
        if candidate['error']<.06:result[name]=candidate
    if 'RONG' in result:result['HU']=result['RONG']
    if 'TSUMO' in result:result['HU']=result['TSUMO']
    for name,(x0,y0,x1,y1) in BOXES.items():
        template=fixed_control_template(name)
        crop=crop_native(image,(x0,y0,x1,y1))
        error=float(np.mean(np.abs(crop.astype(float)-reference_pixels(template,crop.shape)))/255)
        if error<.035:
            result[name]={'center':[(x0+x1)//2,(y0+y1)//2],'error':error}
    return result


_last_controls=None

def recognize_controls(image):
    global _last_controls
    scale_of(image)
    # This union contains every pixel used by artwork and fixed templates.
    # Compare original pixels, before resizing; no approximate image reuse.
    crop=crop_native(image,(3,425,1200,664))
    if _last_controls is not None and np.array_equal(crop,_last_controls[0]):
        return deepcopy(_last_controls[1])
    result=_recognize_controls(image)
    _last_controls=(crop.copy(),deepcopy(result))
    return result
