"""Extract labeled static glyphs; no live game state or mouse input."""
import json
from pathlib import Path
import cv2
import numpy as np
from vision import load

ROOT=Path(__file__).parent
ROWS=[['W0','W1','W2','W3','W4','W5','W6'],
      ['W7','W8','W9','B0','B1','B2','B3'],
      ['B4','B5','B6','B7','B8','B9','T0'],
      ['T1','T2','T3','T4','T5','T6','T7'],
      ['T8','T9','Z1','Z2','Z3','Z4','Z5'],
      ['Z6','Z7']]

def glyph(image,preserve_aspect=True):
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    mask=((hsv[:,:,2]<150)|((hsv[:,:,1]>80)&(hsv[:,:,2]<240))).astype(np.uint8)
    ys,xs=np.where(mask)
    if len(xs)<5:return np.full((64,40,3),255,np.uint8)
    crop=image[ys.min():ys.max()+1,xs.min():xs.max()+1].copy()
    m=mask[ys.min():ys.max()+1,xs.min():xs.max()+1]
    crop[m==0]=255
    if not preserve_aspect:return cv2.resize(crop,(40,64),interpolation=cv2.INTER_AREA)
    # Preserve the glyph's proportions: stretching a narrow two-bamboo glyph
    # to the width of eight bamboo destroys a decisive identifying feature.
    scale=min(36/crop.shape[1],60/crop.shape[0])
    width=max(1,round(crop.shape[1]*scale));height=max(1,round(crop.shape[0]*scale))
    resized=cv2.resize(crop,(width,height),interpolation=cv2.INTER_AREA)
    canvas=np.full((64,40,3),255,np.uint8)
    x=(40-width)//2;y=(64-height)//2
    canvas[y:y+height,x:x+width]=resized
    return canvas

def color_fraction(image):
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    h,s=hsv[:,:,0],hsv[:,:,1]
    return np.array([np.mean((s>90)&((h<12)|(h>170))),
                     np.mean((s>90)&(h>25)&(h<100))])

def rank(image,templates,preserve_aspect=True):
    sample=glyph(image,preserve_aspect)
    colors=color_fraction(sample)
    scores=[]
    for tile,template in templates.items():
        error=float(np.mean(np.abs(sample.astype(float)-template.astype(float)))/255)
        error+=float(2*np.sum(np.abs(colors-color_fraction(template))))
        scores.append((error,tile))
    return sorted(scores)

def load_templates(preserve_aspect=True):
    atlas=load(str(ROOT/'static-assets/extracted/mjp.png'))
    return {tile:glyph(atlas[row*73:(row+1)*73,col*52:(col+1)*52],preserve_aspect)
            for row,tiles in enumerate(ROWS) for col,tile in enumerate(tiles)}

if __name__=='__main__':
    source=ROOT/'static-assets/extracted/mjp.png'
    atlas=load(str(source));out=ROOT/'templates/atlas';out.mkdir(exist_ok=True)
    records=[]
    for row,tiles in enumerate(ROWS):
        for col,tile in enumerate(tiles):
            box=[col*52,row*73,52,73]
            crop=atlas[row*73:(row+1)*73,col*52:(col+1)*52]
            cv2.imencode('.png',glyph(crop))[1].tofile(str(out/(tile+'.png')))
            records.append({'tile':tile,'box':box})
    (out/'manifest.json').write_text(json.dumps({'source':str(source),'tiles':records,'status':'static glyphs; live recognition validation required'},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'templates':len(records),'directory':str(out)}))
