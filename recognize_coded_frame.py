"""Visible coded faces only. Region completeness is separate from event history."""
import argparse,json
from copy import deepcopy
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import cv2
import numpy as np
from coded_tiles import decode_consensus,color_check

RIVERS={'self':(525,412,1040,575),'opposite':(550,130,810,250),
        'left':(365,230,557,540),'right':(805,140,1050,425)}

# Fixed capture boxes on the calibrated 1368x800 window. Indexed by seat/row.
RIVER_ROWS={
 'self':((525,412,1040,478),(525,439,1040,524),(525,485,1040,570)),
 'opposite':((550,182,810,250),(550,150,810,221),(550,130,810,189)),
 'left':((479,230,557,540),(426,230,554,540),(373,230,501,540)),
 'right':((805,140,900,425),(832,140,957,425),(889,140,1014,425)),
}

# Reuse only byte-identical visible pixels, including the four-pixel halo used
# by scaled retries. Copies prevent callers' sorting/tracking from contaminating
# later observations. No time-based or inferred-state reuse is permitted.
_REGION_CACHE=OrderedDict()
_cache_lock=Lock()
_region_pool=None

def configure_region_workers(workers=0):
    global _region_pool
    if _region_pool is not None:_region_pool.shutdown(wait=True)
    _region_pool=ThreadPoolExecutor(max_workers=workers) if workers else None

def _region_job(job):
    image,box,options=job
    return region(image,box,**options)

def map_regions(jobs):
    # Consume all results before returning: no work from a failed observation
    # may overlap the next one or mutate its exact-pixel region cache.
    if _region_pool is None:return list(map(_region_job,jobs))
    futures=[_region_pool.submit(_region_job,job) for job in jobs]
    try:return [f.result() for f in futures]
    finally:
        for f in futures:
            try:f.result()
            except Exception:pass

def marker_matches_face(tile,polygon):
    """Match the decoded quadrilateral to a rotated face, not an axis-aligned centre box."""
    marker=cv2.convexHull(np.float32(tile['corners'])).reshape(-1,2)
    face=cv2.convexHull(np.float32(polygon)).reshape(-1,2)
    area=cv2.contourArea(marker)
    if area<=0:return False
    overlap,_=cv2.intersectConvexConvex(marker,face)
    edge=float(np.min(np.linalg.norm(marker-np.roll(marker,1,axis=0),axis=1)))
    distance=cv2.pointPolygonTest(face,tuple(map(float,tile['center'])),True)
    return overlap/area>=.25 and distance>=-.20*edge

def faces_match_polygons(tiles,polygons):
    if len(tiles)!=len(polygons):return False
    matches=[[i for i,t in enumerate(tiles) if marker_matches_face(t,p)] for p in polygons]
    return all(len(m)==1 for m in matches) and len({i for m in matches for i in m})==len(tiles)

def decoded_face_outline(image,tile):
    # A rotated white edge can fragment below contour thresholds. Recover its
    # geometry from a directly decoded marker only if both exterior white
    # margins are independently present in the original pixels.
    if not tile.get('color',{}).get('verified'):return None
    canonical=np.float32([[5,10],[46,10],[46,51],[5,51]])
    matrix=cv2.getPerspectiveTransform(np.float32(tile['corners']),canonical)
    patch=cv2.warpPerspective(image,matrix,(52,73))
    hsv=cv2.cvtColor(patch,cv2.COLOR_BGR2HSV)
    white=(hsv[:,:,1]<65)&(hsv[:,:,2]>=150)
    # Hovering a tile tints all matching discards blue (H~102, S~94).
    # The exact marker and suit strip above are still required. Accept this
    # specific border tint too; it is not a reason to lose a decoded face.
    blue=(hsv[:,:,0]>=99)&(hsv[:,:,0]<=108)&(hsv[:,:,1]>=75)&(hsv[:,:,1]<=115)&(hsv[:,:,2]>=140)
    white|=blue
    if min(white[14:49,1:3].mean(),white[14:49,49:51].mean())<.60:return None
    inverse=cv2.getPerspectiveTransform(canonical,np.float32(tile['corners']))
    return cv2.perspectiveTransform(np.float32([[[0,0],[51,0],[51,72],[0,72]]]),inverse)[0].tolist()

