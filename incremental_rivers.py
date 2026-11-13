from native_layout import scale_of,crop_native,pixel_box,pixel_points
"""Freeze confirmed discards; decode only the mutable last discard and additions."""
from copy import deepcopy
import cv2
import numpy as np
from recognize_coded_frame import decode_rivers,marker_matches_face,order_river,faces_match_polygons,RIVERS,RIVER_ROWS

def face_row(center,position):
 x,y=center
 return round((y-435)/46) if position=='self' else round((217-y)/32) if position=='opposite' else round((529-x-.10*(y-247))/53) if position=='left' else round((x-843-.10*(y-340))/57)

# Fixed interior row masks prevent adjacent-row faces from triggering a switch.
# Presence checks inspect white pixels only, never decode old tile identities.
_ROW_INTERIORS={}
for _seat,_boxes in RIVER_ROWS.items():
 for _row,(_x0,_y0,_x1,_y1) in enumerate(_boxes):
  _ys,_xs=np.mgrid[_y0:_y1,_x0:_x1]
  _projection=((_ys-435)/46 if _seat=='self' else (217-_ys)/32 if _seat=='opposite'
               else (529-_xs-.10*(_ys-247))/53 if _seat=='left'
               else (_xs-843-.10*(_ys-340))/57)
  _ROW_INTERIORS[(_seat,_row)]=np.abs(_projection-_row)<.27

def visible_last_row(image,position,minimum):
 # Only test fixed row slots at/after the cached active row. No whole-river
 # contour search, dynamic row positioning, or recognition of older rows.
 for row in range(2,minimum-1,-1):
  x0,y0,x1,y1=RIVER_ROWS[position][row]
  hsv=cv2.cvtColor(crop_native(image,(x0,y0,x1,y1)),cv2.COLOR_BGR2HSV)
  px,py,px1,py1=pixel_box(image,(x0,y0,x1,y1))
  ys,xs=np.mgrid[py:py1,px:px1];sx,sy=scale_of(image)
  xs=(xs-1)/sx+1;ys=(ys-31)/sy+31
  projection=((ys-435)/46 if position=='self' else (217-ys)/32 if position=='opposite' else (529-xs-.10*(ys-247))/53 if position=='left' else (xs-843-.10*(ys-340))/57)
  white=(hsv[:,:,1]<=65)&(hsv[:,:,2]>=150)&(np.abs(projection-row)<.27)
  if np.count_nonzero(white)>=200*sx*sy:return row
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

