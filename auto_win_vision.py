"""Recognize the visible 和 toolbar toggle, independently of reaction buttons."""
from pathlib import Path
import cv2
import numpy as np
from functools import lru_cache
@lru_cache(maxsize=1)
def template():
    return cv2.imdecode(np.fromfile(str(Path(__file__).parent/'templates/controls/auto_win_off.png'),np.uint8),cv2.IMREAD_COLOR)
def read_auto_win(image):
    crop=image[450:488,10:48]
    ref=template()
    mask=(ref[:,:,0]>95)&(ref[:,:,1]>75)&(ref[:,:,2]>65)
    b,g,r=[crop[:,:,i].astype(float) for i in range(3)]
    white=(b>95)&(g>75)&(r>65)&(g<1.35*b)
    green=(g>95)&(g>1.25*r)&(g>1.15*b)
    for enabled,ink in ((False,white),(True,green)):
        overlap=float((mask&ink).sum()/max(1,(mask|ink).sum()))
        if overlap>=.78:return {'verified':True,'enabled':enabled,'center':[29,469],'score':round(overlap*100)}
    return {'verified':False}
