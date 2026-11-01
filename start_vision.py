"""Visible lobby button recognition, using calibrated client coordinates."""
import json
from pathlib import Path
import cv2
from vision import load

ROOT=Path(__file__).parent/'templates/start'
REGIONS=json.loads((ROOT/'regions.json').read_text(encoding='utf-8'))
TEMPLATES={k:cv2.cvtColor(load(str(ROOT/(k+'.png'))),cv2.COLOR_BGR2GRAY) for k in REGIONS}

def recognize_start(image):
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    scores={}
    for key,region in REGIONS.items():
        x0,y0,x1,y1=region['box']
        area=gray[y0-4:y1+4,x0-4:x1+4]
        scores[key]=float(cv2.minMaxLoc(cv2.matchTemplate(area,TEMPLATES[key],cv2.TM_CCOEFF_NORMED))[1])
    controls={}
    page=None
    if scores['rank']>=.88:
        page='lobby';controls={'RANK':{'center':REGIONS['rank']['center'][:]}}
    elif scores['bronze']>=.88 and scores['silver']>=.88:
        page='rooms';controls={k.upper():{'center':REGIONS[k]['center'][:]} for k in ('bronze','silver')}
        if scores.get('gold',0)>=.88:controls['GOLD']={'center':REGIONS['gold']['center'][:]}
    elif scores['east']>=.88:
        page='modes';controls={'EAST':{'center':REGIONS['east']['center'][:]}}
    return {'page':page,'controls':controls,'scores':scores}