def split_face_polygons(boxes,source_polygons):
    # Existing row splits remain independent of decoded marker count. Clip the
    # original rotated outline to each split instead of replacing it by a box.
    result=[]
    for x,y,w,h in boxes:
        clip=np.float32([[x,y],[x+w,y],[x+w,y+h],[x,y+h]])
        candidates=[cv2.intersectConvexConvex(np.float32(p),clip) for p in source_polygons]
        area,poly=max(candidates,key=lambda pair:pair[0])
        result.append(poly.reshape(-1,2).tolist() if area>0 else clip.tolist())
    return result

def faces_match_boxes(tiles,boxes,tolerance=0):
    """Require a one-to-one outline/decoded-marker match, with bounded edge erosion."""
    if len(tiles)!=len(boxes):return False
    matches=[[i for i,t in enumerate(tiles)
              if x-tolerance<=t['center'][0]<x+w+tolerance and y-tolerance<=t['center'][1]<y+h+tolerance]
             for x,y,w,h in boxes]
    return all(len(m)==1 for m in matches) and len({i for m in matches for i in m})==len(tiles)
def region(image,box,check_faces=False,horizontal_face_pitch=None,vertical_face_pitch=None,opening_kernel=3,min_face_width=20,retry_scales=True,public_meld_position=None):
    key=(tuple(image.shape),tuple(box),check_faces,horizontal_face_pitch,vertical_face_pitch,opening_kernel,min_face_width,retry_scales,public_meld_position)
    x0,y0,x1,y1=box
    pixels=image[max(0,y0-4):min(image.shape[0],y1+4),max(0,x0-4):min(image.shape[1],x1+4)]
    with _cache_lock:
        cached=_REGION_CACHE.get(key)
        if cached is not None and np.array_equal(cached[0],pixels):
            _REGION_CACHE.move_to_end(key)
            return deepcopy(cached[1])
    result=_region_uncached(image,box,check_faces,horizontal_face_pitch,vertical_face_pitch,opening_kernel,min_face_width,retry_scales,public_meld_position)
    with _cache_lock:
        _REGION_CACHE[key]=(pixels.copy(),deepcopy(result))
        _REGION_CACHE.move_to_end(key)
        while len(_REGION_CACHE)>32:_REGION_CACHE.popitem(last=False)
    return result

def public_meld_outline_candidate(box,position,tiles):
    """Dimensions are in the calibrated 1368x800 frame, before row splitting.

    Do not discard a contour supported by a decoded marker (including stacked
    kongs). Ordinary undecoded tile-sized contours remain mandatory evidence.
    """
    x,y,w,h=box
    if any(x<=t['center'][0]<=x+w and y<=t['center'][1]<=y+h for t in tiles):return True
    if position=='right' and w<32:return False
    # Top meld faces are ~28-42px high. Full-height 70px components clipped
    # against both ROI edges belong to overlays/other bands, not a tile face.
    if position=='opposite' and y<=41 and y+h>=109 and h>=65:return False
    return True

