from native_layout import crop_native,reference_pixels
"""Recognize calibrated terminal overlay before interpreting table regions."""
from pathlib import Path
from functools import lru_cache
import numpy as np
from vision import load

ROOT=Path(__file__).parent

@lru_cache(None)
def _title_masks():
    refs=[]
    for name in ('match-end-title','match-end-title-hd'):
        tile=load(str(ROOT/'templates/phase'/f'{name}.png'))
        refs.append((tile.min(axis=2)>200)&(np.ptp(tile.astype(np.int16),axis=2)<50))
    return refs

def title_similarity(image):
    # Only compare the white glyphs; the transparent title's table background
    # varies with every game's discards, melds and player artwork.
    crop=crop_native(image,(625,76,713,113))
    brightness=crop.min(axis=2)
    neutral=np.ptp(crop.astype(np.int16),axis=2)<50
    best=0.0
    # Light artwork behind the title can exceed 200 too. Try brighter cuts
    # against the same reference strokes, still penalizing missing AND extra ink.
    for cutoff in (200,212,220,226,230):
        observed=(brightness>cutoff)&neutral
        for raw in _title_masks():
            expected=reference_pixels(raw.astype(np.uint8)*255,crop.shape)>128
            union=np.count_nonzero(expected|observed)
            best=max(best,float(np.count_nonzero(expected&observed)/union) if union else 0.0)
    return best
def confirm_error(image):
    roi=crop_native(image,(1151,707,1331,762))
    template=reference_pixels(load(str(ROOT/'templates/phase/match-end-confirm.png')),roi.shape)
    return float(np.mean(np.abs(roi.astype(float)-template.astype(float)))/255)

def results_title(image,similarity,button_error=None):
    # A nearly matching title needs independent evidence at the final-page
    # confirm position. A yellow button alone never identifies a result page.
    return similarity>=.85 or (similarity>=.78 and
        (confirm_error(image) if button_error is None else button_error)<.045)

def recognize_phase(image):
    errors={}
    for name,(x0,y0,x1,y1) in {'match-end-title':(625,76,713,113),'match-end-title-hd':(625,76,713,113),'match-end-confirm':(1151,707,1331,762),
        'rematch-button':(950,707,1129,762),'rematch-dialog-title':(617,190,752,226),
        'rematch-dialog-confirm':(449,568,664,620),'rematch-dialog-cancel':(701,568,916,620)}.items():
        template=reference_pixels(load(str(ROOT/'templates/phase'/f'{name}.png')),crop_native(image,(x0,y0,x1,y1)).shape)
        errors[name]=float(np.mean(abs(crop_native(image,(x0,y0,x1,y1)).astype(float)-template.astype(float)))/255)
    if all(errors[k]<.045 for k in ('rematch-dialog-title','rematch-dialog-confirm','rematch-dialog-cancel')):
        return {'name':'match_end','page':'rematch_dialog','controls':{'REMATCH_CONFIRM':{'center':[556,594]}},'errors':errors}
    errors['title_glyph_similarity']=title_similarity(image)
    if errors['match-end-confirm']<.045 and results_title(image,errors['title_glyph_similarity'],errors['match-end-confirm']):
        if errors['rematch-button']<.045:
            return {'name':'match_end','page':'rewards','controls':{'REMATCH':{'center':[1039,734]},'EXIT':{'center':[1241,734]}},'errors':errors}
        return {'name':'match_end','page':'results','controls':{'CONFIRM':{'center':[1241,734]}},'errors':errors}
    return {'name':'unknown','controls':{},'errors':errors}
