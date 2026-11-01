"""Recognize calibrated terminal overlay before interpreting table regions."""
from pathlib import Path
import numpy as np
from vision import load

ROOT=Path(__file__).parent

def title_similarity(image):
    # Only compare the white glyphs; the transparent title's table background
    # varies with every game's discards, melds and player artwork.
    crop=image[76:113,625:713]
    def ink(a):return (a.min(axis=2)>200)&(np.ptp(a.astype(np.int16),axis=2)<50)
    observed=ink(crop)
    best=0.0
    for name in ('match-end-title','match-end-title-hd'):
        expected=ink(load(str(ROOT/'templates/phase'/f'{name}.png')))
        union=np.count_nonzero(expected|observed)
        best=max(best,float(np.count_nonzero(expected&observed)/union) if union else 0.0)
    return best
def recognize_phase(image):
    errors={}
    for name,(x0,y0,x1,y1) in {'match-end-title':(625,76,713,113),'match-end-title-hd':(625,76,713,113),'match-end-confirm':(1151,707,1331,762),
        'rematch-button':(950,707,1129,762),'rematch-dialog-title':(617,190,752,226),
        'rematch-dialog-confirm':(449,568,664,620),'rematch-dialog-cancel':(701,568,916,620)}.items():
        template=load(str(ROOT/'templates/phase'/f'{name}.png'))
        errors[name]=float(np.mean(abs(image[y0:y1,x0:x1].astype(float)-template.astype(float)))/255)
    if all(errors[k]<.045 for k in ('rematch-dialog-title','rematch-dialog-confirm','rematch-dialog-cancel')):
        return {'name':'match_end','page':'rematch_dialog','controls':{'REMATCH_CONFIRM':{'center':[556,594]}},'errors':errors}
    errors['title_glyph_similarity']=title_similarity(image)
    if errors['title_glyph_similarity']>=.85 and errors['match-end-confirm']<.045:
        if errors['rematch-button']<.045:
            return {'name':'match_end','page':'rewards','controls':{'REMATCH':{'center':[1039,734]},'EXIT':{'center':[1241,734]}},'errors':errors}
        return {'name':'match_end','page':'results','controls':{'CONFIRM':{'center':[1241,734]}},'errors':errors}
    return {'name':'unknown','controls':{},'errors':errors}