def _region_uncached(image,box,check_faces=False,horizontal_face_pitch=None,vertical_face_pitch=None,opening_kernel=3,min_face_width=20,retry_scales=True,public_meld_position=None):
    x0,y0,x1,y1=box
    crop=image[y0:y1,x0:x1]
    accepted=[];rejected=[]
    for hit in decode_consensus(crop):
        check=color_check(crop,hit['corners'],hit['tile'])
        corners=np.asarray(hit['corners'])+[x0,y0]
        item={**hit,'corners':corners.tolist(),'center':corners.mean(axis=0).tolist(),'color':check}
        (accepted if check['verified'] else rejected).append(item)
    result={'tiles':accepted,'rejected':rejected,'complete':False}
    if check_faces:
        hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
        mask=cv2.inRange(hsv,np.array([0,0,150]),np.array([179,65,255]))
        # Remove thin highlight/particle bridges between otherwise separate
        # white tile faces before counting independent visible outlines.
        mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,np.ones((opening_kernel,opening_kernel),np.uint8))
        contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        boxes=[];source_polygons=[]
        for contour in contours:
            if cv2.contourArea(contour)<200:continue
            x,y,w,h=cv2.boundingRect(contour)
            if not (min_face_width<=w<=(500 if horizontal_face_pitch else 76) and 20<=h<=130):continue
            if not public_meld_outline_candidate([x+x0,y+y0,w,h],public_meld_position,accepted+rejected):continue
            boxes.append([x+x0,y+y0,w,h])
            source_polygons.append((cv2.boxPoints(cv2.minAreaRect(contour))+[x0,y0]).astype(np.float32))
        # White cells within a decoded marker can be separate mask components.
        # Fully nested contours are not additional physical tiles.
        keep=[]
        for i,p in enumerate(source_polygons):
            area=cv2.contourArea(p)
            if not any(i!=j and cv2.contourArea(q)>area*1.5 and
                       cv2.intersectConvexConvex(p,q)[0]>=area*.98
                       for j,q in enumerate(source_polygons)):keep.append(i)
        boxes=[boxes[i] for i in keep];source_polygons=[source_polygons[i] for i in keep]
        if horizontal_face_pitch:
            # Calibrated top meld row: upright faces are ~34 px wide;
            # sideways called faces are ~47 px wide. Joined upright outlines
            # are split geometrically, independently of successful decoding.
            separated=[]
            for x,y,w,h in boxes:
                if w>1.8*horizontal_face_pitch and 28<=h<=40:
                    count=round(w/horizontal_face_pitch)
                    if abs(w/count-horizontal_face_pitch)>6:
                        separated.append([x,y,w,h]);continue
                    for i in range(count):
                        a=round(i*w/count);b=round((i+1)*w/count)
                        separated.append([x+a,y,b-a,h])
                else:separated.append([x,y,w,h])
            boxes=separated
        if vertical_face_pitch:
            separated=[]
            for x,y,w,h in boxes:
                if 40<=w<=65 and h>1.8*vertical_face_pitch:
                    count=round(h/vertical_face_pitch)
                    if abs(h/count-vertical_face_pitch)<=4:
                        for i in range(count):
                            a=round(i*h/count);b=round((i+1)*h/count)
                            separated.append([x,y+a,w,b-a])
                        continue
                separated.append([x,y,w,h])
            boxes=separated
        # Perspective can join two adjacent tile faces vertically. Split
        # tall outlines by the independent median face height, not by the
        # number of successfully decoded markers (which could miss a tile).
        if len(boxes)>=4:
            typical=float(np.median([b[3] for b in boxes]))
            typical_width=float(np.median([b[2] for b in boxes]))
            separated=[]
            for x,y,w,h in boxes:
                # A sideways declaration on a side river is taller AND
                # narrower. Only split vertically joined regular-width faces.
                if h>1.65*typical and w>=.9*typical_width:
                    count=max(2,int(h/typical+.3))
                    for i in range(count):
                        a=round(i*h/count);b=round((i+1)*h/count)
                        separated.append([x,y+a,w,b-a])
                else:separated.append([x,y,w,h])
            boxes=separated
        polygons=split_face_polygons(boxes,source_polygons)
        # Small perspective markers can fall between threshold pixels. Retry
        # only an independently detected, otherwise unread face at 2/3/4x scale.
        # Exact marker decoding and original-image suit checks still apply.
        for (x,y,w,h),polygon in zip(boxes,polygons):
            if any(marker_matches_face(t,polygon) for t in accepted):continue
            ax,ay=max(0,x-4),max(0,y-4)
            bx,by=min(image.shape[1],x+w+4),min(image.shape[0],y+h+4)
            sample=image[ay:by,ax:bx]
            candidates=[]
            for interpolation in (cv2.INTER_CUBIC,cv2.INTER_NEAREST,cv2.INTER_LINEAR):
                for scale in ((2,3,4) if retry_scales else ()):
                    enlarged=cv2.resize(sample,None,fx=scale,fy=scale,interpolation=interpolation)
                    for hit in decode_consensus(enlarged):
                        corners=np.asarray(hit['corners'])/scale+[ax,ay];center=corners.mean(axis=0)
                        if not marker_matches_face({'corners':corners,'center':center},polygon):continue
                        # Far-side perspective compresses genuine markers to
                        # 10px. Exact dictionary and suit validation still apply.
                        if min(np.linalg.norm(corners-np.roll(corners,1,axis=0),axis=1))<6:continue
                        check=color_check(image,corners,hit['tile'])
                        if check['verified']:candidates.append({**hit,'corners':corners.tolist(),'center':center.tolist(),'color':check,'decode_scale':scale})
                if candidates:break
            if candidates and len({t['id'] for t in candidates})==1:accepted.append(candidates[0])
        for tile in accepted:
            if any(marker_matches_face(tile,p) for p in polygons):continue
            polygon=decoded_face_outline(image,tile)
            if polygon is None:continue
            # Do not merge or overwrite another detected face.
            if any(marker_matches_face(other,polygon) for other in accepted if other is not tile):continue
            polygons.append(polygon)
            boxes.append(list(cv2.boundingRect(np.float32(polygon))))
        result.update(face_count=len(boxes),face_boxes=boxes,face_polygons=polygons,
            complete=not rejected and faces_match_polygons(accepted,polygons))
    return result

