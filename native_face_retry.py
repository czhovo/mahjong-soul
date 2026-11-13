"""Retry only unread face outlines using the original, unresized pixels."""
import cv2
import numpy as np
from coded_tiles import decode_consensus, color_check
from native_layout import pixel_box,layout_points
from recognize_coded_frame import marker_matches_face, faces_match_polygons, order_river, region

def discard_covered_rejections(entry):
    """A failed alternative at a successfully read face is not a missing tile."""
    remaining=[]
    for rejected in entry.get('rejected',[]):
        near=[t for t in entry['tiles'] if t.get('color',{}).get('verified') and
              np.linalg.norm(np.asarray(t['center'])-rejected['center'])<6]
        faces=[p for p in entry.get('face_polygons',[]) if marker_matches_face(rejected,p)]
        covered=len(near)==1 and len(faces)==1 and marker_matches_face(near[0],faces[0]) and sum(marker_matches_face(t,faces[0]) for t in entry['tiles'])==1
        if covered:entry.setdefault('superseded_rejected',[]).append(rejected)
        else:remaining.append(rejected)
    entry['rejected']=remaining

def deduplicate_faces(entry):
    # Identity alone is not a duplicate: consecutive equal discards are legal.
    unique=[]
    for tile in entry['tiles']:
        if any(t['tile']==tile['tile'] and np.linalg.norm(np.asarray(t['center'])-tile['center'])<6 for t in unique):continue
        unique.append(tile)
    entry['tiles']=unique
    polygons=[]
    for polygon in entry.get('face_polygons',[]):
        matches=[i for i,t in enumerate(unique) if marker_matches_face(t,polygon)]
        if len(matches)==1 and any(marker_matches_face(unique[matches[0]],p) for p in polygons):continue
        polygons.append(polygon)
    entry['face_polygons']=polygons
    entry['face_boxes']=[list(cv2.boundingRect(np.float32(p))) for p in polygons]
    entry['face_count']=len(polygons)

def retry_faces(entry, native, scale):
    if entry.get('complete'):return
    sx,sy=scale
    for polygon in entry.get('face_polygons',[]):
        if any(marker_matches_face(t,polygon) for t in entry['tiles']):continue
        points=(np.asarray(polygon)-[1,31])*[sx,sy]+[1,31]
        x,y,w,h=cv2.boundingRect(np.float32(points))
        x=max(0,x-6);y=max(0,y-6)
        sample=native[y:min(native.shape[0],y+h+12),x:min(native.shape[1],x+w+12)]
        if not sample.size:continue
        candidates=[]
        for hit in decode_consensus(sample):
            original=np.asarray(hit['corners'])+[x,y]
            corners=layout_points(original,native)
            tile={**hit,'corners':corners.tolist(),'center':corners.mean(axis=0).tolist()}
            if not marker_matches_face(tile,polygon):continue
            check=color_check(native,original,hit['tile'])
            if check['verified']:candidates.append({**tile,'color':check,'decode_source':'native-face-retry'})
        if candidates and len({t['id'] for t in candidates})==1:
            entry['tiles'].append(candidates[0])
    entry['complete']=not entry.get('prefix_missing') and not entry.get('layout_gap') and not entry.get('rejected') and faces_match_polygons(entry['tiles'],entry.get('face_polygons',[]))

def retry_own_meld_faces(coded,native,scale):
    # Own melds previously had no native-pixel retry at all. A sideways code
    # lost during calibration must not become permanently unreadable.
    from meld_vision import read_own_melds
    faces=coded.get('meld_faces',[])
    observed=read_own_melds(faces,[],None)
    if observed['complete'] and not any(g.get('estimated') for g in observed['groups']):return
    left=max(150,min((min(p[0] for p in t['corners']) for t in faces),default=150)-90)
    recovered=region(native,(left,635,1320,800),check_faces=True)['tiles']
    for hit in recovered:
        corners=np.asarray(hit['corners'])
        if min(np.linalg.norm(corners-np.roll(corners,1,axis=0),axis=1))>=40:continue
        center=corners.mean(axis=0)
        if any(np.linalg.norm(np.asarray(t['center'])-center)<6 for t in faces):continue
        faces.append({**hit,'decode_source':'native-own-meld-retry'})
    faces.sort(key=lambda t:t['center'][0])

def refine_native_regions(coded,native,scale):
    retry_own_meld_faces(coded,native,scale)
    for entry in coded.get('opponent_meld_faces',{}).values():retry_faces(entry,native,scale)
    for position,entry in coded.get('rivers',{}).items():
        if entry.get('defer_unread_to_next_frame') or entry.get('complete'):continue
        if entry.get('recognition_mode')=='last-row':
            # Closed rows were already verified; retry and sort only active rows.
            n=entry.get('reused_prefix_count',0);f=entry.get('reused_face_count',0)
            tail={**entry,'tiles':entry['tiles'][n:],'face_polygons':entry.get('face_polygons',[])[f:]}
            tail['face_boxes']=entry.get('face_boxes',[])[f:]
            tail['face_count']=len(tail['face_polygons'])
            # Include confirmed prefix identities as occupied locations during
            # retry. A duplicate tail outline must not decode an old tile again.
            tail['tiles']=entry['tiles'][:n]+tail['tiles']
            retry_faces(tail,native,scale)
            entry['tiles']=tail['tiles']
            deduplicate_faces(entry)
            discard_covered_rejections(entry)
            # Slot geometry needs the immutable prefix restored first.
            order_river(entry,position)
            entry['complete']=not entry.get('prefix_missing') and not entry.get('layout_gap') and not entry.get('rejected') and faces_match_polygons(entry['tiles'],entry.get('face_polygons',[]))
        else:
            retry_faces(entry,native,scale)
            deduplicate_faces(entry)
            discard_covered_rejections(entry)
            order_river(entry,position)
            entry['complete']=not entry.get('prefix_missing') and not entry.get('layout_gap') and not entry.get('rejected') and faces_match_polygons(entry['tiles'],entry.get('face_polygons',[]))
