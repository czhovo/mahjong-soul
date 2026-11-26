"""Visible coded faces only. Region completeness is separate from event history.

Uses Mahjong domain invariants (immutable concealed hand prefix, immutable old
river prefix, immutable confirmed melds, monotonic dora/kita slots) with
lightweight white-face structural guards instead of fragile pixel-equality caches.
"""
import argparse,json
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import cv2
import numpy as np
from coded_tiles import decode_fast,decode_consensus,color_check
from native_layout import scale_of,pixel_box,crop_native,pixel_points,layout_points

RIVERS={'self':(525,412,1040,575),'opposite':(550,130,810,250),
        'left':(365,230,557,540),'right':(805,140,1050,425)}

# Fixed capture boxes on the calibrated 1368x800 window. Indexed by seat/row.
RIVER_ROWS={
 'self':((525,412,1040,478),(525,439,1040,524),(525,485,1040,570)),
 'opposite':((550,182,810,250),(550,150,810,221),(550,130,810,189)),
 'left':((479,230,557,540),(426,230,554,540),(373,230,501,540)),
 'right':((805,140,900,425),(832,140,957,425),(889,140,1014,425)),
}

_OPEN_KERNEL_3=np.ones((3,3),np.uint8)
_OPEN_KERNEL_5=np.ones((5,5),np.uint8)
_DILATE_KERNEL_5=np.ones((5,5),np.uint8)
_WHITE_LO=np.array([0,0,150],dtype=np.uint8)
_WHITE_HI=np.array([179,65,255],dtype=np.uint8)
_RACK_LO=np.array([0,0,100],dtype=np.uint8)
_RACK_HI=np.array([179,75,255],dtype=np.uint8)

_region_pool=None

def configure_region_workers(workers=0):
    global _region_pool
    if _region_pool is not None:_region_pool.shutdown(wait=True)
    _region_pool=ThreadPoolExecutor(max_workers=workers) if workers else None

def _region_job(job):
    image,box,options=job
    fn=options.pop("reader",region)
    return fn(image,box,**options)

def map_regions(jobs):
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
    if not tile.get('color',{}).get('verified'):return None
    canonical=np.float32([[5,10],[46,10],[46,51],[5,51]])
    matrix=cv2.getPerspectiveTransform(np.float32(pixel_points(tile['corners'],image)),canonical)
    patch=cv2.warpPerspective(image,matrix,(52,73))
    hsv=cv2.cvtColor(patch,cv2.COLOR_BGR2HSV)
    white=(hsv[:,:,1]<65)&(hsv[:,:,2]>=150)
    blue=(hsv[:,:,0]>=99)&(hsv[:,:,0]<=108)&(hsv[:,:,1]>=75)&(hsv[:,:,1]<=115)&(hsv[:,:,2]>=140)
    white|=blue
    if min(white[14:49,1:3].mean(),white[14:49,49:51].mean())<.60:return None
    inverse=cv2.getPerspectiveTransform(canonical,np.float32(tile['corners']))
    return cv2.perspectiveTransform(np.float32([[[0,0],[51,0],[51,72],[0,72]]]),inverse)[0].tolist()

def split_face_polygons(boxes,source_polygons):
    result=[]
    for x,y,w,h in boxes:
        clip=np.float32([[x,y],[x+w,y],[x+w,y+h],[x,y+h]])
        candidates=[cv2.intersectConvexConvex(np.float32(p),clip) for p in source_polygons]
        area,poly=max(candidates,key=lambda pair:pair[0])
        result.append(poly.reshape(-1,2).tolist() if area>0 else clip.tolist())
    return result

def faces_match_boxes(tiles,boxes,tolerance=0):
    if len(tiles)!=len(boxes):return False
    matches=[[i for i,t in enumerate(tiles)
              if x-tolerance<=t['center'][0]<x+w+tolerance and y-tolerance<=t['center'][1]<y+h+tolerance]
             for x,y,w,h in boxes]
    return all(len(m)==1 for m in matches) and len({i for m in matches for i in m})==len(tiles)

def public_meld_outline_candidate(box,position,tiles):
    x,y,w,h=box
    if any(x<=t['center'][0]<=x+w and y<=t['center'][1]<=y+h for t in tiles):return True
    if position=='right' and w<32:return False
    if position=='opposite' and y<=41 and y+h>=109 and h>=65:return False
    return True

def _white_mask(crop,opening_kernel=3):
    hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
    mask=cv2.inRange(hsv,_WHITE_LO,_WHITE_HI)
    kernel=_OPEN_KERNEL_3 if opening_kernel==3 else (_OPEN_KERNEL_5 if opening_kernel==5 else np.ones((opening_kernel,opening_kernel),np.uint8))
    return cv2.morphologyEx(mask,cv2.MORPH_OPEN,kernel)