def read_rivers(image,retry_scales=True,tracker=None,identity=None):
    if tracker is not None:return tracker.read(image,identity,retry_scales)
    return decode_rivers(image,retry_scales)

def decode_rivers(image,retry_scales=True,positions=None,active_rows=None):
    result={}
    selected={k:v for k,v in RIVERS.items() if positions is None or k in positions}
    if active_rows:
        for seat,row in active_rows.items():
            if seat not in selected:continue
            first,last=row if isinstance(row,tuple) else (row,row)
            boxes=RIVER_ROWS[seat][first:last+1]
            selected[seat]=(min(b[0] for b in boxes),min(b[1] for b in boxes),
                            max(b[2] for b in boxes),max(b[3] for b in boxes))
    entries=map_regions([(image,box,dict(check_faces=True,horizontal_face_pitch=38 if seat=='opposite' else None,
        vertical_face_pitch=28 if seat in ('left','right') else None,
        opening_kernel=3,retry_scales=retry_scales)) for seat,box in selected.items()])
    for seat,entry in zip(selected,entries):
        # Five-pixel erosion can remove a small far-side face, or leave only
        # the lower edge of a tilted tile and count it again as a new face.
        # Use it only to separate joined outlines, and never drop a marker
        # that the gentler pass has already decoded.
        if not entry['complete'] and seat in ('left','opposite'):
            alternative=region(image,selected[seat],check_faces=True,
                horizontal_face_pitch=38 if seat=='opposite' else None,
                vertical_face_pitch=28 if seat in ('left','right') else None,
                opening_kernel=5,retry_scales=retry_scales)
            if alternative['complete'] and all(any(t['tile']==q['tile'] and
                np.linalg.norm(np.asarray(t['center'])-q['center'])<6
                for q in alternative['tiles']) for t in entry['tiles']) and all(
                any(marker_matches_face(t,p) for t in alternative['tiles'])
                for p in entry.get('face_polygons',[])):entry=alternative
        # Broad capture ROIs include moving discard/hand effects outside the
        # three physical river rows. Unmatched outlines there are not holes.
        kept=[]
        for box,polygon in zip(entry.get('face_boxes',[]),entry.get('face_polygons',[])):
            if any(marker_matches_face(t,polygon) for t in entry['tiles']):
                kept.append((box,polygon));continue
            x,y=np.mean(polygon,axis=0)
            row=(round((y-435)/46) if seat=='self' else round((217-y)/32) if seat=='opposite' else
                 round((529-x-.10*(y-247))/53) if seat=='left' else round((x-843-.10*(y-340))/57))
            if 0<=row<=2:kept.append((box,polygon))
        entry['face_boxes']=[b for b,p in kept];entry['face_polygons']=[p for b,p in kept]
        entry['face_count']=len(kept)
        entry['complete']=not entry['rejected'] and faces_match_polygons(entry['tiles'],entry['face_polygons'])
        # Left-river selection highlights can connect adjacent columns by a
        # four-pixel bridge. Five-pixel opening separates the independent
        # faces without inferring their count from successful marker reads.
        order_river(entry,seat)
        result[seat]=entry
    return result

