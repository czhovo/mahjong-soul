"""Read switch colours at fixed points; no glyph or toolbar detection."""
import json
from pathlib import Path
import numpy as np
from native_layout import crop_native

_LAYOUT=json.loads(Path(__file__).with_name('toolbar-points.json').read_text(encoding='utf-8'))

def _denoise_mask(mask):
    if mask.shape[0]<3 or mask.shape[1]<3:return mask
    m=mask.astype(np.uint8)
    nb=(m[:-2,:-2]+m[:-2,1:-1]+m[:-2,2:]
       +m[1:-1,:-2]+m[1:-1,1:-1]+m[1:-1,2:]
       +m[2:,:-2]+m[2:,1:-1]+m[2:,2:])
    out=np.zeros_like(mask,dtype=bool)
    out[1:-1,1:-1]=mask[1:-1,1:-1]&(nb>=4)
    return out

def _state(image,key):
    x,y=_LAYOUT[key]
    crop=crop_native(image,(x-15,y-16,x+15,y+16))
    b,g,r=crop.astype(np.float32).transpose(2,0,1)
    on=_denoise_mask((g>95)&(g>1.25*r)&(g>1.15*b))
    off=_denoise_mask((b>95)&(g>75)&(r>65)&(g<1.35*b)&~((g>95)&(g>1.25*r)&(g>1.15*b)))
    green,gray=int(on.sum()),int(off.sum())
    total=green+gray
    result={'center':[x,y],'verified':False}
    if .15*on.size<=total<=.78*on.size and max(green,gray)>=.85*total:
        result.update(verified=True,enabled=green>gray,score=round(100*max(green,gray)/total))
    return result

def read_auto_win(image,sanma=False):
    return _state(image,'win3' if sanma else 'win4')

def read_auto_kita(image,sanma=False):
    return {**_state(image,'kita3'),'position':5} if sanma else {'verified':False}
