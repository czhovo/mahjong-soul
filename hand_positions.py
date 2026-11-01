"""Track each visible concealed tile separately; never read concealed faces."""
import cv2
import numpy as np

def remember_tiles(image,centers,position):
    axis=0 if position=='opposite' else 1
    ordered=sorted(centers,key=lambda p:p[axis]);tiles=[]
    for i,(x,y) in enumerate(ordered):
        spans=[abs(ordered[j][axis]-ordered[i][axis]) for j in (i-1,i+1) if 0<=j<len(ordered)]
        pitch=min(spans) if spans else 30
        # Include tile edges, not only a uniform orange center patch.
        w,h=(max(12,int(pitch*.9)),30) if axis==0 else (26,max(12,int(pitch*.85)))
        x0,y0=round(x-w/2),round(y-h/2)
        if x0<0 or y0<0 or x0+w>image.shape[1] or y0+h>image.shape[0]:return None
        patch=image[y0:y0+h,x0:x0+w].astype(float)
        b,g,r=[patch[:,:,j] for j in range(3)]
        if ((r>140)&(g>75)&(g<210)&(b<100)&(r>g*1.12)).mean()<.2:return None
        tiles.append({'index':i,'center':[x,y],'box':[x0,y0,w,h],
                      'template':image[y0:y0+h,x0:x0+w].copy(),'pitch':pitch})
    return {'axis':axis,'tiles':tiles}

def locate_tiles(image,reference):
    if not reference:return {'complete':False,'tiles':[]}
    axis=reference['axis'];out=[]
    for tile in reference['tiles']:
        x,y,w,h=tile['box'];margin=round(tile['pitch']*.48)
        dx,dy=(margin,4) if axis==0 else (8,margin)
        x0,y0=max(0,x-dx),max(0,y-dy)
        search=image[y0:min(image.shape[0],y+h+dy),x0:min(image.shape[1],x+w+dx)]
        if search.shape[0]<h or search.shape[1]<w:return {'complete':False,'tiles':out}
        result=cv2.matchTemplate(search,tile['template'],cv2.TM_SQDIFF_NORMED)
        error,_,point,_=cv2.minMaxLoc(result)
        cx,cy=x0+point[0]+w/2,y0+point[1]+h/2
        patch=image[y:y+h,x:x+w].astype(float)
        b,g,r=[patch[:,:,i] for i in range(3)]
        old=tile['template'].astype(float);ob,og,orr=[old[:,:,i] for i in range(3)]
        old_back=(orr>140)&(og>75)&(og<210)&(ob<100)&(orr>og*1.12)
        table=(b>r*1.3)&(b>g*1.08)&(g>r*1.05)&(b>35)
        exposed=old_back&table
        # A visible table gap can explain a missing original tile; an
        # unrecognized or occluded patch cannot. Record the actual position.
        gap=bool(np.any(exposed.sum(axis=0 if axis==0 else 1)>=3))
        status='visible' if error<=.12 else 'vacated' if gap else 'occluded'
        out.append({'index':tile['index'],'center':[round(cx,2),round(cy,2)],
                    'box':[x0+point[0],y0+point[1],w,h],
                    'score':round(max(0,1-error)*100,2),'status':status})
    visible=[t for t in out if t['status']=='visible']
    for i,tile in enumerate(visible):
        for other in visible[i+1:]:
            if abs(tile['center'][axis]-other['center'][axis])<min(reference['tiles'][tile['index']]['pitch'],reference['tiles'][other['index']]['pitch'])*.45:
                tile['status']=other['status']='ambiguous'
    return {'complete':all(t['status'] in ('visible','vacated') for t in out),'tiles':out}
