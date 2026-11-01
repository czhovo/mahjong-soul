"""Generate deterministic machine-readable tile textures and decode them.

Does not write to the game installation. Unknown/ambiguous frames yield no tile.
"""
from pathlib import Path
import json
import os
import cv2
import numpy as np
from concurrent.futures import ThreadPoolExecutor
from threading import local
from PIL import Image,ImageDraw,ImageFont
from atlas_templates import ROWS

ROOT=Path(__file__).parent
OUT=ROOT/'static-assets/coded'
TILES=[t for row in ROWS for t in row]
DICTIONARY=cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
PARAMS=cv2.aruco.DetectorParameters()
PARAMS.errorCorrectionRate=0.0
PARAMS.minMarkerPerimeterRate=.02
DETECTOR=cv2.aruco.ArucoDetector(DICTIONARY,PARAMS)
_decode_threads=local()
_decode_pool=None

def configure_decoder_workers(workers=0):
    global _decode_pool
    if _decode_pool is not None:_decode_pool.shutdown(wait=True)
    _decode_pool=ThreadPoolExecutor(max_workers=workers) if workers else None

def _parallel_decode(image):
    if not hasattr(_decode_threads,'detector'):
        _decode_threads.detector=cv2.aruco.ArucoDetector(DICTIONARY,PARAMS)
    return decode(image,_decode_threads.detector)

def tile_label(tile):
    if tile[0]=='Z':return ['东','南','西','北','白','发','中'][int(tile[1])-1]
    suit={'W':'万','B':'筒','T':'条'}[tile[0]]
    return ('赤五' if tile[1]=='0' else '一二三四五六七八九'[int(tile[1])-1])+suit

# Bright suit stripe is separate from the pure black/white marker and label.
CODE_COLORS={'W':(240,0,0),'B':(120,0,240),'T':(120,240,0),'Z':(0,240,240)}

def marker_image(index,size):
    marker=cv2.aruco.generateImageMarker(DICTIONARY,index,size)
    rgb=np.repeat(marker[:,:,None],3,axis=2)
    return Image.fromarray(rgb)

def draw_suit_stripe(atlas,tile,x,y,size):
    ImageDraw.Draw(atlas).rectangle((x,y-round(size*.20),x+size-1,y-round(size*.07)),fill=CODE_COLORS[tile[0]])

def draw_label(atlas,tile,box,size):
    draw=ImageDraw.Draw(atlas);font=ImageFont.truetype(str(Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts/msyh.ttc'),size)
    text=tile_label(tile);left,top,right,bottom=box
    draw.text(((left+right)/2,(top+bottom)/2),text,font=font,fill="black",anchor='mm')

def tile_image(index):
    face=Image.new('RGB',(52,73),'white')
    face.paste(marker_image(index,42),(5,10))
    draw_suit_stripe(face,TILES[index],5,10,42)
    draw_label(face,TILES[index],(2,54,50,72),11)
    return face

def decode(image,detector=None):
    corners,ids,rejected=(DETECTOR if detector is None else detector).detectMarkers(image)
    if ids is None:return []
    return [{'tile':TILES[int(i)],'id':int(i),'corners':c[0].tolist()}
            for i,c in zip(ids.flatten(),corners)
            if 0<=int(i)<len(TILES)
            and min(np.linalg.norm(c[0]-np.roll(c[0],1,axis=0),axis=1))>=12]

def decode_consensus(image):
    """Exact codes across thresholds; reject conflicting IDs at one position."""
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY) if image.ndim==3 else image
    variants=[image]+[cv2.threshold(gray,t,255,cv2.THRESH_BINARY)[1] for t in (140,180,210,230)]
    groups=[]
    results=_decode_pool.map(_parallel_decode,variants) if _decode_pool else map(_parallel_decode,variants)
    for hits in results:
        for tile in hits:
            center=np.mean(tile['corners'],axis=0)
            # Scalar squared distances avoid one NumPy allocation/norm per
            # existing face for every threshold hit. Same six-pixel boundary.
            cx,cy=map(float,center)
            group=next((g for g in groups if
                (float(g['center'][0])-cx)**2+(float(g['center'][1])-cy)**2<36),None)
            if group is None:
                group={'center':center,'hits':[]};groups.append(group)
            group['hits'].append(tile)
    return [{**g['hits'][0], 'recognition':marker_quality(gray,g['hits'][0])}
            for g in groups if len({t['id'] for t in g['hits']})==1]

def marker_quality(image,hit):
    """Image quality score, not a calibrated probability of correctness.

    Sample the central half of all 36 cells (including the black border).
    Compare normalized cell intensities with the exact decoded marker.
    """
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY) if image.ndim==3 else image
    transform=cv2.getPerspectiveTransform(np.float32(hit['corners']),
        np.float32([[0,0],[119,0],[119,119],[0,119]]))
    patch=cv2.warpPerspective(gray,transform,(120,120)).astype(float)
    cells=np.median(patch.reshape(6,20,6,20)[:,5:15,:,5:15],axis=(1,3)).reshape(-1)
    expected=cv2.aruco.generateImageMarker(DICTIONARY,hit['id'],6).reshape(-1)>0
    black=float(np.median(cells[~expected]));white=float(np.median(cells[expected]))
    contrast=max(0.,white-black)/255.
    normalized=np.clip((cells-black)/max(white-black,1.),0,1)
    match=float(1-np.mean(np.abs(normalized-expected.astype(float))))
    return {'score':round(100*(.8*match+.2*contrast),2),
            'cell_match':round(100*match,2),'contrast':round(100*contrast,2),
            'kind':'image_quality_not_probability'}

