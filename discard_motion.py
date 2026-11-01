"""Visible opponent discard origin from tile positions and hand consolidation.
Never decodes concealed faces. Only tile backs are tracked; no hand/body recognition.
An observed old-hand vacancy means tedashi; otherwise use tsumogiri.
"""
import cv2
import numpy as np
from frame_layout import calibrate
from hand_positions import remember_tiles,locate_tiles

REGIONS={'opposite':(430,31,965,105),'left':(90,85,275,550),'right':(1070,95,1310,630)}

def tile_backs(image,position,base_count=None):
    x0,y0,x1,y1=REGIONS[position];roi=image[y0:y1,x0:x1]
    b,g,r=[roi[:,:,i].astype(np.int16) for i in range(3)]
    mask=((r>140)&(g>75)&(g<210)&(b<100)&(r>g*1.12)).astype(np.uint8)
    mask=cv2.erode(mask,np.ones((7,7),np.uint8))
    n,labels,stats,centers=cv2.connectedComponentsWithStats(mask,8)
    out=[]
    for i in range(1,n):
        x,y,w,h,area=stats[i]
        if area<40 or area>3000 or w<8 or h<12 or w>55 or h>85:continue
        cx,cy=centers[i];cx+=x0;cy+=y0
        # Exclude dora, melds and avatars outside the slanted concealed rows.
        if position=='left' and abs(cx-(272-.265*cy))>22:continue
        if position=='right' and abs(cx-(1065+.335*cy))>25:continue
        if position=='opposite' and not 40<cy<84:continue
        out.append([float(cx),float(cy)])
    if position in ('left','right'):
        # Side backs touch along their perspective edges: connected components
        # alone merge adjacent tiles. Sample their fixed rendered face centers.
        ys=[113,135,156,179,202,227,252,278,305,333,362,392,430] if position=='left' else [211,235,260,286,313,341,370,400,432,464,498,534,576]
        points=[]
        for y in ys:
            x=round(292-.318*y if position=='left' else 1075+.317*y)
            c=image[y-3:y+4,x-3:x+4].astype(float);b,g,r=[c[:,:,i] for i in range(3)]
            if (((r>140)&(g>75)&(g<210)&(b<100)&(r>g*1.12)).mean()>.8):points.append([float(x),float(y)])
        # The two side rows have opposite anchors. Calls shorten the left
        # row at its lower end, and the right row at its upper end. Requiring
        # the left row to reach the original 13th slot loses every later draw.
        suffix=[]
        for y in (ys if position=='left' else reversed(ys)):
            hit=next((c for c in points if c[1]==y),None)
            if hit is None:break
            suffix.append(hit)
        suffix.sort(key=lambda p:p[1])
        # A separated draw can cover multiple nominal sample slots once calls
        # shorten the row. Keep the established concealed row cardinality;
        # find the one new tile by its component, not by counting those slots.
        if base_count in (1,4,7,10,13) and len(suffix)>base_count and len(suffix) not in (1,4,7,10,13):
            suffix=suffix[:base_count] if position=='left' else suffix[-base_count:]
        if suffix:
            extra=[c for c in out if not near(c,suffix) and
                   (suffix[-1][1]+30<c[1]<suffix[-1][1]+75 if position=='left' else suffix[0][1]-65<c[1]<suffix[0][1]-30)]
            out=suffix+extra
        else:out=[]
    return sorted(out,key=lambda c:c[0] if position=='opposite' else c[1])

def near(point,points):return any((point[0]-p[0])**2+(point[1]-p[1])**2<100 for p in points)