def _extract_face_outlines(image,box,mask,accepted,rejected,horizontal_face_pitch=None,vertical_face_pitch=None,min_face_width=20,public_meld_position=None):
    x0,y0,x1,y1=box
    px,py,_,_=pixel_box(image,box)
    sx,sy=scale_of(image)
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    boxes=[];source_polygons=[]
    for contour in contours:
        if cv2.contourArea(contour)<200*sx*sy:continue
        nx,ny,nw,nh=cv2.boundingRect(contour)
        x,y=layout_points([nx+px,ny+py],image)-[x0,y0];w,h=nw/sx,nh/sy
        if not (min_face_width<=w<=(500 if horizontal_face_pitch else 76) and 20<=h<=130):continue
        if not public_meld_outline_candidate([x+x0,y+y0,w,h],public_meld_position,accepted+rejected):continue
        boxes.append([x+x0,y+y0,w,h])
        source_polygons.append(layout_points(cv2.boxPoints(cv2.minAreaRect(contour))+[px,py],image).astype(np.float32))
    keep=[]
    for i,p in enumerate(source_polygons):
        area=cv2.contourArea(p)
        if not any(i!=j and cv2.contourArea(q)>area*1.5 and
                   cv2.intersectConvexConvex(p,q)[0]>=area*.98
                   for j,q in enumerate(source_polygons)):keep.append(i)
    boxes=[boxes[i] for i in keep];source_polygons=[source_polygons[i] for i in keep]
    if horizontal_face_pitch:
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
    if len(boxes)>=4:
        typical=float(np.median([b[3] for b in boxes]))
        typical_width=float(np.median([b[2] for b in boxes]))
        separated=[]
        for x,y,w,h in boxes:
            if h>1.65*typical and w>=.9*typical_width:
                count=max(2,int(h/typical+.3))
                for i in range(count):
                    a=round(i*h/count);b=round((i+1)*h/count)
                    separated.append([x,y+a,w,b-a])
            else:separated.append([x,y,w,h])
        boxes=separated
    polygons=split_face_polygons(boxes,source_polygons) if boxes else []
    return boxes,polygons

def _is_oversized_face_box(box,horizontal_face_pitch=None,vertical_face_pitch=None):
    """Detect white contours too large to be a single river/meld tile (e.g. merged by PENG glow)."""
    _,_,w,h=box
    if horizontal_face_pitch:
        return w>1.75*horizontal_face_pitch or h>64
    if vertical_face_pitch:
        return h>1.9*vertical_face_pitch or w>78
    return w>76 or h>78

def region(image,box,check_faces=False,horizontal_face_pitch=None,vertical_face_pitch=None,opening_kernel=3,min_face_width=20,retry_scales=True,public_meld_position=None,mask_polygons=None,use_consensus=False):
    """Decode coded tiles in `box` using fast single-pass grayscale + targeted crop consensus.

    Optional `mask_polygons` (in calibrated 1368x800 layout coords) blacks out
    immutable confirmed faces strictly inside the cropped ROI, never copying
    the full frame.
    """
    px,py,px1,py1=pixel_box(image,box)
    crop=image[py:py1,px:px1]
    if not crop.size:
        res={'tiles':[],'rejected':[],'complete':False}
        if check_faces:res.update(face_count=0,face_boxes=[],face_polygons=[],complete=True)
        return res
    scan=crop
    if mask_polygons:
        scan=crop.copy()
        for poly in mask_polygons:
            pts=np.round(pixel_points(poly,image)-[px,py]).astype(np.int32)
            cv2.fillConvexPoly(scan,pts,0)
    accepted=[];rejected=[]
    hits=decode_consensus(scan,color_image=image,offset=(px,py)) if use_consensus else decode_fast(scan,color_image=image,offset=(px,py))
    for hit in hits:
        native_corners=np.asarray(hit['corners'],dtype=np.float32)+np.float32([px,py])
        check=hit.get('color') or color_check(image,native_corners,hit['tile'])
        corners=layout_points(native_corners,image)
        item={**hit,'corners':corners.tolist(),'center':corners.mean(axis=0).tolist(),'color':check}
        (accepted if check['verified'] else rejected).append(item)
    result={'tiles':accepted,'rejected':rejected,'complete':False}
    if check_faces:
        mask=_white_mask(scan,opening_kernel)
        boxes,polygons=_extract_face_outlines(
            image,box,mask,accepted,rejected,
            horizontal_face_pitch=horizontal_face_pitch,
            vertical_face_pitch=vertical_face_pitch,
            min_face_width=min_face_width,
            public_meld_position=public_meld_position,
        )
        # Multi-threshold consensus on missed tile crops AND oversized merged contours
        # (e.g., when a PENG/CHI call glow merges two river tiles into one white blob).
        for (x,y,w,h),polygon in zip(boxes,polygons):
            oversized=_is_oversized_face_box((x,y,w,h),horizontal_face_pitch,vertical_face_pitch)
            if not oversized and any(marker_matches_face(t,polygon) for t in accepted):continue
            ax,ay,bx,by=pixel_box(image,(x-4,y-4,x+w+4,y+h+4))
            sample=image[ay:by,ax:bx];candidates=[]
            if not sample.size:continue
            for hit in decode_consensus(sample,color_image=image,offset=(ax,ay)):
                native_corners=np.asarray(hit['corners'],dtype=np.float32)+np.float32([ax,ay])
                corners=layout_points(native_corners,image);center=corners.mean(axis=0)
                if not marker_matches_face({'corners':corners,'center':center},polygon):continue
                if any(np.linalg.norm(np.asarray(t['center'])-center)<6 for t in accepted):continue
                check=hit.get('color') or color_check(image,native_corners,hit['tile'])
                if check['verified']:
                    candidates.append({**hit,'corners':corners.tolist(),'center':center.tolist(),'color':check,'decode_source':'native-face-crop'})
            if oversized:
                for cand in candidates:
                    if not any(np.linalg.norm(np.asarray(t['center'])-cand['center'])<6 for t in accepted):
                        accepted.append(cand)
            elif candidates and len({t['id'] for t in candidates})==1:
                accepted.append(candidates[0])
        for tile in accepted:
            if any(marker_matches_face(tile,p) for p in polygons):continue
            polygon=decoded_face_outline(image,tile)
            if polygon is None:continue
            if any(marker_matches_face(other,polygon) for other in accepted if other is not tile):continue
            polygons.append(polygon)
            boxes.append(list(cv2.boundingRect(np.float32(polygon))))
        result.update(face_count=len(boxes),face_boxes=boxes,face_polygons=polygons,
            complete=not rejected and faces_match_polygons(accepted,polygons))
    return result

