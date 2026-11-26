"""Freeze confirmed discards; decode only the mutable last discard and additions.

Zero pixel-equality caching and zero full-frame image copies: uses pre-cached
row projection masks and tight-ROI white-face structural guards.
"""
from copy import deepcopy
from functools import lru_cache
import cv2
import numpy as np
from native_layout import scale_of,crop_native,pixel_box,pixel_points
from recognize_coded_frame import (
    decode_rivers,marker_matches_face,order_river,faces_match_polygons,
    RIVERS,RIVER_ROWS,
)

_OPEN_KERNEL_3=np.ones((3,3),np.uint8)
_DILATE_KERNEL_7=np.ones((7,7),np.uint8)
_WHITE_LO=np.array([0,0,150],dtype=np.uint8)
_WHITE_HI=np.array([179,65,255],dtype=np.uint8)

def face_row(center,position):
 x,y=center
 return round((y-435)/46) if position=='self' else round((217-y)/32) if position=='opposite' else round((529-x-.10*(y-247))/53) if position=='left' else round((x-843-.10*(y-340))/57)

@lru_cache(maxsize=64)
def _row_interior_mask(image_shape,position,row):
 """Pre-cache projected interior mask for (image_shape, position, row); eliminates per-frame np.mgrid."""
 h,w=image_shape[:2]
 sx=(w-2)/1366.0;sy=(h-32)/768.0
 x0,y0,x1,y1=RIVER_ROWS[position][row]
 px=max(0,int(round((x0-1)*sx+1)));py=max(0,int(round((y0-31)*sy+31)))
 px1=min(w,int(round((x1-1)*sx+1)));py1=min(h,int(round((y1-31)*sy+31)))
 ys,xs=np.mgrid[py:py1,px:px1]
 xs=(xs-1.0)/sx+1.0;ys=(ys-31.0)/sy+31.0
 projection=((ys-435)/46 if position=='self' else (217-ys)/32 if position=='opposite'
             else (529-xs-.10*(ys-247))/53 if position=='left'
             else (xs-843-.10*(ys-340))/57)
 return np.abs(projection-row)<.27

def visible_last_row(image,position,minimum):
 sx,sy=scale_of(image)
 thresh=200*sx*sy
 for row in range(2,minimum-1,-1):
  box=RIVER_ROWS[position][row]
  crop=crop_native(image,box)
  if not crop.size:continue
  interior=_row_interior_mask(image.shape,position,row)
  if interior.shape!=crop.shape[:2]:continue
  hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
  white=(hsv[:,:,1]<=65)&(hsv[:,:,2]>=150)&interior
  if np.count_nonzero(white)>=thresh:return row
 return minimum

def closed_row_clip(position,row):
 boundary=row-.5
 if position=='self':return np.float32([[0,0],[1368,0],[1368,435+46*boundary],[0,435+46*boundary]])
 if position=='opposite':return np.float32([[0,217-32*boundary],[1368,217-32*boundary],[1368,800],[0,800]])
 if position=='left':
  edge=lambda y:529-.10*(y-247)-53*boundary
  return np.float32([[edge(0),0],[1368,0],[1368,800],[edge(800),800]])
 edge=lambda y:843+.10*(y-340)+57*boundary
 return np.float32([[0,0],[edge(0),0],[edge(800),800],[0,800]])