def color_check(image,corners,expected_tile):
    """Check the independent stripe above the marker in marker-local coordinates.

    White highlights and black labels have no useful chroma; exclude them.
    Color alone never identifies a tile or repairs an unreadable marker.
    """
    if image.ndim!=3:return {'verified':False,'reason':'color_image_required'}
    unit=np.float32([[0,0],[1,0],[1,1],[0,1]])
    transform=cv2.getPerspectiveTransform(unit,np.float32(corners))
    band=cv2.perspectiveTransform(np.float32([[[.08,-.17],[.92,-.17],[.92,-.09],[.08,-.09]]]),transform)[0]
    if np.any(band[:,0]<0) or np.any(band[:,1]<0) or np.any(band[:,0]>=image.shape[1]) or np.any(band[:,1]>=image.shape[0]):
        return {'verified':False,'reason':'stripe_outside_image'}
    patch=cv2.warpPerspective(image,cv2.getPerspectiveTransform(band,np.float32([[0,0],[79,0],[79,11],[0,11]])),(80,12))
    hsv=cv2.cvtColor(patch,cv2.COLOR_BGR2HSV)
    valid=(hsv[:,:,1]>100)&(hsv[:,:,2]>35)
    pixels=patch[valid][:,::-1].astype(float)
    if len(pixels)<12:return {'verified':False,'reason':'insufficient_color_pixels'}
    chroma=pixels-pixels.min(axis=1,keepdims=True)
    chroma/=np.maximum(chroma.max(axis=1,keepdims=True),1)
    sample=np.median(chroma,axis=0)
    distances={}
    for suit,rgb in CODE_COLORS.items():
        target=np.array(rgb,dtype=float);target-=target.min();target/=target.max()
        distances[suit]=float(np.linalg.norm(sample-target))
    ranked=sorted(distances,key=distances.get)
    verified=ranked[0]==expected_tile[0] and distances[ranked[0]]<.25 and distances[ranked[1]]-distances[ranked[0]]>.2
    return {'verified':verified,'suit':ranked[0],'distance':round(distances[ranked[0]],4),'pixels':len(pixels)}

def decode_colored(image):
    result=[]
    for hit in decode_consensus(image):
        check=color_check(image,hit['corners'],hit['tile'])
        if check['verified']:
            color_score=100*max(0.,1-check['distance']/.25)
            result.append({**hit,'color':check,
                'score':round(.9*hit['recognition']['score']+.1*color_score,2)})
    return result


def build():
    OUT.mkdir(parents=True,exist_ok=True)
    # Preserve unused atlas areas; replace only the 37 known face rectangles.
    atlas=Image.open(ROOT/'static-assets/extracted/mjp.png').convert('RGBA')
    mapping=[]
    for row,tiles in enumerate(ROWS):
        for col,tile in enumerate(tiles):
            index=TILES.index(tile);face=tile_image(index)
            atlas.paste(face,(col*52,row*73))
            mapping.append({'tile':tile,'marker_id':index,'rect':[col*52,row*73,52,73]})
    atlas.save(OUT/'mjp-coded.png')
    (OUT/'mapping.json').write_text(json.dumps({'dictionary':'DICT_4X4_50','errorCorrectionRate':0,'tiles':mapping},indent=2),encoding='utf-8')

def validate():
    results=[];failures=[]
    for width in (26,32,40,52,80):
        correct=missing=wrong=0
        for index,tile in enumerate(TILES):
            source=np.array(tile_image(index))
            for rotation in range(4):
                for light in (.6,1.0,1.2):
                    for skew in (0,.12):
                        h,w=source.shape[:2]
                        src=np.float32([[0,0],[w-1,0],[w-1,h-1],[0,h-1]])
                        dst=np.float32([[w*skew,0],[w-1-w*skew,0],[w-1,h-1],[0,h-1]])
                        warped=cv2.warpPerspective(source,cv2.getPerspectiveTransform(src,dst),(w,h),borderValue=(255,255,255))
                        small=cv2.resize(warped,(width,round(width*73/52)),interpolation=cv2.INTER_AREA)
                        small=np.clip(small*light,0,255).astype(np.uint8)
                        small=np.rot90(small,rotation).copy()
                        framed=cv2.copyMakeBorder(small,12,12,12,12,cv2.BORDER_CONSTANT,value=(255,255,255))
                        found=decode(cv2.cvtColor(framed,cv2.COLOR_RGB2BGR))
                        if not found:missing+=1
                        elif len(found)==1 and found[0]['tile']==tile:correct+=1
                        else:
                            wrong+=1;failures.append(dict(width=width,tile=tile,rotation=rotation,light=light,skew=skew,found=found))
        results.append(dict(tile_width=width,correct=correct,unreadable=missing,wrong=wrong,total=correct+missing+wrong))
    report={'scope':'synthetic rotation, perspective, brightness and resampling only; not live game verification','results':results,'failures':failures}
    (OUT/'synthetic-validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))

if __name__=='__main__':build();validate()