def read_rivers(image,retry_scales=True,tracker=None,identity=None,exclude_position=None):
    if tracker is not None:return tracker.read(image,identity,retry_scales,exclude_position=exclude_position)
    positions=[p for p in RIVERS if p!=exclude_position] if exclude_position else None
    return decode_rivers(image,retry_scales,positions=positions)

def finalize_river_entry(image,seat,box,entry,retry_scales=True,mask_polygons=None):
    h_pitch=38 if seat=='opposite' else None
    v_pitch=28 if seat in ('left','right') else None
    has_oversized=any(_is_oversized_face_box(b,h_pitch,v_pitch) for b in entry.get('face_boxes',[]))
    if (not entry['complete'] and seat in ('left','opposite')) or has_oversized:
        alternative=region(image,box,check_faces=True,
            horizontal_face_pitch=h_pitch,
            vertical_face_pitch=v_pitch,
            opening_kernel=5,retry_scales=retry_scales,mask_polygons=mask_polygons)
        preserves_tiles=all(any(t['tile']==q['tile'] and
            np.linalg.norm(np.asarray(t['center'])-q['center'])<6
            for q in alternative['tiles']) for t in entry['tiles'])
        if preserves_tiles and (
            (alternative['complete'] and all(
                any(marker_matches_face(t,p) for t in alternative['tiles'])
                for p in entry.get('face_polygons',[])))
            or len(alternative['tiles'])>len(entry['tiles'])
        ):
            entry=alternative
    kept=[]
    for b,polygon in zip(entry.get('face_boxes',[]),entry.get('face_polygons',[])):
        if any(marker_matches_face(t,polygon) for t in entry['tiles']):
            kept.append((b,polygon));continue
        x,y=np.mean(polygon,axis=0)
        row=(round((y-435)/46) if seat=='self' else round((217-y)/32) if seat=='opposite' else
             round((529-x-.10*(y-247))/53) if seat=='left' else round((x-843-.10*(y-340))/57))
        if 0<=row<=2:kept.append((b,polygon))
    entry['face_boxes']=[b for b,p in kept];entry['face_polygons']=[p for b,p in kept]
    entry['face_count']=len(kept)
    entry['complete']=not entry['rejected'] and faces_match_polygons(entry['tiles'],entry['face_polygons'])
    order_river(entry,seat)
    return entry

def decode_rivers(image,retry_scales=True,positions=None,active_rows=None,mask_polygons_by_seat=None):
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
        opening_kernel=3,retry_scales=retry_scales,
        mask_polygons=(mask_polygons_by_seat or {}).get(seat))) for seat,box in selected.items()])
    for seat,entry in zip(selected,entries):
        result[seat]=finalize_river_entry(image,seat,selected[seat],entry,retry_scales=retry_scales,
            mask_polygons=(mask_polygons_by_seat or {}).get(seat))
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

def rack_silhouettes(image,hand_right):
    sx,sy=scale_of(image)
    hsv=cv2.cvtColor(crop_native(image,(150,635,hand_right,800)),cv2.COLOR_BGR2HSV)
    mask=cv2.inRange(hsv,_RACK_LO,_RACK_HI)
    mask=cv2.morphologyEx(mask,cv2.MORPH_OPEN,_OPEN_KERNEL_3)
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    return mask,(box for box in map(cv2.boundingRect,contours)
                 if box[2]>=40*sx and 65*sy<=box[3]<=170*sy)

def hand_size_marker(t):
    p=np.asarray(t['corners'])
    return min(np.linalg.norm(p-np.roll(p,1,axis=0),axis=1))>=40

def own_tile_visible(image,*,check_codes=False):
    _,boxes=rack_silhouettes(image,1150)
    if next(boxes,None) is not None:return True
    return check_codes and any(hand_size_marker(t) for t in region(image,(150,635,1320,800))['tiles'])