def _river_tail_unchanged(image,position,old,start,row,prefix_mask_img,band):
 """Lightweight structural check on active row(s) ONLY (~0.4ms, zero ArUco).

 Verifies:
  1) If river is empty: no tile-sized white component in active row(s).
  2) If river is non-empty:
     - Last tile polygon still has intact white face pixels and matching bbox size/orientation;
     - After masking prefix + last tile polygons, NO tile-sized white component remains in active row(s).
 """
 px,py,px1,py1=pixel_box(image,band)
 crop=image[py:py1,px:px1]
 if not crop.size:return False
 sx,sy=scale_of(image)
 hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
 white=cv2.inRange(hsv,_WHITE_LO,_WHITE_HI)
 white=cv2.morphologyEx(white,cv2.MORPH_OPEN,_OPEN_KERNEL_3)

 if prefix_mask_img is not None and prefix_mask_img.shape==white.shape:
  white[prefix_mask_img>0]=0

 tiles=old.get('tiles',[])
 if not tiles:
  if not np.any(white):return True
  contours,_=cv2.findContours(white,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
  return not any(cv2.contourArea(c)>=180*sx*sy for c in contours)

 # Non-empty river: verify last tile is still present with consistent shape & orientation.
 last_tile=tiles[-1]
 if last_tile.get('sideways') is None:return False
 last_matches=[p for p in old.get('face_polygons',[]) if marker_matches_face(last_tile,p) and sum(marker_matches_face(t,p) for t in tiles)==1]
 last_poly=np.float32(last_matches[0] if len(last_matches)==1 else last_tile['corners'])
 last_pts=np.round(pixel_points(cv2.convexHull(last_poly).reshape(-1,2),image)-[px,py]).astype(np.int32)
 last_mask=np.zeros_like(white)
 cv2.fillConvexPoly(last_mask,last_pts,255)
 last_area=int(np.count_nonzero(last_mask))
 if last_area<50:return False
 present_white=int(np.count_nonzero(white&(last_mask>0)))
 if present_white<0.22*last_area:
  return False

 dil=cv2.dilate(last_mask,_DILATE_KERNEL_7,iterations=1)
 white[dil>0]=0
 if not np.any(white):return True
 contours,_=cv2.findContours(white,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
 for c in contours:
  if cv2.contourArea(c)<160*sx*sy:continue
  nx,ny,nw,nh=cv2.boundingRect(c)
  w,h=nw/sx,nh/sy
  if w>=14 and h>=14:
   return False
 return True

class RiverTail:
 def __init__(self,position):
  self.position=position;self.reset()
 def reset(self):
  self.identity=None;self.previous=None;self.closed_cache=None
  self.tail_vacated=False;self.shrink_streak=0
 def read(self,image,identity,retry_scales=True,now=None):
  valid=identity is not None and identity[0] is not None
  if self.previous is None or (valid and identity!=self.identity):
   result=decode_rivers(image,False,[self.position])
   for entry in result.values():
    entry['recognition_mode']='full';entry['full_check_reason']='initial-river-history'
    entry['defer_unread_to_next_frame']=False
   if valid and all(e['complete'] for e in result.values()):
    self.previous=deepcopy(result);self.identity=identity
   return result
  old=self.previous[self.position]
  last=max((t['row'] for t in old['tiles']),default=0)
  row=visible_last_row(image,self.position,last)
  if row<last and sum(t['row']==last for t in old['tiles'])>1:
   row=last
  start=row
  if row>last and (row>last+1 or sum(t['row']==last for t in old['tiles'])<6):start=last
  probe_next=row==last and last in (0,1) and any(t['row']==last and t['column']==5 for t in old['tiles'])
  if probe_next:
   row=last+1
  prefix=deepcopy([t for i,t in enumerate(old['tiles']) if t['row']<start or i<len(old['tiles'])-1])
  band_boxes=RIVER_ROWS[self.position][start:row+1]
  band=(min(b[0] for b in band_boxes),min(b[1] for b in band_boxes),max(b[2] for b in band_boxes),max(b[3] for b in band_boxes))
  key=(image.shape,self.identity,start,row,probe_next,tuple((t['tile'],tuple(t['center'])) for t in prefix))
  if self.closed_cache is None or self.closed_cache[0]!=key:
   polygons=[];boxes=[];masks=[]
   for tile in prefix:
    matches=[p for p in old.get('face_polygons',[]) if marker_matches_face(tile,p) and sum(marker_matches_face(t,p) for t in old['tiles'])==1]
    poly=np.float32(matches[0] if len(matches)==1 else tile['corners'])
    hull=cv2.convexHull(poly).reshape(-1,2)
    if tile['row']<start or probe_next:
     area,clipped=cv2.intersectConvexConvex(hull,closed_row_clip(self.position,start+1 if probe_next else start))
     mask_poly=clipped.reshape(-1,2) if 0<area<=cv2.contourArea(hull)*1.001 else hull
    else:mask_poly=hull
    masks.append(mask_poly)
    polygons.append(poly.tolist());boxes.append(list(cv2.boundingRect(poly)))
   px,py,px1,py1=pixel_box(image,band)
   prefix_mask_img=np.zeros((max(0,py1-py),max(0,px1-px)),dtype=np.uint8)
   if prefix_mask_img.size:
    if start>0:
     clip_pts=np.round(pixel_points(closed_row_clip(self.position,start),image)-[px,py]).astype(np.int32)
     cv2.fillConvexPoly(prefix_mask_img,clip_pts,255)
    if masks:
     poly_mask=np.zeros_like(prefix_mask_img)
     for poly in masks:
      pts=np.round(pixel_points(poly,image)-[px,py]).astype(np.int32)
      cv2.fillConvexPoly(poly_mask,cv2.convexHull(pts),255)
     poly_mask=cv2.dilate(poly_mask,_DILATE_KERNEL_7,iterations=1)
     prefix_mask_img[poly_mask>0]=255
   self.closed_cache=(key,polygons,boxes,masks,prefix_mask_img)
  _,polygons,boxes,masks,prefix_mask_img=self.closed_cache

  # Structural invariance fast path: if last tile is intact and no new white face appeared, skip ArUco!
  # Never reuse a previously vacated tail slot (e.g. after CHI/PENG/GANG removed the last discard):
  # a new discard landing in the exact same coordinates must be freshly decoded by ArUco.
  if not self.tail_vacated and (row==last or probe_next):
   if _river_tail_unchanged(image,self.position,old,start,row,prefix_mask_img,band):
    return deepcopy(self.previous)

  # Mask immutable prefix polygons strictly inside the small active-row ROI (ZERO full-image copy!).
  mask_list=list(masks)
  if start>0:
   mask_list.append(closed_row_clip(self.position,start))
  result=decode_rivers(
   image,False,[self.position],
   {self.position:(start,row) if start!=row else row},
   mask_polygons_by_seat={self.position:mask_list},
  )
  entry=result[self.position]
  tail=[t for t in entry['tiles'] if start<=t['row']<=row and not any(marker_matches_face(t,p) for p in polygons)]
  faces=[p for p in entry.get('face_polygons',[]) if any(marker_matches_face(t,p) for t in tail) or start<=face_row(np.mean(p,axis=0),self.position)<=row]
  tail_valid=faces_match_polygons(tail,faces)
  entry['tiles']=prefix+tail
  entry['face_polygons']=polygons+faces
  entry['face_boxes']=boxes+[list(cv2.boundingRect(np.float32(p))) for p in faces]
  entry['face_count']=len(entry['face_polygons'])
  entry['recognition_mode']='last-row';entry['active_row']=max((t['row'] for t in tail),default=last) if probe_next else row;entry['active_start_row']=start;entry['reused_prefix_count']=len(prefix);entry['reused_face_count']=len(polygons)
  entry['prefix_geometry_source']='retained-confirmed-discard-outlines'
  entry['defer_unread_to_next_frame']=False
  entry['history_before_active_row_unobserved']=old.get('history_before_active_row_unobserved',False)
  if start<row and not probe_next:entry['old_row_conflict_reason']='new row appeared before previous row was fully confirmed'
  entry['rejected']=[t for t in entry.get('rejected',[]) if start<=face_row(t['center'],self.position)<=row]
  order_river(entry,self.position)
  missing_multiple=len(entry['tiles'])<len(old['tiles'])-1
  entry['prefix_missing']=missing_multiple or not preserves_closed_prefix(old,entry)
  entry['complete']=not entry['prefix_missing'] and not entry['rejected'] and tail_valid and not entry.get('layout_gap')
  if len(entry['tiles'])<len(old['tiles']) or (
   old['tiles'] and len(entry['tiles'])>=len(old['tiles']) and entry['tiles'][len(old['tiles'])-1]['tile']!=old['tiles'][-1]['tile']
  ):
   self.tail_vacated=True
  if valid and identity==self.identity and entry['complete']:
   if len(entry['tiles'])>=len(old['tiles']):
    self.previous=deepcopy(result);self.tail_vacated=False;self.shrink_streak=0
   elif len(entry['tiles'])==len(old['tiles'])-1:
    # A called-away tail tile (CHI/PENG/GANG) legitimately shrinks the river by 1.
    # Confirm on 2 consecutive complete frames before shrinking `self.previous`, while
    # `self.tail_vacated=True` already blocks stale reuse on frame 1.
    self.shrink_streak+=1
    if self.shrink_streak>=2:
     self.previous=deepcopy(result);self.closed_cache=None
     self.tail_vacated=False;self.shrink_streak=0
   else:
    self.shrink_streak=0
  else:
   self.shrink_streak=0
  return result

 def accept_refined(self,entry,image,identity):
  if self.previous is not None and identity==self.identity:
   missing=not preserves_closed_prefix(self.previous[self.position],entry)
   was_missing=entry.get('prefix_missing',False)
   entry['prefix_missing']=missing
   if missing:entry['complete']=False
   elif was_missing:
    entry['complete']=not entry.get('layout_gap') and not entry.get('rejected') and active_faces_match(entry)
  if self.previous is not None and self.identity==identity and len(entry.get('tiles',[]))<len(self.previous[self.position]['tiles']):
   self.tail_vacated=True
   return
  if entry.get('complete') and not entry.get('prefix_missing') and identity is not None and identity[0] is not None:
   self.previous={self.position:deepcopy(entry)};self.identity=identity
   self.tail_vacated=False;self.shrink_streak=0

def active_faces_match(entry):
 n=entry.get('reused_prefix_count',0) if entry.get('recognition_mode')=='last-row' else 0
 f=entry.get('reused_face_count',0) if n else 0
 return faces_match_polygons(entry['tiles'][n:],entry.get('face_polygons',[])[f:])

def preserves_closed_prefix(old,entry):
 for t in old.get('tiles',[])[:-1]:
  if not any(t['tile']==q['tile'] and np.linalg.norm(np.asarray(t['center'])-q['center'])<6 for q in entry.get('tiles',[])):
   return False
 return True

class IncrementalRivers:
 def __init__(self):
  from concurrent.futures import ThreadPoolExecutor
  self.pool=ThreadPoolExecutor(max_workers=2)
  self.states={p:RiverTail(p) for p in ('self','opposite','left','right')}
 def reset(self):
  for state in self.states.values():state.reset()
 def read(self,image,identity,retry_scales=True,now=None,exclude_position=None):
  jobs=[self.pool.submit(s.read,image,identity,retry_scales,now) for p,s in self.states.items() if p!=exclude_position]
  result={}
  try:
   for job in jobs:result.update(job.result())
  finally:
   for job in jobs:
    try:job.result()
    except Exception:pass
  return result

 def accept_refined(self,rivers,image,identity):
  for p,entry in rivers.items():self.states[p].accept_refined(entry,image,identity)