def hand_strip(image,points,position):
    """Freeze the original row footprint, including both edge tiles."""
    if not points:return None
    axis=0 if position=='opposite' else 1
    ps=np.asarray(sorted(points,key=lambda p:p[axis]),dtype=float)
    pitch=float(np.median(np.diff(ps[:,axis]))) if len(ps)>1 else (33 if axis==0 else 30)
    start,end=ps[0].copy(),ps[-1].copy()
    direction=(end-start)/(end[axis]-start[axis]) if len(ps)>1 else np.array([1.,0.] if axis==0 else [-.318 if position=='left' else .317,1.])
    start-=direction*pitch*.50;end+=direction*pitch*.50
    centers=start+np.arange(int(end[axis]-start[axis])+1)[:,None]*direction
    perpendicular=np.array([0.,1.] if axis==0 else [1.,0.])
    coords=np.rint(centers[:,None,:]+np.arange(-16,17)[None,:,None]*perpendicular).astype(int)
    coords[:,:,0]=np.clip(coords[:,:,0],0,image.shape[1]-1)
    coords[:,:,1]=np.clip(coords[:,:,1],0,image.shape[0]-1)
    pixels=image[coords[:,:,1],coords[:,:,0]].astype(float)
    b,g,r=[pixels[:,:,i] for i in range(3)]
    occupied=(r>140)&(g>75)&(g<210)&(b<100)&(r>g*1.12)
    return {'coords':coords,'occupied':occupied}

def row_gap(image,strip):
    """A gap is exposed blue table in a previously occupied part of the row.
    Missing orange alone (hand animation, shadow, outline or merged components)
    is not a gap. The external drawn-tile separation is outside this strip.
    """
    if strip is None:return False
    coords=strip['coords'];pixels=image[coords[:,:,1],coords[:,:,0]].astype(float)
    b,g,r=[pixels[:,:,i] for i in range(3)]
    table=(b>r*1.3)&(b>g*1.08)&(g>r*1.05)&(b>35)
    vacant=(strip['occupied']&table).sum(axis=1)>=3
    return bool(np.any(vacant[:-1]&vacant[1:]))