def detect_hand_boxes(image,hand_right=1150):
    """Extract calibrated white concealed-hand face boxes independently of decoding."""
    hand_right=min(1368,int(hand_right))
    sx,sy=scale_of(image)
    px,py,_,_=pixel_box(image,(150,635,hand_right,800))
    mask,regions=rack_silhouettes(image,hand_right)
    boxes=[];ambiguous=False
    for x,y,w,h in regions:
        count=round(w/(67.5*sx))
        if count<1 or abs(w/count-67.5*sx)>3*sx:
            ambiguous=True;continue
        for i in range(count):
            a=round(i*w/count);b=round((i+1)*w/count)
            ys,xs=np.nonzero(mask[y:y+h,x+a+round(4*sx):x+b-round(4*sx)])
            if not len(ys) or not 65*sy<=int(ys.max()-ys.min()+1)<=135*sy:
                ambiguous=True;continue
            origin=layout_points([x+px+a,y+py+int(ys.min())],image)
            boxes.append([*origin.tolist(),(b-a)/sx,int(ys.max()-ys.min()+1)/sy])
    boxes.sort(key=lambda b:b[0])
    return boxes,ambiguous

def hand_outlines(image,tiles,hand_right=1150,precomputed=None):
    if tiles:
        needed=max(max(p[0] for p in t['corners']) for t in tiles)+15
        if needed>hand_right:
            hand_right=needed
            precomputed=None
    boxes,ambiguous=precomputed if precomputed is not None else detect_hand_boxes(image,hand_right)
    matches=[[i for i,t in enumerate(tiles) if x<=t['center'][0]<x+w and y<=t['center'][1]<y+h] for x,y,w,h in boxes]
    verified=bool(boxes) and not ambiguous and len(boxes)==len(tiles) and all(len(m)==1 for m in matches) and len({i for m in matches for i in m})==len(tiles)
    return {'face_count':len(boxes),'face_boxes':boxes,'outline_verified':verified}

_SUIT_SORT_ORDER={'W':0,'B':1,'T':2,'Z':3}

def _is_concealed_hand_sorted(tiles):
    """Canonical Mahjong sort check (W < B < T < Z, red 0 ranked as 5)."""
    prev=None
    for t in tiles:
        code=t['tile'] if isinstance(t,dict) else t
        if not isinstance(code,str) or len(code)!=2 or code[0] not in _SUIT_SORT_ORDER or not code[1].isdigit():
            return False
        n=int(code[1])
        key=(_SUIT_SORT_ORDER[code[0]],5 if n==0 else n)
        if prev is not None and key<prev:
            return False
        prev=key
    return True

def _boxes_align(a,b,tol=6.0):
    if len(a)!=len(b):return False
    for ba,bb in zip(a,b):
        if abs((ba[0]+ba[2]/2)-(bb[0]+bb[2]/2))>tol or abs(ba[2]-bb[2])>tol:
            return False
    return True

def _shift_tile_y(tile,dy):
    if abs(dy)<=1.0:return deepcopy(tile)
    out=deepcopy(tile)
    out['corners']=[[p[0],p[1]+dy] for p in out['corners']]
    out['center']=[out['center'][0],out['center'][1]+dy]
    return out

def _decode_single_hand_box(image,box):
    x,y,w,h=box
    crop_box=(max(0,x-8),max(0,y-14),min(1368,x+w+8),min(800,y+h+8))
    res=region(image,crop_box,check_faces=False,use_consensus=False)
    hits=[t for t in res['tiles'] if hand_size_marker(t) and x-4<=t['center'][0]<=x+w+4 and y-8<=t['center'][1]<=y+h+8]
    if len(hits)!=1:
        res=region(image,crop_box,check_faces=False,use_consensus=True)
        hits=[t for t in res['tiles'] if hand_size_marker(t) and x-4<=t['center'][0]<=x+w+4 and y-8<=t['center'][1]<=y+h+8]
    return hits[0] if len(hits)==1 else None

def _has_new_white_component(image,box,confirmed_polygons,*,min_area=180,min_width=20,opening_kernel=3,position=None,existing_tiles=()):
    """Domain-invariant structural probe: returns True iff unmasked area contains a tile-sized white face."""
    crop=crop_native(image,box)
    if not crop.size:return False
    px,py,_,_=pixel_box(image,box)
    sx,sy=scale_of(image)
    mask=_white_mask(crop,opening_kernel)
    if confirmed_polygons:
        tmp=np.zeros_like(mask)
        for poly in confirmed_polygons:
            pts=np.round(pixel_points(poly,image)-[px,py]).astype(np.int32)
            cv2.fillConvexPoly(tmp,cv2.convexHull(pts),255)
        tmp=cv2.dilate(tmp,_DILATE_KERNEL_5,iterations=1)
        mask[tmp>0]=0
    if not np.any(mask):return False
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    x0,y0,_,_=box
    for contour in contours:
        if cv2.contourArea(contour)<min_area*sx*sy:continue
        nx,ny,nw,nh=cv2.boundingRect(contour)
        w,h=nw/sx,nh/sy
        if not (min_width<=w<=500 and 18<=h<=135):continue
        lx,ly=layout_points([nx+px,ny+py],image)
        if position is not None and not public_meld_outline_candidate([lx,ly,w,h],position,existing_tiles):continue
        return True
    return False

