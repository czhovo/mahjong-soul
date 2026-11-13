from native_layout import scale_of,crop_native,reference_pixels
"""Recognize the visible 和 toolbar toggle, independently of reaction buttons."""
from pathlib import Path
import cv2
import numpy as np
from functools import lru_cache
@lru_cache(maxsize=1)
def template():
    return cv2.imdecode(np.fromfile(str(Path(__file__).parent/'templates/controls/auto_win_off.png'),np.uint8),cv2.IMREAD_COLOR)
def read_auto_win(image, sanma=False):
    if sanma:
        ref=reference_pixels(template(),crop_native(image,(10,450,48,488)).shape)
        expected=((ref[:,:,0]>95)&(ref[:,:,1]>75)&(ref[:,:,2]>65)).astype(np.float32)
        crop=crop_native(image,(10,340,48,650))
        b,g,r=[crop[:,:,i].astype(float) for i in range(3)]
        candidates=[]
        for enabled,ink in ((False,(b>95)&(g>75)&(r>65)&(g<1.35*b)),
                            (True,(g>95)&(g>1.25*r)&(g>1.15*b))):
            ink=ink.astype(np.float32)
            intersection=cv2.matchTemplate(ink,expected,cv2.TM_CCORR)
            observed=cv2.matchTemplate(ink,np.ones_like(expected),cv2.TM_CCORR)
            overlap=intersection/np.maximum(1,observed+expected.sum()-intersection)
            _,score,_,location=cv2.minMaxLoc(overlap)
            if score>=.78:candidates.append((score,enabled,location[1]))
        if not candidates:return {'verified':False}
        score,enabled,y=max(candidates)
        return {'verified':True,'enabled':enabled,'center':[29,340+(y+expected.shape[0]/2)/scale_of(image)[1]],'score':round(score*100)}
    crop=crop_native(image,(10,450,48,488))
    ref=reference_pixels(template(),crop.shape)
    mask=(ref[:,:,0]>95)&(ref[:,:,1]>75)&(ref[:,:,2]>65)
    b,g,r=[crop[:,:,i].astype(float) for i in range(3)]
    white=(b>95)&(g>75)&(r>65)&(g<1.35*b)
    green=(g>95)&(g>1.25*r)&(g>1.15*b)
    for enabled,ink in ((False,white),(True,green)):
        overlap=float((mask&ink).sum()/max(1,(mask|ink).sum()))
        if overlap>=.78:return {'verified':True,'enabled':enabled,'center':[29,469],'score':round(overlap*100)}
    return {'verified':False}
