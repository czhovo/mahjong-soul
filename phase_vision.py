"""Classify terminal pages using their controls and the ranking rows."""
from functools import lru_cache
from pathlib import Path
import numpy as np
import cv2
from native_layout import crop_native,reference_pixels,pixel_box,layout_points
from vision import load

ROOT=Path(__file__).parent
BOXES={'match-end-confirm':(1151,707,1331,762),'rematch-button':(950,707,1129,762),
       'rematch-dialog-title':(617,190,752,226),'rematch-dialog-confirm':(449,568,664,620),
       'rematch-dialog-cancel':(701,568,916,620)}
BUTTON_ERROR=.045
_UNREAD=object()

@lru_cache(None)
def _art(name):
    return load(str(ROOT/'templates/phase'/f'{name}.png'))

def button_error(image,name):
    roi=crop_native(image,BOXES[name])
    ref=reference_pixels(_art(name),roi.shape)
    return float(np.mean(np.abs(roi.astype(np.int16)-ref))/255)

def confirm_error(image):
    return button_error(image,'match-end-confirm')

def dialog_confirm_face(image):
    # Only used after clicking REMATCH. The yellow face survives a hover or
    # fade that can invalidate whole-template matching; often the rewards
    # buttons are still visible underneath the modal.
    face=crop_native(image,(461,578,652,611)).astype(np.int16)
    b,g,r=cv2.split(face)
    return np.mean((r>120)&(g>b+28)&(r>b+50)&(r>=g-8))>.65

def rematch_frame_visible(image):
    # Both decorated ends of the fixed blue button survive before its gold
    # label is fully drawn. Compare each separately; a blue backdrop or a
    # single blue patch is not a second button.
    roi=crop_native(image,BOXES['rematch-button'])
    ref=reference_pixels(_art('rematch-button'),roi.shape)
    w=max(1,round(roi.shape[1]*25/179))
    for sl in (slice(0,w),slice(-w,None)):
        def chroma(img):
            part=img[:,sl].astype(np.float32)
            return part[:,:,0]-part[:,:,2]
        a,b=chroma(roi),chroma(ref)
        if np.mean(a)<8 or np.std(a)<2 or cv2.matchTemplate(a,b,cv2.TM_CCOEFF_NORMED).item()<.84:
            return False
    return True

def rematch_center(image):
    # The blue face can brighten and slide during the page transition. Match
    # the four characters, locally, independently of the yellow exit button.
    ref=_art('rematch-button')[9:46,31:148]
    box=(981,716,1098,753)
    area=(935,681,1144,790)
    x,y,r,b=pixel_box(image,area)
    glyph=reference_pixels(ref,crop_native(image,box).shape)
    roi=image[y:b,x:r]
    # Gold lettering on blue: the R-B signal keeps the glyph contrast even
    # when the entire button is shaded, and rejects white text on grey.
    def contrast(a):return a[:,:,2].astype(np.float32)-a[:,:,0]
    observed=contrast(roi);template=contrast(glyph)
    _,score,_,(dx,dy)=cv2.minMaxLoc(cv2.matchTemplate(observed,template,cv2.TM_CCOEFF_NORMED))
    if score<.72:return None
    h,w=template.shape
    patch=roi[dy:dy+h,dx:dx+w]
    signal=contrast(patch)
    if np.mean(signal<-18)<.30 and not (score>=.90 and np.std(signal)>=3 and np.mean(signal)<0):return None
    return np.rint(layout_points([[x+dx+w/2,y+dy+h/2]],image)[0]).astype(int).tolist()

def recognize_phase(image,result_page=_UNREAD,*,players=4,confirm=None,post_match=False,after_rematch=False):
    errors={'match-end-confirm':confirm_error(image) if confirm is None else confirm}
    def visible(name):
        errors[name]=button_error(image,name)
        return errors[name]<BUTTON_ERROR
    def end(page,**controls):
        return {'name':'match_end','page':page,'controls':{k:{'center':v} for k,v in controls.items()},'errors':errors}
    dialog=visible('rematch-dialog-confirm')
    if ((post_match and after_rematch and (dialog or (dialog_confirm_face(image) and visible('rematch-dialog-cancel')))) or
        (dialog and visible('rematch-dialog-cancel') and visible('rematch-dialog-title'))):
        return end('rematch_dialog',REMATCH_CONFIRM=[556,594])
    if post_match or errors['match-end-confirm']<BUTTON_ERROR:
        exact=visible('rematch-button')
        center=[1039,734] if exact else rematch_center(image)
        source='button' if exact else 'label'
        if center is None and post_match and rematch_frame_visible(image):
            center=[1039,734];source='button-edges'
        if center is not None:
            controls={'REMATCH':center}
            if errors['match-end-confirm']<BUTTON_ERROR:controls['EXIT']=[1241,734]
            return {**end('rewards',**controls),'rematchSource':source}
    if post_match and after_rematch:
        # A disappearing button does not prove that the dialog opened.
        return {'name':'unknown','controls':{},'errors':errors}
    if errors['match-end-confirm']<BUTTON_ERROR:
        if (isinstance(result_page,dict) and result_page.get('kind')=='match-result') or ranking_scores_visible(image,players):
            return end('results',CONFIRM=[1241,734])
        if post_match:return end('confirm',CONFIRM=[1241,734])
    return {'name':'unknown','controls':{},'errors':errors}


def ranking_scores_visible(image,players):
    # Two independent numeric rows confirm the page. Ignore the sign: only
    # the presence of a score is used; no name, rank or PT is returned.
    from settlement_vision import white,normalize,templates
    boxes=[(703,211,885,275),(773,365,918,417),(837,495,988,555),(889,624,1060,685)]
    refs=templates('ww')
    hits=0
    for box in boxes[:players]:
        mask=white(crop_native(image,box))
        _,_,stats,_=cv2.connectedComponentsWithStats(mask)
        parts=sorted(tuple(v[:4]) for v in stats[1:] if v[4]>=8 and v[3]>=9)
        if parts and parts[0][2]>=2*parts[0][3]:parts.pop(0)
        digits=[]
        for x,y,w,h in parts:
            sample=normalize(mask[y:y+h,x:x+w])
            if sample is None:break
            scores=sorted((float(np.mean(abs(sample-ref))),n) for n,ref in refs.items())
            if scores[0][0]>=.27 or scores[1][0]-scores[0][0]<=.015:break
            digits.append(scores[0][1])
        else:
            if digits and int(''.join(digits))%100==0:
                hits+=1
                if hits==2:return True
    return False