def order_river(entry,seat):
    for t in entry['tiles']:
        x,y=t['center']
        edge=np.asarray(t['corners'][1])-np.asarray(t['corners'][0])
        horizontal=abs(edge[0])>2*abs(edge[1])
        vertical=abs(edge[1])>2*abs(edge[0])
        t['sideways']=bool(vertical if seat in ('self','opposite') else horizontal) if horizontal or vertical else None
        if seat=='self':row=round((y-435)/46);order=x
        elif seat=='opposite':row=round((217-y)/32);order=-x
        elif seat=='left':row=round((529-x-.10*(y-247))/53);order=y
        else:row=round((x-843-.10*(y-340))/57);order=-y
        t.update(row=row,order=order)
    entry['tiles'].sort(key=lambda t:(t['row'],t['order']))
    counts={}
    for t in entry['tiles']:
        t['column']=counts.get(t['row'],0);counts[t['row']]=t['column']+1
        del t['order']
    if any(t['row']<0 or t['row']>2 for t in entry['tiles']):entry['complete']=False

    # Missing decoded faces must leave holes in the physical slot numbering.
    # Otherwise all later discards slide into old slots and disappear from logs.
    polygons=entry.get('face_polygons',[])
    physical=[]
    for polygon in polygons:
        matches=[t for t in entry['tiles'] if marker_matches_face(t,polygon)]
        if len(matches)>1:return
        x,y=np.mean(polygon,axis=0)
        row=(matches[0]['row'] if matches else
             round((y-435)/46) if seat=='self' else
             round((217-y)/32) if seat=='opposite' else
             round((529-x-.10*(y-247))/53) if seat=='left' else
             round((x-843-.10*(y-340))/57))
        order=x if seat=='self' else -x if seat=='opposite' else y if seat=='left' else -y
        physical.append((row,order,matches))
    counts={}
    for row,_,matches in sorted(physical,key=lambda v:(v[0],v[1])):
        column=counts.get(row,0);counts[row]=column+1
        if matches:matches[0]['column']=column

    # A single readable tile near the END of a row is not a complete river.
    # Animations can hide both the old markers and their white outlines, so
    # a matching marker/outline count alone cannot establish a new prefix.
    entry['layout_gap']=False
    for row in {r for r,_,_ in physical}:
        first=min((v for v in physical if v[0]==row),key=lambda v:v[1])
        start,pitch=((568-4*row,44) if seat=='self' else (-(781-3*row),38)
                     if seat=='opposite' else (247,27) if seat=='left' else (-391,29))
        if first[1]-start>pitch*1.4:entry['layout_gap']=True
    if entry['layout_gap']:entry['complete']=False

def read_dora(image):
    dora=region(image,(12,60,222,123),check_faces=True)
    dora['tiles'].sort(key=lambda t:t['center'][0])
    dora['complete']=dora['complete'] and 1<=len(dora['tiles'])<=5
    return dora