class RiverTail:
 def __init__(self,position):
  self.position=position;self.reset()
 def reset(self):
  self.identity=None;self.previous=None;self.image=None;self.closed_cache=None
 def read(self,image,identity,retry_scales=True,now=None):
  # Establish history once per verified hand. Missing wind glyphs do not erase
  # a previously established history or request another all-row scan.
  valid=identity is not None and identity[0] is not None
  if self.previous is None or (valid and identity!=self.identity):
   # With no cache, first establish the visible history once. Subsequent
   # frames never decode old rows absent an explicit continuity conflict.
   result=decode_rivers(image,False,[self.position])
   for entry in result.values():
    entry['recognition_mode']='full';entry['full_check_reason']='initial-river-history'
    entry['defer_unread_to_next_frame']=False
   if valid and all(e['complete'] for e in result.values()):
    self.previous=deepcopy(result);self.identity=identity;self.image=image.copy()
   return result
  old=self.previous[self.position]
  last=max((t['row'] for t in old['tiles']),default=0)
  if old.get('recognition_mode')=='last-row' and self.image is not None and image.shape==self.image.shape:
   # All older rows are immutable. Include all later row slots so the first
   # tile of a new row, and the disappearance of a called tile, wake the reader.
   band=RIVER_ROWS[self.position][last:]
   if band:
    box=(min(b[0] for b in band),min(b[1] for b in band),max(b[2] for b in band),max(b[3] for b in band))
    if np.array_equal(crop_native(self.image,box),crop_native(image,box)):return deepcopy(self.previous)
  row=visible_last_row(image,self.position,last)
  if row<last and sum(t['row']==last for t in old['tiles'])>1:
   # A single call can remove one last discard, not an entire occupied row.
   # Keep reading that row until its transient occlusion clears.
   row=last
  # A stale cache may lag more than one row. Close the previous active
  # row before advancing; otherwise its last tile is lost forever.
  start=row
  if row>last and (row>last+1 or sum(t['row']==last for t in old['tiles'])<6):start=last
  # Even within the current row, every discard except the last is immutable.
  # Keep the last visible for called-away/sideways animation confirmation.
  prefix=deepcopy([t for i,t in enumerate(old['tiles']) if t['row']<start or i<len(old['tiles'])-1])
  key=(image.shape,self.identity,start,tuple((t['tile'],tuple(t['center'])) for t in prefix))
  if self.closed_cache is None or self.closed_cache[0]!=key:
   polygons=[];boxes=[];masks=[]
   for tile in prefix:
    matches=[p for p in old.get('face_polygons',[]) if marker_matches_face(tile,p) and sum(marker_matches_face(t,p) for t in old['tiles'])==1]
    poly=np.float32(matches[0] if len(matches)==1 else tile['corners'])
    hull=cv2.convexHull(poly).reshape(-1,2)
    if tile['row']<start:
     area,clipped=cv2.intersectConvexConvex(hull,closed_row_clip(self.position,start))
     mask_poly=clipped.reshape(-1,2) if 0<area<=cv2.contourArea(hull)*1.001 else hull
    else:mask_poly=hull
    masks.append(np.round(mask_poly).astype(np.int32))
    polygons.append(poly.tolist());boxes.append(list(cv2.boundingRect(poly)))
   self.closed_cache=(key,polygons,boxes,masks)
  _,polygons,boxes,masks=self.closed_cache
  masked=image.copy()
  if start>0:cv2.fillConvexPoly(masked,np.round(pixel_points(closed_row_clip(self.position,start),image)).astype(np.int32),0)
  for polygon in masks:cv2.fillConvexPoly(masked,np.round(pixel_points(polygon,image)).astype(np.int32),0)
  result=decode_rivers(masked,False,[self.position],{self.position:(start,row) if start!=row else row})
  entry=result[self.position]
  tail=[t for t in entry['tiles'] if start<=t['row']<=row and not any(marker_matches_face(t,p) for p in polygons)]
  # Ignore decoded fragments outside the active row. Closed rows are immutable
  # records, not candidates for another scan or inferred new discard.
  faces=[p for p in entry.get('face_polygons',[]) if any(marker_matches_face(t,p) for t in tail) or start<=face_row(np.mean(p,axis=0),self.position)<=row]
  tail_valid=faces_match_polygons(tail,faces)
  entry['tiles']=prefix+tail
  entry['face_polygons']=polygons+faces
  entry['face_boxes']=boxes+[list(cv2.boundingRect(np.float32(p))) for p in faces]
  entry['face_count']=len(entry['face_polygons'])
  entry['recognition_mode']='last-row';entry['active_row']=row;entry['active_start_row']=start;entry['reused_prefix_count']=len(prefix);entry['reused_face_count']=len(polygons)
  entry['prefix_geometry_source']='retained-confirmed-discard-outlines'
  entry['defer_unread_to_next_frame']=False
  entry['history_before_active_row_unobserved']=old.get('history_before_active_row_unobserved',False)
  if start<row:entry['old_row_conflict_reason']='new row appeared before previous row was fully confirmed'
  entry['rejected']=[t for t in entry.get('rejected',[]) if start<=face_row(t['center'],self.position)<=row]
  # Recompute physical columns with cached outlines restored. The decoder
  # intentionally saw a masked prefix and its temporary gap is not an error.
  order_river(entry,self.position)
  missing_multiple=len(entry['tiles'])<len(old['tiles'])-1
  # Only the last discard can disappear through a call. A transient crop or
  # marker miss must not delete earlier identities from the cached history.
  entry['prefix_missing']=missing_multiple or not preserves_closed_prefix(old,entry)
  entry['complete']=not entry['prefix_missing'] and not entry['rejected'] and tail_valid and not entry.get('layout_gap')
  # Complete outlines do not establish which hand this observation belongs
  # to. An unidentified overlay can contain unrelated coded tiles; expose
  # its tentative read without teaching it to the confirmed river cache.
  if valid and identity==self.identity and entry['complete'] and len(entry['tiles'])>=len(old['tiles']):
   self.previous=deepcopy(result);self.image=image.copy()
  return result

 def accept_refined(self,entry,image,identity):
  if self.previous is not None and identity==self.identity:
   missing=not preserves_closed_prefix(self.previous[self.position],entry)
   was_missing=entry.get('prefix_missing',False)
   entry['prefix_missing']=missing
   if missing:entry['complete']=False
   elif was_missing:
    # A native-resolution retry may have filled the missing marker. Recheck
    # actual evidence rather than leaving the pre-retry failure sticky.
    entry['complete']=not entry.get('layout_gap') and not entry.get('rejected') and active_faces_match(entry)
  # A shorter observation goes to the controller for matching against an
  # actual new call. It cannot on its own roll back the decoder baseline.
  if self.previous is not None and self.identity==identity and len(entry.get('tiles',[]))<len(self.previous[self.position]['tiles']):return
  if entry.get('complete') and not entry.get('prefix_missing') and identity is not None and identity[0] is not None:
   self.previous={self.position:deepcopy(entry)};self.identity=identity;self.image=image.copy()

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
 def read(self,image,identity,retry_scales=True,now=None):
  jobs=[self.pool.submit(s.read,image,identity,retry_scales,now) for s in self.states.values()]
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
