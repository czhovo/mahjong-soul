from native_layout import crop_native,scale_of,pixel_box
"""Three-seat geometry hooks for the shared recognition worker.

Unknown extraction regions remain unknown; they are never reported as zero.
"""
import json
from pathlib import Path
import cv2
import numpy as np

POSITIONS = ('self', 'right', 'left')
PROFILE_PATH = Path(__file__).parent / 'sanma' / 'layout.json'

def profile():
    return json.loads(PROFILE_PATH.read_text(encoding='utf-8'))

def read_physical_seats(image):
    # Unlike yonma, a missing player's compass slot is blank. Identify the
    # occupied slots first, then count East/South/West around those slots.
    boxes={'self':(570,380,615,421),'right':(750,380,795,421),
           'opposite':(750,253,795,287),'left':(570,253,615,287)}
    red={};glyph={}
    for p,(x0,y0,x1,y1) in boxes.items():
        hsv=cv2.cvtColor(crop_native(image,(x0,y0,x1,y1)),cv2.COLOR_BGR2HSV)
        red[p]=int(np.count_nonzero(((hsv[:,:,0]<10)|(hsv[:,:,0]>170))&(hsv[:,:,1]>140)&(hsv[:,:,2]>110)))
        glyph[p]=int(np.count_nonzero((hsv[:,:,1]<90)&(hsv[:,:,2]>145)))
    active=[p for p in boxes if red[p]>100*np.prod(scale_of(image)) or glyph[p]>35*np.prod(scale_of(image))]
    dealer=[p for p in active if red[p]>100*np.prod(scale_of(image))]
    result={'verified':False,'counts':red,'glyph_counts':glyph}
    if len(active)!=3 or len(dealer)!=1 or 'self' not in active:return result
    start=active.index(dealer[0])
    result.update(verified=True,dealer=dealer[0],seats={p:(active.index(p)-start)%3 if p in active else 3 for p in boxes})
    return result

def adapt_round(image, state):
    # The four compass slots remain on the table; the North slot is empty.
    # Canonical right/left mean next/previous active player, not screen sides.
    physical=('self','right','opposite','left')
    identity=read_physical_seats(image) if image is not None else state.get('seat_identity',{})
    seats=identity.get('seats',{})
    if not identity.get('verified') or set(seats)!=set(physical) or set(seats.values())!={0,1,2,3} or seats.get('self')==3:
        state['seat_identity']={'verified':False,'counts':identity.get('counts',{})}
        state['physical_positions']={}
        state.pop('physical_seats',None)
        state.pop('empty_position',None)
        if 'turn' in state:state['turn']['position']=None
        return state
    own=seats['self']
    mapping={POSITIONS[(seat-own)%3]:p for p,seat in seats.items() if seat!=3}
    reverse={p:c for c,p in mapping.items()}
    state['physical_positions']=mapping
    state['physical_seats']=dict(seats)
    state['empty_position']=next(p for p,seat in seats.items() if seat==3)
    state['seat_identity']={'verified':True,'seats':{c:seats[p] for c,p in mapping.items()},
        'dealer':reverse[next(p for p,seat in seats.items() if seat==0)],'counts':identity.get('counts',{})}
    turn=state.get('turn',{})
    turn['physical_position']=turn.get('position')
    turn['position']=reverse.get(turn.get('position'))
    turn['counts']={c:turn.get('counts',{}).get(p,0) for c,p in mapping.items()}
    return state

