"""Fixed-layout hand recognizer. Offline images only; never sends mouse input."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np

BASE = (1368, 800)

def load(path):
    if Path(path).suffix=='.mjc':
        from frame_archive import read_rgb
        return cv2.cvtColor(read_rgb(path),cv2.COLOR_RGB2BGR)
    image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Cannot decode {path}")
    return image

def detect_hand(image, hand_right=1140):
    h, w = image.shape[:2]
    sx, sy = w / BASE[0], h / BASE[1]
    x0, y0, x1, y1 = [round(v) for v in (145*sx, 645*sy, hand_right*sx, 797*sy)]
    roi = image[y0:y1, x0:x1]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([0, 0, 135]), np.array([179, 85, 255]))
    # Do not close horizontally: adjacent tile faces have only 1-2px gaps.
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        if 45*sx <= bw <= 78*sx and 65*sy <= bh <= 123*sy:
            boxes.append([x+x0, y+y0, bw, bh])
        elif 115*sx <= bw <= 145*sx and 100*sy <= bh <= 150*sy:
            # A hovered tile and its neighbour can become one component when
            # the pointer bridges their narrow gap. Recover two face bands;
            # each must independently have the expected height and width.
            half=round((bw+2*sx)/2)
            recovered=[]
            for offset in (0,half):
                width=min(round(66*sx),bw-offset)
                band=mask[y:y+bh,x+offset:x+offset+width]
                rows=np.flatnonzero(np.count_nonzero(band,axis=1)>=.65*width)
                if len(rows)==0:break
                top,bottom=int(rows[0]),int(rows[-1])
                if not 65*sy<=bottom-top+1<=123*sy:break
                recovered.append([x+x0+offset,y+y0+top,width,bottom-top+1])
            if len(recovered)==2:boxes.extend(recovered)
    return sorted(boxes, key=lambda box: box[0])

def feature(image, box):
    x, y, w, h = box
    # Tile borders and shadows carry no identity. Keep the blank face of Z5.
    dx, dy = max(2, round(w*.10)), max(2, round(h*.10))
    crop = image[y+dy:y+h-dy, x+dx:x+w-dx]
    return cv2.resize(crop, (40, 64), interpolation=cv2.INTER_AREA)

def own_meld_faces(image, left=1080):
    """Candidate face boxes only. Do not infer identities/source from geometry.

    This calibrated region covers the first own meld; more melds require a
    separately verified left boundary. Opponent perspective is not supported.
    """
    h,w=image.shape[:2]
    sx,sy=w/BASE[0],h/BASE[1]
    x0,y0,x1,y1=map(round,(left*sx,680*sy,1320*sx,785*sy))
    roi=image[y0:y1,x0:x1]
    mask=cv2.inRange(cv2.cvtColor(roi,cv2.COLOR_BGR2HSV),np.array([0,0,135]),np.array([179,85,255]))
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    faces=[]
    for contour in contours:
        x,y,bw,bh=cv2.boundingRect(contour)
        if 40*sx<=bw<=85*sx and 35*sy<=bh<=80*sy:
            hull=cv2.convexHull(contour)
            polygon=cv2.approxPolyDP(hull,.04*cv2.arcLength(hull,True),True).reshape(-1,2)
            quad=(polygon+np.array([x0,y0])).tolist() if len(polygon)==4 else None
            faces.append({'box':[x+x0,y+y0,bw,bh],'quad':quad,
                          'orientation_candidate':'sideways' if bw/sx>1.35*bh/sy else 'upright',
                          'tile':None,'verified':False})
    return sorted(faces,key=lambda f:f['box'][0])

def recognize_meld_faces(image,directory,left):
    from atlas_templates import load_templates,rank as atlas_rank
    atlas=load_templates()
    templates=[]
    for path in sorted(Path(directory).glob('*.png')):
        tile,orientation,*_=path.stem.split('_')
        templates.append((tile,orientation,load(str(path))))
    faces=own_meld_faces(image,left)
    for face in faces:
        sample=feature(image,face['box'])
        scores={}
        for tile,orientation,template in templates:
            if orientation!=face['orientation_candidate']:continue
            error=float(np.mean(np.abs(sample.astype(float)-template.astype(float)))/255)
            scores[tile]=min(scores.get(tile,1),error)
        ranking=sorted(scores.items(),key=lambda p:p[1])
        best=ranking[0] if ranking else (None,1)
        margin=ranking[1][1]-best[1] if len(ranking)>1 else 0
        # Restrictive prototype threshold: incomplete template coverage must
        # never turn an arbitrary nearest class into an accepted identity.
        accepted=best[1]<.045 and margin>.025
        if not accepted and face['quad']:
            points=np.array(face['quad'],dtype=np.float32)
            total=points.sum(axis=1);difference=points[:,1]-points[:,0]
            ordered=np.array([points[total.argmin()],points[difference.argmin()],points[total.argmax()],points[difference.argmax()]],dtype=np.float32)
            sideways=face['orientation_candidate']=='sideways'
            width,height=(73,52) if sideways else (52,73)
            target=np.array([[0,0],[width-1,0],[width-1,height-1],[0,height-1]],np.float32)
            warped=cv2.warpPerspective(image,cv2.getPerspectiveTransform(ordered,target),(width,height))
            variants=[np.rot90(warped,k).copy() for k in ((1,3) if sideways else (0,))]
            alternatives={}
            for variant in variants:
                for error,tile in atlas_rank(variant[2:-2,2:-2],atlas):alternatives[tile]=min(alternatives.get(tile,1),error)
            ranked=sorted((error,tile) for tile,error in alternatives.items())
            if ranked:
                alt_margin=ranked[1][0]-ranked[0][0]
                if ranked[0][0]<.25 and alt_margin>.035:
                    best=(ranked[0][1],ranked[0][0]);margin=alt_margin;accepted=True
        face.update(tile=best[0] if accepted else None,candidate=best[0],
                    error=round(best[1],4),margin=round(margin,4))
    return faces

def recognize(image, directory, meld_count=0, phase='discard', hand_right=1140):
    if meld_count not in range(5) or phase not in ('discard', 'waiting'):
        raise ValueError('Explicit meld count and hand phase required')
    if meld_count and hand_right == 1140:
        raise ValueError('Meld boundary must be verified before recognizing an open hand')
    templates = []
    for path in sorted(Path(directory).glob('*.png')):
        templates.append((path.stem.split('_')[0], load(str(path))))
    from atlas_templates import rank as atlas_rank
    atlas_directory=Path(__file__).parent/'templates/atlas'
    atlas={p.stem:load(str(p)) for p in atlas_directory.glob('*.png')}
    output = []
    for box in detect_hand(image, hand_right):
        sample = feature(image, box)
        scores = {}
        for tile, template in templates:
            # RGB differences retain red-five identity; class-level runner-up
            # avoids treating two examples of the same tile as ambiguity.
            error = float(np.mean(np.abs(sample.astype(float)-template.astype(float)))/255)
            scores[tile] = min(scores.get(tile, 1), error)
        ranking = sorted(scores.items(), key=lambda p: p[1])
        best = ranking[0] if ranking else (None, 1)
        margin = ranking[1][1]-best[1] if len(ranking)>1 else 0
        accepted = (best[1] < .10 and margin > .025) or (best[1] < .12 and margin > .045)
        source='screen-template'
        atlas_scores=atlas_rank(sample,atlas) if atlas else []
        atlas_best=atlas_scores[0] if atlas_scores else (1,None)
        atlas_margin=atlas_scores[1][0]-atlas_best[0] if len(atlas_scores)>1 else 0
        atlas_accepted=atlas_best[0]<.29 and atlas_margin>.035
        # A weak synthetic match must not overrule a close measured template.
        # Strong contradictory matches remain blocked for inspection.
        conflict=accepted and atlas_accepted and best[0]!=atlas_best[1]
        if conflict:
            accepted=False
        elif not accepted and atlas_accepted:
            best=(atlas_best[1],atlas_best[0]);margin=atlas_margin
            accepted=True;source='static-atlas'
        output.append({'tile':best[0] if accepted else None,'candidate':best[0],
                       'error':round(best[1],4),'margin':round(margin,4),'box':box,
                       'source':source,'template_conflict':conflict,
                       'center':[box[0]+box[2]//2,box[1]+box[3]//2]})
    expected = (14 if phase == 'discard' else 13)-3*meld_count
    return {'tiles':output,'expected_count':expected,'meld_count':meld_count,'phase':phase,
            'complete':len(output)==expected and all(x['tile'] for x in output),
            'scope':'own hand only; completeness does not verify turn or public event history'}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('image')
    parser.add_argument('--templates', default=str(Path(__file__).parent/'templates'/'hand'))
    parser.add_argument('--labels', help='Manually verified left-to-right labels to build templates')
    parser.add_argument('--meld-count',type=int,default=0)
    parser.add_argument('--phase',choices=['waiting','discard'],default='discard')
    parser.add_argument('--hand-right',type=int,default=1140,help='Verified hand/meld boundary in baseline pixels')
    args = parser.parse_args()
    image = load(args.image)
    if args.labels:
        labels = args.labels.split()
        boxes = detect_hand(image,args.hand_right)
        if len(labels) != len(boxes):
            raise ValueError(f'Label count {len(labels)} differs from detected tiles {len(boxes)}: {boxes}')
        directory = Path(args.templates)
        directory.mkdir(parents=True, exist_ok=True)
        for index, (tile, box) in enumerate(zip(labels, boxes)):
            if tile not in [s+str(n) for s in 'WBT' for n in range(10)]+['Z'+str(n) for n in range(1,8)]:
                raise ValueError(f'Invalid tile label {tile}')
            target = directory/f'{tile}_{Path(args.image).stem}_{index}.png'
            cv2.imencode('.png', feature(image, box))[1].tofile(str(target))
    print(json.dumps(recognize(image,args.templates,args.meld_count,args.phase,args.hand_right),ensure_ascii=False))

if __name__ == '__main__':
    main()
