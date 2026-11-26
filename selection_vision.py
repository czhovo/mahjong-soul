from native_layout import scale_of,crop_native
"""Visible enabled/disabled hand faces during an explicit riichi selection."""
import cv2
import numpy as np

def discard_choices(image,hand,require_disabled=True):
    result={'verified':False,'legalDiscards':[],'tiles':[]}
    if not hand.get('complete'):return result
    for tile in hand['tiles']:
        x,y=map(round,tile['center'])
        crop=crop_native(image,(x-22,y+28,x+22,y+37))
        if not crop.size:return result
        hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
        neutral=hsv[:,:,2][hsv[:,:,1]<35]
        if len(neutral)<150*np.prod(scale_of(image)):return result
        value=float(np.median(neutral))
        enabled=True if value>=225 else False if 130<=value<=175 else None
        result['tiles'].append({'tile':tile['tile'],'value':value,'enabled':enabled})
    flags=[t['enabled'] for t in result['tiles']]
    # The unselected normal hand is also bright: it is not a selection page.
    if None in flags or True not in flags or (require_disabled and False not in flags):return result
    result.update(verified=True,legalDiscards=list(dict.fromkeys(t['tile'] for t in result['tiles'] if t['enabled'])))
    return result

def riichi_choices(image,hand):
    return discard_choices(image,hand,require_disabled=True)

def post_call_choices(image,hand,melds):
    # Only the pending call transaction may request this mode. Unlike riichi,
    # a pung can leave every remaining tile enabled.
    if not melds.get('complete') or not melds.get('groups'):
        return {'verified':False,'legalDiscards':[],'tiles':[]}
    if len(hand.get('tiles',[]))!=14-3*len(melds['groups']):
        return {'verified':False,'legalDiscards':[],'tiles':[]}
    return discard_choices(image,hand,require_disabled=False)