class DiscardMotion:
    def __init__(self):self.players={};self.events=[];self.serial=0;self.last_time=None
    def update(self,image,at):
        image,_=calibrate(image)
        if self.last_time is not None and (at-self.last_time>4000 or at<self.last_time):self.players={}
        gap=0 if self.last_time is None else at-self.last_time
        self.last_time=at
        for position in REGIONS:
            state=self.players.setdefault(position,{'base':None,'seen':0,'draw':None})
            reference=state['draw']['base'] if state['draw'] else state['base']
            points=tile_backs(image,position,len(reference) if reference else None)
            axis=0 if position=='opposite' else 1
            points=sorted(points,key=lambda p:p[axis])
            state=self.players.setdefault(position,{'base':None,'seen':0,'draw':None})
            base=state['base'];draw=state['draw']
            # Attach while a separated drawn tile is already visible. Waiting
            # for a prior 13/10/7/4/1-tile frame lost entire opponent turns.
            if not draw and base is None and len(points) in (2,5,8,11,14):
                axis=0 if position=='opposite' else 1
                extra=points[-1] if position=='left' else points[0]
                row=points[:-1] if position=='left' else points[1:]
                edge=max(p[axis] for p in row) if position=='left' else min(p[axis] for p in row)
                if abs(extra[axis]-edge)>25:
                    state['draw']={'at':at,'base':row,'extra':extra,'modes':set(),'interrupted':False,'strip':hand_strip(image,row,position),'tiles':remember_tiles(image,row,position)}
                    continue
            if draw:
                positions=locate_tiles(image,draw.get('tiles'))
                state['positions']=positions
                # A completed call changes the concealed count. Do not keep
                # matching the obsolete pre-call templates for 60 seconds.
                # Require two matching complete reduced rows, not one animation.
                reduced=(len(points) in (1,4,7,10,13) and
                         abs(len(draw['base'])-len(points)) in (3,6,9,12) and
                         (len(points)>len(draw['base']) or positions['complete']))
                if reduced:
                    previous=state.get('reducedRow')
                    if previous and len(previous)==len(points) and all(near(p,points) for p in previous):
                        state.update(base=points,seen=1,draw=None,
                                     strip=hand_strip(image,points,position),
                                     tiles=remember_tiles(image,points,position))
                        state.pop('reducedRow',None)
                        continue
                    state['reducedRow']=points
                else:state.pop('reducedRow',None)
                # Normal capture cadence can exceed 350 ms. Only a real
                # sampling break invalidates the observed position sequence.
                if gap>700:draw['interrupted']=True
                if at-draw['at']>60000:
                    state.update(base=None,seen=0,draw=None);continue
                original=draw['base'];extra=draw['extra']
                strip=draw.get('strip')
                if not positions['complete']:
                    draw['interrupted']=True
                    # Exclude unlocated/occluded cards, not every other visible
                    # part of the hand. A table gap elsewhere remains evidence.
                    if strip and draw.get('tiles'):
                        occupied=strip['occupied'].copy();coords=strip['coords']
                        for tile in positions['tiles']:
                            if tile['status'] in ('visible','vacated'):continue
                            x,y,w,h=draw['tiles']['tiles'][tile['index']]['box']
                            occupied[(coords[:,:,0]>=x-8)&(coords[:,:,0]<=x+w+8)&(coords[:,:,1]>=y-8)&(coords[:,:,1]<=y+h+8)]=False
                        strip={'coords':coords,'occupied':occupied}
                    else:strip=None
                intact=all(near(p,points) for p in original)
                extra_present=near(extra,points)
                if row_gap(image,strip):
                    draw['modes'].add('tedashi')
                    if 'event' not in draw:
                        self.serial+=1
                        draw['event']={'id':self.serial,'position':position,'mode':'tedashi','drawAt':draw['at'],'at':at,'source':'visible-tile-position-and-consolidation','drawCenter':extra,'handPositions':positions['tiles']}
                        self.events.append(draw['event'])
                # Only vacancies in the original row determine tedashi.
                # The external draw gap, even while shrinking, is not a gap
                # inside the original concealed hand.
                if not intact:draw['interrupted']=True
                settled=positions['complete'] and len(points)==len(original) and intact and not extra_present
                if extra_present:draw.pop('completedAt',None)
                if settled:
                    draw.setdefault('completedAt',at)
                if settled:
                    mode='tedashi' if 'tedashi' in draw['modes'] else 'tsumogiri'
                    if 'event' not in draw:
                        self.serial+=1
                        self.events.append({'id':self.serial,'position':position,'mode':mode,'drawAt':draw['at'],'at':draw['completedAt'],'source':'visible-tile-position-and-consolidation','drawCenter':extra,'handPositions':positions['tiles']})
                    state.update(base=points,seen=1,draw=None,strip=hand_strip(image,points,position),tiles=remember_tiles(image,points,position))
                continue
            if base and state['seen']>=1 and len(points)==len(base)+1 and all(near(p,points) for p in base):
                extra=[p for p in points if not near(p,base)]
                if len(extra)==1:
                    axis=0 if position=='opposite' else 1
                    edge=min(p[axis] for p in base) if position!='left' else max(p[axis] for p in base)
                    offset=extra[0][axis]-edge
                    if (offset<-25 if position!='left' else offset>25):
                        state['draw']={'at':at,'base':base,'extra':extra[0],'modes':set(),'interrupted':False,'strip':state.get('strip') or hand_strip(image,base,position),'tiles':state.get('tiles') or remember_tiles(image,base,position)};continue
            if len(points) in (1,4,7,10,13):
                stable=base and len(base)==len(points) and all(near(p,points) for p in base)
                state.update(base=points,seen=state['seen']+1 if stable else 1,strip=hand_strip(image,points,position),tiles=remember_tiles(image,points,position))
            else:state.update(base=None,seen=0)
        self.events=[e for e in self.events if at-e['at']<10000][-24:]
        return list(self.events)