def hand_outlines(image,tiles,hand_right=1150):
    """Count large concealed faces independently of decoded marker count.

    At the calibrated client size each face is 67.5 pixels wide. Adjacent
    white outlines may join in pairs; split only an integer calibrated pitch.
    Smaller exposed meld faces do not satisfy the height/width constraints.
    """
    # A drawn tile can remain separated from the shortened concealed row.
    # Never crop an already decoded full-size face using meld-count geometry.
    if tiles:
        hand_right=max(hand_right,max(max(p[0] for p in t['corners']) for t in tiles)+15)
    hand_right=min(image.shape[1],int(hand_right))
    hsv=cv2.cvtColor(image[635:800,150:hand_right],cv2.COLOR_BGR2HSV)
    mask=cv2.inRange(hsv,np.array([0,0,100]),np.array([179,75,255]))
    mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,np.ones((3,3),np.uint8))
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    boxes=[];ambiguous=False
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        if w<40 or not 65<=h<=170:continue
        count=round(w/67.5)
        if count<1 or abs(w/count-67.5)>3:
            ambiguous=True;continue
        for i in range(count):
            a=round(i*w/count);b=round((i+1)*w/count)
            # A hovered face can join its lower neighbour; validate each
            # calibrated column independently, including its vertical span.
            # Exclude shared edges: a raised neighbour's white border can
            # otherwise extend this column's span and reject a valid face.
            ys,xs=np.nonzero(mask[y:y+h,x+a+4:x+b-4])
            if not len(ys) or not 65<=int(ys.max()-ys.min()+1)<=135:
                ambiguous=True;continue
            boxes.append([x+150+a,y+635+int(ys.min()),b-a,int(ys.max()-ys.min()+1)])
    matches=[[i for i,t in enumerate(tiles) if x<=t['center'][0]<x+w and y<=t['center'][1]<y+h] for x,y,w,h in boxes]
    verified=bool(boxes) and not ambiguous and len(boxes)==len(tiles) and all(len(m)==1 for m in matches) and len({i for m in matches for i in m})==len(tiles)
    return {'face_count':len(boxes),'face_boxes':boxes,'outline_verified':verified}

def recognize_frame(image,expected_hand=None,hand_right=1150,selection_only=False,retry_river_scales=True,river_tracker=None,river_identity=None):
    if image.shape[:2]!=(800,1368):raise ValueError('Uncalibrated frame dimensions')
    bottom=region(image,(150,635,1320,800))
    def large(t):
        p=np.asarray(t['corners'])
        return min(np.linalg.norm(p-np.roll(p,1,axis=0),axis=1))>=40
    hand={'tiles':[t for t in bottom['tiles'] if large(t)],
          'rejected':[t for t in bottom['rejected'] if large(t)]}
    meld_faces=[t for t in bottom['tiles'] if not large(t)]
    hand['tiles'].sort(key=lambda t:t['center'][0])
    hand.update(hand_outlines(image,hand['tiles'],hand_right))
    hand['complete']=expected_hand is not None and len(hand['tiles'])==expected_hand and not hand['rejected'] and hand['outline_verified']
    if selection_only:
        return {'hand':hand,'meld_faces':sorted(meld_faces,key=lambda t:t['center'][0]),
                'meld_rejected':[t for t in bottom['rejected'] if not large(t)],
                'opponent_meld_faces':{},'public_state_verified':False,
                'scope':'current hand and own melds for an already decided selection; no public event inference'}
    dora=read_dora(image)
    meld_faces.sort(key=lambda t:t['center'][0])
    # Exclude concealed-hand bands even in replays that expose opponents.
    # Left concealed tile edges are narrow white strips (20–25 px), not
    # exposed faces. The wider ROI needed by three melds must exclude them.
    meld_boxes={
        'opposite':(230,40,980,110),'left':(0,330,245,700),
        'right':(1040,35,1230,365)}
    public_meld_faces=dict(zip(meld_boxes,map_regions([(image,b,dict(check_faces=True,
        horizontal_face_pitch=34 if p=='opposite' else None,vertical_face_pitch=24 if p=='right' else None,
        min_face_width=32 if p=='left' else 20,public_meld_position=p)) for p,b in meld_boxes.items()])))
    return {'hand':hand,'meld_faces':meld_faces,'meld_rejected':[t for t in bottom['rejected'] if not large(t)],'opponent_meld_faces':public_meld_faces,'rivers':read_rivers(image,retry_scales=retry_river_scales,tracker=river_tracker,identity=(river_identity,)),'dora':dora,
            'public_state_verified':False,
            'scope':'visible region identities; chronological events and meld grouping remain separate'}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('image');parser.add_argument('--expected-hand',type=int)
    args=parser.parse_args();image=cv2.imread(args.image)
    if image is None:raise ValueError('Cannot read image')
    print(json.dumps(recognize_frame(image,args.expected_hand),ensure_ascii=False))