class PublicTileTail:
    """Domain-invariant incremental recognizer for dora, melds, hand, own melds, and sanma kita.

    Stores ONLY confirmed structural tile identities/polygons (zero pixel copies,
    zero byte-equality caches). Every skipped region is guarded by a lightweight
    structural white-face / orange-base probe.
    """
    def __init__(self):self.reset()
    def reset(self):
        self.identity=None
        self.indicators=[]
        self.bands={}
        self.incomplete_bands={}
        self.hand_state=None
        self.own_meld_state=None
        self.kita_states={}
        self.identified=False

    def begin(self,identity):
        if identity is not None and identity!=self.identity:
            self.reset();self.identity=identity
        self.identified=identity is not None

    def dora(self,image):
        # Revealed dora indicators are immutable; check only the next unrevealed slot's white face.
        if self.identity is None:return read_dora(image)
        sx,sy=scale_of(image)
        complete=True;rejected=[]
        indicators=self.indicators if self.identified else list(self.indicators)
        while len(indicators)<5:
            i=len(indicators);x=20+40*i
            slot=(x,60,x+40,123)
            # Face-down dora slot has almost zero white pixels; skip ArUco decode completely!
            crop=crop_native(image,slot)
            if crop.size and indicators:
                hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
                white_px=int(np.count_nonzero((hsv[:,:,1]<=65)&(hsv[:,:,2]>=150)))
                if white_px<120*sx*sy:
                    break
            entry=region(image,slot,check_faces=True)
            if not entry['complete'] or len(entry['tiles'])!=1:
                complete=entry['complete'] and not entry['tiles']
                rejected=entry['rejected'];break
            indicators.append(deepcopy(entry))
        return {'tiles':[deepcopy(e['tiles'][0]) for e in indicators],
                'face_boxes':[deepcopy(b) for e in indicators for b in e['face_boxes']],
                'face_polygons':[deepcopy(p) for e in indicators for p in e['face_polygons']],
                'face_count':len(indicators),'complete':complete and bool(indicators),'rejected':rejected}

    def meld(self,image,box,**opts):
        seat=opts['public_meld_position']
        prev=self.bands.get(seat) if self.identity is not None else None
        if prev is not None:
            prev_entry,prev_groups=prev
            confirmed_polys=prev_entry.get('face_polygons',[])
            min_w=opts.get('min_face_width',20)
            has_new=_has_new_white_component(
                image,box,confirmed_polys,
                min_area=180,min_width=min_w,
                opening_kernel=opts.get('opening_kernel',3),
                position=seat,existing_tiles=prev_entry.get('tiles',()),
            )
            if not has_new:
                return deepcopy(prev_entry)
            # Only decode unmasked/changed regions (new meld or BUGANG stack on existing PENG).
            # Keep confirmed non-overlapping tiles without re-decoding them.
            entry=self._decode_incremental_meld(image,box,prev_entry,prev_groups,**opts)
        else:
            # Structural cooldown for persistent incomplete opponent melds (e.g. concealed kong
            # or occluded tile): avoid re-running multi-threshold decode_consensus on every frame
            # when the white contour boxes in this band have not changed geometry.
            inc=self.incomplete_bands.get(seat) if self.identity is not None else None
            if inc is not None:
                inc_entry,inc_boxes,age=inc
                if age<8:
                    crop=crop_native(image,box)
                    if crop.size:
                        mask=_white_mask(crop,opts.get('opening_kernel',3))
                        cur_boxes,_=_extract_face_outlines(
                            image,box,mask,inc_entry.get('tiles',()),inc_entry.get('rejected',()),
                            horizontal_face_pitch=opts.get('horizontal_face_pitch'),
                            vertical_face_pitch=opts.get('vertical_face_pitch'),
                            min_face_width=opts.get('min_face_width',20),
                            public_meld_position=seat,
                        )
                        cur_sorted=sorted(cur_boxes,key=lambda b:(round(b[0]),round(b[1])))
                        if len(cur_sorted)==len(inc_boxes) and all(
                            abs(a[0]-b[0])<=3.0 and abs(a[1]-b[1])<=3.0 and abs(a[2]-b[2])<=3.0 and abs(a[3]-b[3])<=3.0
                            for a,b in zip(cur_sorted,inc_boxes)
                        ):
                            self.incomplete_bands[seat]=(inc_entry,inc_boxes,age+1)
                            return deepcopy(inc_entry)
            entry=region(image,box,**opts)
        if self.identity is not None and self.identified and entry['complete']:
            self.incomplete_bands.pop(seat,None)
            from meld_vision import read_public_melds,normalized
            grouped=read_public_melds(image,entry,seat)
            remaining=grouped['groups'][:] if grouped['complete'] else []
            for g in (prev[1] if prev is not None else ()):
                def continues(m):
                    if m['fromRelative']!=g['fromRelative']:return False
                    if m['kind']==g['kind']:return sorted(m['tiles'])==sorted(g['tiles']) and m['calledIndex']==g['calledIndex']
                    return g['kind']=='PENG' and m['kind'] in ('GANG','BUGANG') and all(normalized(v)==normalized(g['tiles'][0]) for v in m['tiles'])
                match=next((i for i,m in enumerate(remaining) if continues(m)),None)
                if match is None:return entry
                remaining.pop(match)
            if grouped['complete'] and not any(g.get('estimated') for g in grouped['groups']):
                self.bands[seat]=(deepcopy(entry),deepcopy(grouped['groups']))
        elif self.identity is not None and self.identified and not entry['complete'] and prev is None:
            inc_boxes=sorted(entry.get('face_boxes',[]),key=lambda b:(round(b[0]),round(b[1])))
            self.incomplete_bands[seat]=(deepcopy(entry),inc_boxes,0)
        return entry

    def _decode_incremental_meld(self,image,box,prev_entry,prev_groups,**opts):
        if not prev_groups:
            return region(image,box,**opts)
        # Mask confirmed polygons inside the tiny crop so ArUco decodes ONLY new face(s)
        # (including BUGANG stacked above a PENG or a newly added meld group).
        confirmed_polys=prev_entry.get('face_polygons',[])
        delta=region(image,box,mask_polygons=confirmed_polys,**opts)
        new_tiles=[t for t in delta['tiles'] if not any(marker_matches_face(t,p) for p in confirmed_polys)]
        new_polys=[p for p in delta.get('face_polygons',[]) if not any(
            cv2.intersectConvexConvex(cv2.convexHull(np.float32(p)).reshape(-1,2),
                                      cv2.convexHull(np.float32(cp)).reshape(-1,2))[0]>0.5*max(cv2.contourArea(np.float32(p)),1.0)
            for cp in confirmed_polys)]
        merged_tiles=deepcopy(prev_entry['tiles'])+new_tiles
        merged_polys=deepcopy(confirmed_polys)+new_polys
        merged_boxes=deepcopy(prev_entry.get('face_boxes',[]))+[list(cv2.boundingRect(np.float32(p))) for p in new_polys]
        merged={
            'tiles':merged_tiles,'rejected':delta['rejected'],
            'face_polygons':merged_polys,'face_boxes':merged_boxes,
            'face_count':len(merged_polys),
            'complete':not delta['rejected'] and faces_match_polygons(merged_tiles,merged_polys),
        }
        if merged['complete']:return merged
        # Safe fallback: full decode of this single meld band if masked boundary clipped a touching BUGANG.
        return region(image,box,**opts)

    def read_bottom(self,image,hand_right=1150,*,expected_hand=None,selection_only=False,remaining=None,self_river_len=None,players=4,force_hand_rescan=False,self_kita_count=None):
        """Domain-invariant incremental decode for concealed hand + own melds."""
        boxes,ambiguous=detect_hand_boxes(image,hand_right)
        # 1. Own melds (right side of bottom strip, grows right-to-left)
        meld_left=max(150,int(boxes[-1][0]+boxes[-1][2])+2) if boxes else 150
        meld_box=(min(meld_left,1310),635,1320,800)
        meld_faces=None;meld_rejected=[];own_meld_count=None
        if self.identity is not None and not selection_only and not force_hand_rescan and self.own_meld_state is not None:
            prev_faces,prev_polys,prev_count=self.own_meld_state
            has_new_meld=_has_new_white_component(image,meld_box,prev_polys,min_area=180,min_width=20,opening_kernel=3)
            if not has_new_meld:
                meld_faces=deepcopy(prev_faces)
                own_meld_count=prev_count
        if meld_faces is None:
            mres=region(image,meld_box,check_faces=False)
            meld_faces=[t for t in mres['tiles'] if not hand_size_marker(t)]
            meld_rejected=[t for t in mres['rejected'] if not hand_size_marker(t)]
            meld_faces.sort(key=lambda t:t['center'][0])
            from meld_vision import read_own_melds
            grouped=read_own_melds(meld_faces,meld_rejected,None,image)
            if grouped['complete'] and not any(g.get('estimated') for g in grouped['groups']):
                own_meld_count=len(grouped['groups'])
                if self.identity is not None and self.identified:
                    polys=[t['corners'] for t in meld_faces]
                    # Also cover orange concealed-kong backs so they never re-trigger.
                    for g in grouped['groups']:
                        if g['kind']=='ANGANG':
                            for c in g.get('centers',[]):
                                polys.append([[c[0]-22,c[1]-30],[c[0]+22,c[1]-30],[c[0]+22,c[1]+30],[c[0]-22,c[1]+30]])
                    self.own_meld_state=(deepcopy(meld_faces),polys,own_meld_count)

        # 2. Concealed hand invariance
        hand_tiles=None;hand_rejected=[];hand_mode='forced-rescan' if force_hand_rescan else 'full'
        prev=self.hand_state if (self.identity is not None and not selection_only and not force_hand_rescan and not ambiguous) else None
        if prev is not None and own_meld_count is not None and own_meld_count==prev['meld_count']:
            river_ok=(self_river_len is None or prev['self_river_len'] is None or self_river_len==prev['self_river_len'])
            prev_kita=prev.get('self_kita_count')
            # Sanma kita mutates the concealed hand without changing meld count or river length.
            # Require identical confirmed self_kita_count before reusing cached hand tiles.
            kita_ok=(
                (self_kita_count is None and prev_kita is None)
                or (isinstance(self_kita_count,int) and isinstance(prev_kita,int) and self_kita_count==prev_kita)
            )
            base_len=13-3*own_meld_count
            if river_ok and kita_ok and len(boxes)==len(prev['boxes']) and _boxes_align(boxes,prev['boxes']):
                # Case A1 (waiting -> waiting) or A3 (same 14-tile draw frame)
                rem_ok=True
                if isinstance(remaining,int) and isinstance(prev['remaining'],int):
                    if len(boxes)==base_len+1:rem_ok=(remaining==prev['remaining'])
                    else:rem_ok=(0<=prev['remaining']-remaining<players)
                if rem_ok:
                    hand_tiles=[_shift_tile_y(t,b[1]-pb[1]) for t,b,pb in zip(prev['tiles'],boxes,prev['boxes'])]
                    hand_mode='reused-hand'
            elif river_ok and kita_ok and len(boxes)==base_len+1 and len(prev['boxes'])==base_len and _boxes_align(boxes[:-1],prev['boxes']):
                # Case A2 (waiting 13-3m -> own draw 14-3m): decode ONLY the 1 rightmost detached tile!
                rem_ok=True
                if isinstance(remaining,int) and isinstance(prev['remaining'],int):
                    rem_ok=(0<=prev['remaining']-remaining<players)
                if rem_ok:
                    drawn=_decode_single_hand_box(image,boxes[-1])
                    if drawn is not None:
                        left_tiles=[_shift_tile_y(t,b[1]-pb[1]) for t,b,pb in zip(prev['tiles'],boxes[:-1],prev['boxes'])]
                        hand_tiles=left_tiles+[drawn]
                        hand_mode='draw-tail-only'

        if hand_tiles is None:
            scan_right=min(1320,max(int(hand_right),int(boxes[-1][0]+boxes[-1][2]+15) if boxes else int(hand_right)))
            hres=region(image,(150,635,scan_right,800),check_faces=False)
            hand_tiles=[t for t in hres['tiles'] if hand_size_marker(t)]
            hand_rejected=[t for t in hres['rejected'] if hand_size_marker(t)]
            # Targeted multi-threshold retry ONLY for any white hand box missed by single-pass decode!
            for b in boxes:
                x,y,w,h=b
                if any(x<=t['center'][0]<x+w and y<=t['center'][1]<y+h for t in hand_tiles):continue
                recovered=_decode_single_hand_box(image,b)
                if recovered is not None:
                    hand_tiles.append(recovered)
                    hand_rejected=[r for r in hand_rejected if not (x<=r['center'][0]<x+w and y<=r['center'][1]<y+h)]
            hand_tiles.sort(key=lambda t:t['center'][0])
            # Also collect any small meld faces that overlapped into hand_right if own melds weren't cached.
            if self.own_meld_state is None:
                for t in hres['tiles']:
                    if not hand_size_marker(t) and not any(np.linalg.norm(np.asarray(t['center'])-m['center'])<6 for m in meld_faces):
                        meld_faces.append(t)
                meld_faces.sort(key=lambda t:t['center'][0])

        hand={'tiles':hand_tiles,'rejected':hand_rejected,'recognition_mode':hand_mode}
        hand.update(hand_outlines(image,hand['tiles'],hand_right,precomputed=(boxes,ambiguous)))
        hand['complete']=expected_hand is not None and len(hand['tiles'])==expected_hand and not hand['rejected'] and hand['outline_verified']
        if self.identity is not None and self.identified and hand['outline_verified'] and not hand['rejected'] and own_meld_count is not None:
            base_len=13-3*own_meld_count
            if len(hand['tiles']) in (base_len,base_len+1):
                if _is_concealed_hand_sorted(hand['tiles'][:base_len]) and self_kita_count!='unknown':
                    self.hand_state={
                        'tiles':deepcopy(hand['tiles']),
                        'boxes':deepcopy(hand['face_boxes']),
                        'meld_count':own_meld_count,
                        'remaining':remaining if isinstance(remaining,int) else None,
                        'self_river_len':self_river_len,
                        'self_kita_count':self_kita_count,
                    }
                else:
                    # Never cache a transient pre-sort deal frame or unverified kita state.
                    self.hand_state=None
            elif len(hand['tiles'])<base_len:
                # A transitional mid-extraction hand (e.g. 12 tiles during kita) invalidates prior cache.
                self.hand_state=None
        elif own_meld_count is not None and len(boxes)<13-3*own_meld_count:
            self.hand_state=None
        return hand,meld_faces,meld_rejected

    def kita(self,image,seat,box,reader):
        """Domain-invariant incremental Sanma kita reader (monotonic 0..4 norths)."""
        prev=self.kita_states.get(seat) if self.identity is not None else None
        if prev is not None:
            prev_count,prev_entry,prev_polys=prev
            crop=crop_native(image,box)
            if crop.size:
                px,py,_,_=pixel_box(image,box)
                sx,sy=scale_of(image)
                hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
                white=cv2.inRange(hsv,_WHITE_LO,_WHITE_HI)
                white=cv2.morphologyEx(white,cv2.MORPH_OPEN,_OPEN_KERNEL_3)
                orange=((hsv[:,:,0]>=12)&(hsv[:,:,0]<=35)&(hsv[:,:,1]>140)&(hsv[:,:,2]>120)).astype(np.uint8)
                for poly in prev_polys:
                    pts=np.round(pixel_points(poly,image)-[px,py]).astype(np.int32)
                    hull=cv2.convexHull(pts)
                    tmp=np.zeros_like(white)
                    cv2.fillConvexPoly(tmp,hull,255)
                    tmp=cv2.dilate(tmp,_DILATE_KERNEL_5,iterations=1)
                    white[tmp>0]=0
                    orange[tmp>0]=0
                has_white=any(cv2.contourArea(c)>=150*sx*sy for c in cv2.findContours(white,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0])
                has_orange=False
                if not has_white and prev_count==0:
                    _,_,stats,_=cv2.connectedComponentsWithStats(orange)
                    has_orange=any(s[4]>=20*sx*sy and s[2]>=10*sx for s in stats[1:])
                if not has_white and not has_orange:
                    return deepcopy(prev_entry)
        entry=reader(image,box)
        if self.identity is not None and self.identified and isinstance(entry.get('count'),int):
            if prev is None or entry['count']>=prev[0]:
                polys=[t['corners'] for t in entry.get('tiles',[])]
                self.kita_states[seat]=(entry['count'],deepcopy(entry),polys)
        return entry