def adapt_result(image, result, round_state=None, native_image=None, scale=(1,1)):
    from recognize_coded_frame import region
    state=result.get('round') or round_state or {}
    # Score overlays cover compass glyphs. Map their physical score boxes
    # with the last verified seat identity, never with an empty current map.
    if not state.get('physical_positions') and 'settlement' in result and round_state:
        state=round_state
    mapping=state.get('physical_positions',{})
    for key in ('rivers', 'opponent_meld_faces', 'opponent_melds'):
        if key in result:
            result[key] = {c:result[key][p] for c,p in mapping.items() if p in result[key]}
    if 'controls' in result:
        result['controls'].pop('CHI', None)
    for key in ('table_scores', 'settlement'):
        if key not in result:
            continue
        scores = result[key]['scores']
        scores = {c:scores[p] for c,p in mapping.items() if p in scores}
        result[key].update(scores=scores, complete=len(scores) == 3 and all(s['value'] is not None for s in scores.values()))
    if 'hand' in result:
        result['kita'] = {}
        for p in POSITIONS:
            box = profile().get('kita_boxes', {}).get(mapping.get(p))
            if not box:
                result['kita'][p] = {'count': None, 'reason': '拔北区域尚未标定'}
                continue
            result['kita'][p] = read_kita_region(image,box,native_image,scale)
        if any(t['tile'].startswith('W') and t['tile'] not in ('W1', 'W9') for t in result['hand']['tiles']):
            result['hand']['complete'] = False
    # Convert physical called-tile direction to the engine's three-seat id.
    physical=('self','right','opposite','left')
    for owner,observation in [('self',result.get('own_melds')),*result.get('opponent_melds',{}).items()]:
        if not observation or owner not in mapping:
            continue
        groups=observation.get('groups',[])
        if any(g['kind']=='CHI' for g in groups):
            observation.update(complete=False,reason='illegal_sanma_chi',groups=[g for g in groups if g['kind']!='CHI'])
        for group in observation.get('groups',[]):
            if group['kind']=='ANGANG':
                group['fromSeat']=None
                continue
            offset={'right':1,'opposite':2,'left':3}.get(group.get('fromRelative'))
            group['fromRelative']=None
            group['fromSeat']=None
            if offset is None:
                observation['complete']=False
                continue
            source=physical[(physical.index(mapping[owner])+offset)%4]
            seat=state.get('physical_seats',{}).get(source)
            if seat not in (0,1,2):
                observation['complete']=False
            else:
                group['fromSeat']=seat
                group['fromRelative']=POSITIONS[(seat-state['seat_identity']['seats'][owner])%3]
    if 'hand' in result and not mapping:
        result['hand']['complete']=False
    result['player_count'] = 3
    return result

def exclude_kita(image, round_state, scale=(1,1)):
    """Extracted north is not a river tile or a meld. Mask only its own ROI."""
    masked=image.copy()
    boxes=profile().get('kita_boxes',{})
    for physical in round_state.get('physical_positions',{}).values():
        box=boxes.get(physical)
        if not box:continue
        x0,y0,x1,y1=pixel_box(image,box)
        masked[y0:y1,x0:x1]=0
    return masked


def read_kita_region(image, box, native_image=None, scale=(1,1)):
    """Read original pixels directly; keep unreadable north unknown."""
    from recognize_coded_frame import region
    def read(pixels, bounds):
        found=region(pixels,bounds,check_faces=True)
        tiles=found['tiles']
        good=found['complete'] and not found.get('rejected') and len(tiles)<=4 and all(t['tile']=='Z4' for t in tiles)
        x0,y0,x1,y1=bounds
        hsv=cv2.cvtColor(crop_native(pixels,(x0,y0,x1,y1)),cv2.COLOR_BGR2HSV)
        base=((hsv[:,:,0]>=12)&(hsv[:,:,0]<=35)&(hsv[:,:,1]>140)&(hsv[:,:,2]>120)).astype(np.uint8)
        _,_,stats,_=cv2.connectedComponentsWithStats(base)
        sx,sy=scale_of(pixels)
        bases=[s for s in stats[1:] if s[4]>=20*sx*sy and s[2]>=10*sx]
        # A decoded/rejected face is never evidence of an empty extraction area.
        if not tiles:
            good=not bases and not found.get('rejected') and not found.get('face_count',0)
        return {'count':len(tiles) if good else None,'tiles':tiles,
                'face_count':found.get('face_count'), 'rejected':found.get('rejected',[])}
    result=read(image,box)
    result['recognition_source']='native_resolution'
    return result