def recognize_frame(image,expected_hand=None,hand_right=1150,selection_only=False,retry_river_scales=True,river_tracker=None,river_identity=None,public_tail=None,remaining=None,players=4,force_hand_rescan=False,self_kita_count=None,exclude_position=None):
    scale_of(image)
    if public_tail is not None:
        public_tail.begin(river_identity)
    # Read rivers BEFORE hand when using public_tail so self river length guards hand invariance!
    if selection_only:
        if public_tail is not None:
            hand,meld_faces,meld_rejected=public_tail.read_bottom(image,hand_right,expected_hand=expected_hand,selection_only=True,remaining=remaining,players=players,force_hand_rescan=force_hand_rescan,self_kita_count=self_kita_count)
        else:
            bottom=region(image,(150,635,1320,800))
            hand={'tiles':sorted([t for t in bottom['tiles'] if hand_size_marker(t)],key=lambda t:t['center'][0]),
                  'rejected':[t for t in bottom['rejected'] if hand_size_marker(t)]}
            meld_faces=sorted([t for t in bottom['tiles'] if not hand_size_marker(t)],key=lambda t:t['center'][0])
            meld_rejected=[t for t in bottom['rejected'] if not hand_size_marker(t)]
            hand.update(hand_outlines(image,hand['tiles'],hand_right))
            hand['complete']=expected_hand is not None and len(hand['tiles'])==expected_hand and not hand['rejected'] and hand['outline_verified']
        return {'hand':hand,'meld_faces':meld_faces,'meld_rejected':meld_rejected,
                'opponent_meld_faces':{},'public_state_verified':False,
                'scope':'current hand and own melds for an already decided selection; no public event inference'}

    rivers=read_rivers(image,retry_scales=retry_river_scales,tracker=river_tracker,identity=(river_identity,),exclude_position=exclude_position)
    self_river=rivers.get('self',{})
    self_river_len=len(self_river.get('tiles',[])) if self_river.get('complete') else None

    if public_tail is not None:
        hand,meld_faces,meld_rejected=public_tail.read_bottom(
            image,hand_right,expected_hand=expected_hand,selection_only=False,
            remaining=remaining,self_river_len=self_river_len,players=players,
            force_hand_rescan=force_hand_rescan,self_kita_count=self_kita_count,
        )
    else:
        bottom=region(image,(150,635,1320,800))
        hand={'tiles':sorted([t for t in bottom['tiles'] if hand_size_marker(t)],key=lambda t:t['center'][0]),
              'rejected':[t for t in bottom['rejected'] if hand_size_marker(t)]}
        meld_faces=sorted([t for t in bottom['tiles'] if not hand_size_marker(t)],key=lambda t:t['center'][0])
        meld_rejected=[t for t in bottom['rejected'] if not hand_size_marker(t)]
        hand.update(hand_outlines(image,hand['tiles'],hand_right))
        hand['complete']=expected_hand is not None and len(hand['tiles'])==expected_hand and not hand['rejected'] and hand['outline_verified']

    dora=public_tail.dora(image) if public_tail is not None else read_dora(image)
    meld_boxes={
        p:b for p,b in (
            ('opposite',(230,40,980,110)),('left',(0,330,245,700)),
            ('right',(1040,35,1230,365)),
        ) if p!=exclude_position
    }
    public_meld_faces=dict(zip(meld_boxes,map_regions([(image,b,dict(check_faces=True,
        horizontal_face_pitch=34 if p=='opposite' else None,vertical_face_pitch=24 if p=='right' else None,
        min_face_width=32 if p=='left' else 20,public_meld_position=p,reader=public_tail.meld if public_tail is not None else region)) for p,b in meld_boxes.items()])))
    return {'hand':hand,'meld_faces':meld_faces,'meld_rejected':meld_rejected,'opponent_meld_faces':public_meld_faces,'rivers':rivers,'dora':dora,
            'public_state_verified':False,
            'scope':'visible region identities; chronological events and meld grouping remain separate'}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('image');parser.add_argument('--expected-hand',type=int)
    args=parser.parse_args();image=cv2.imread(args.image)
    if image is None:raise ValueError('Cannot read image')
    print(json.dumps(recognize_frame(image,args.expected_hand),ensure_ascii=False))
