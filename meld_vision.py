from native_layout import pixel_points
"""Group visible own chi/pung faces. Kongs require their separate four-face evidence."""
import numpy as np
import cv2

def concealed_kongs(image,faces,position):
    """Two equal upright faces bracketed by independently visible orange backs.

    A matching pair alone is never enough. Test the projected marker polygon
    at BOTH neighbouring tile positions, excluding any decoded face there.
    """
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    result=[];used=set()
    axis=1 if position in ('left','right') else 0
    for i,a in enumerate(faces):
        if i in used:continue
        edge=np.asarray(a['corners'][1])-a['corners'][0]
        if abs(edge[axis])<=2*abs(edge[1-axis]):continue
        for j,b in enumerate(faces):
            if j<=i or j in used or normalized(a['tile'])!=normalized(b['tile']):continue
            d=np.asarray(b['center'])-a['center']
            if not 20<=abs(d[axis])<=(70 if position=='self' else 50) or abs(d[1-axis])>max(12,.4*abs(d[axis])):continue
            edge_b=np.asarray(b['corners'][1])-b['corners'][0]
            if abs(edge_b[axis])<=2*abs(edge_b[1-axis]):continue
            backs=[(a,-d),(b,d)];valid=True;centers=[]
            for face,shift in backs:
                center=np.asarray(face['center'])+shift
                if any(np.linalg.norm(np.asarray(t['center'])-center)<15 for t in faces):valid=False;break
                poly=pixel_points(np.float32(face['corners'])+shift,image)
                if np.any(poly<0) or np.any(poly[:,0]>=image.shape[1]) or np.any(poly[:,1]>=image.shape[0]):valid=False;break
                patch=cv2.warpPerspective(hsv,cv2.getPerspectiveTransform(poly.astype(np.float32),np.float32([[0,0],[19,0],[19,19],[0,19]])),(20,20))
                orange=(patch[:,:,0]>=8)&(patch[:,:,0]<=30)&(patch[:,:,1]>130)&(patch[:,:,2]>140)
                if orange.mean()<.85:valid=False;break
                centers.append(center.tolist())
            if valid:
                result.append({'kind':'ANGANG','tiles':[a['tile'],b['tile'],normalized(a['tile']),normalized(a['tile'])],'calledIndex':None,'fromRelative':None,
                    'centers':[centers[0],a['center'],b['center'],centers[1]],'evidence':'two matching faces and two orange backs','face_indices':[i,j]})
                used.update((i,j));break
    return result

def read_public_melds(image,entry,position):
    # Only decoded tile faces participate. An undecoded white outline may be
    # the side of a face-down tile, so it cannot supply an extra tile identity.
    return read_visible_melds(entry.get('tiles',[]),[],None,position)


def decoded_outline_coverage(entry):
    # Tilted/overlapping outlines can merge while every marker is decoded.
    # Never ignore an unmatched outline or a rejected marker.
    tiles=entry.get('tiles',[]);boxes=entry.get('face_boxes',[])
    if entry.get('rejected') or not boxes or len(tiles)<len(boxes):return False
    if not all(t.get('color',{}).get('verified') and t.get('center') for t in tiles):return False
    used=set()
    for x,y,w,h in boxes:
        matches=[i for i,t in enumerate(tiles) if i not in used and x-3<=t['center'][0]<=x+w+3 and y-3<=t['center'][1]<=y+h+3]
        if not matches:return False
        used.add(matches[0])
    return True

def normalized(tile):
    return tile[0]+'5' if tile[1]=='0' else tile

def read_melds(faces,rejected,expected_count,position='self'):
    """Partition all visible faces into a unique sequence of triples/open kongs.

    No concealed faces are invented. Ambiguous grouping/orientation is rejected.
    expected_count=None is for opponents whose meld count is not known yet.
    """
    if position not in ('self','right','opposite','left'):
        raise ValueError('Unknown visible player position')
    fail=lambda reason: {'complete':False,'groups':[],'reason':reason}
    if expected_count is not None and expected_count not in range(5):
        return fail('missing_faces_or_invalid_count')
    if len(faces)>16:return fail('too_many_faces')
    axis=1 if position in ('left','right') else 0
    ordered=sorted(faces,key=lambda t:t['center'][axis],reverse=position in ('opposite','right'))

    def group_value(group):
        tiles=[t['tile'] for t in group]
        norm=[normalized(t) for t in tiles]
        values=sorted(int(t[1]) for t in norm)
        if len(group)==2:
            if len(set(norm))!=1:return None
            for t in group:
                edge=np.asarray(t['corners'][1])-np.asarray(t['corners'][0])
                if axis==1:edge=edge[::-1]
                if abs(edge[0])<=2*abs(edge[1]):return None
            delta=np.asarray(group[1]['center'])-group[0]['center']
            if not 20<=abs(delta[axis])<=70 or abs(delta[1-axis])>max(12,.4*abs(delta[axis])):return None
            return {'kind':'ANGANG','tiles':tiles+[norm[0],norm[0]],'calledIndex':None,
                    'fromRelative':None,'centers':[t['center'] for t in group],
                    'estimated':True,'evidence':'two matching decoded upright faces; concealed kong inferred'}
        if len(set(norm))==1:kind='GANG' if len(group)==4 else 'PENG'
        elif len(group)==3 and len({t[0] for t in norm})==1 and norm[0][0]!='Z' and values==list(range(values[0],values[0]+3)):
            kind='CHI'
        else:return None
        sideways=[]
        for j,t in enumerate(group):
            edge=np.asarray(t['corners'][1])-np.asarray(t['corners'][0])
            if axis==1:edge=edge[::-1]
            if abs(edge[1])>2*abs(edge[0]):sideways.append(j)
            elif abs(edge[0])<=2*abs(edge[1]):return None
        if len(sideways)!=1:return None
        called=sideways[0]
        sources={0:'left',1:'opposite',len(group)-1:'right'}
        if called not in sources or (kind=='CHI' and called!=0):return None
        return {'kind':kind,'tiles':tiles,'calledIndex':called,
                'fromRelative':sources[called],'centers':[t['center'] for t in group]}

    candidates=[]
    def visit(index,groups):
        if index==len(ordered):
            from collections import Counter
            counts=Counter(normalized(t) for g in groups for t in g['tiles'])
            if (expected_count is None or len(groups)==expected_count) and all(n<=4 for n in counts.values()):
                candidates.append(groups)
            return
        if len(groups)>=4:return
        for size in (3,4,2):
            if index+size>len(ordered):continue
            group=group_value(ordered[index:index+size])
            if group is not None:visit(index+size,groups+[group])
    visit(0,[])
    if len(candidates)!=1:return fail('ambiguous_or_incomplete_meld_partition')
    return {'complete':True,'groups':candidates[0],'reason':None}

def read_own_melds(faces,rejected,expected_count,image=None):
    rejected=[]
    if image is not None and not rejected:
        kongs=concealed_kongs(image,faces,'self')
        if kongs:
            used={i for g in kongs for i in g['face_indices']}
            remaining=None if expected_count is None else expected_count-len(kongs)
            result=read_own_melds([t for i,t in enumerate(faces) if i not in used],[],remaining)
            if result['complete']:
                for g in kongs:
                    g.pop('face_indices');result['groups'].append(g)
                return result
    straight=read_melds(faces,rejected,expected_count,'self')
    if rejected or straight['complete']:
        return straight
    # An added kong has two sideways faces stacked at the called-tile column.
    # Keep every face and require both the pair geometry and a valid base pung.
    sideways=[]
    for i,t in enumerate(faces):
        edge=np.asarray(t['corners'][1])-np.asarray(t['corners'][0])
        if abs(edge[1])>2*abs(edge[0]):sideways.append(i)
    pairs=[]
    for i in sideways:
        for j in sideways:
            a,b=faces[i],faces[j]
            sizes=[np.ptp(np.asarray(t['corners']),axis=0) for t in (a,b)]
            width=min(s[0] for s in sizes);height=max(s[1] for s in sizes)
            if normalized(a['tile'])==normalized(b['tile']) and abs(a['center'][0]-b['center'][0])<=.6*width and .8*height<=b['center'][1]-a['center'][1]<=2.2*height:
                pairs.append((i,j))
    if not pairs or len({i for pair in pairs for i in pair})!=2*len(pairs):
        return {'complete':False,'groups':[],'reason':'unresolved_kong_faces'}
    upper={a for a,b in pairs}
    result=read_melds([t for i,t in enumerate(faces) if i not in upper],[],expected_count,'self')
    if not result['complete']:return result
    for a,b in pairs:
        matches=[g for g in result['groups'] if g['kind']=='PENG' and g['centers'][g['calledIndex']]==faces[b]['center']]
        if len(matches)!=1:return {'complete':False,'groups':[],'reason':'stack_has_no_base_pung'}
        g=matches[0];g['kind']='BUGANG';g['tiles'].append(faces[a]['tile']);g['centers'].append(faces[a]['center'])
    return result

def read_visible_melds(faces,rejected,expected_count,position='self'):
    """Apply the same stacked added-kong geometry to all four orientations."""
    if position=='self':return read_own_melds(faces,rejected,expected_count)
    transforms={'right':lambda x,y:(-y,x),'opposite':lambda x,y:(-x,-y),'left':lambda x,y:(y,-x)}
    inverse={'right':lambda x,y:[y,-x],'opposite':lambda x,y:[-x,-y],'left':lambda x,y:[-y,x]}
    transform=transforms[position]
    rotated=[{**t,'center':list(transform(*t['center'])),
              'corners':[list(transform(*c)) for c in t['corners']]} for t in faces]
    result=read_own_melds(rotated,rejected,expected_count)
    for group in result['groups']:
        group['centers']=[inverse[position](*c) for c in group['centers']]
    return result


def near_decoded_face(center,faces):
    return any(np.linalg.norm(np.asarray(center)-face['center'])<=1.5*max(
        np.ptp(np.asarray(face['corners']),axis=0)) for face in faces)


def infer_missing_public_face(entry,position):
    """Infer one missing exposed face only when legal grouping has one answer.

    Rejected marker identity and orientation are not trusted. Keep original
    recognition untouched and label derived groups rather than invent OCR scores.
    """
    faces=entry.get('tiles',[])
    rejected=entry.get('rejected',[])
    if len(rejected)>1 or len(faces)<2:return None
    boxes=entry.get('face_boxes',[])
    if not boxes:return None
    missing=[]
    for x,y,w,h in boxes:
        if not any(x<=t['center'][0]<=x+w and y<=t['center'][1]<=y+h for t in faces):
            missing.append((x,y,w,h))
    if len(missing)!=1:return None
    x,y,w,h=missing[0]
    if rejected:
        t=rejected[0]
        if not(x<=t['center'][0]<=x+w and y<=t['center'][1]<=y+h):return None
        center=t['center'];corners=t['corners']
    else:
        center=[x+w/2,y+h/2];corners=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]]
    # Legal identities cannot attach a remote UI outline to an exposed meld.
    if not near_decoded_face(center,faces):return None
    # A lone outline without two decoded neighbours cannot create a meld.
    identities=[s+str(n) for s in 'WBTZ' for n in range(1,8 if s=='Z' else 10)]
    answers={}
    for tile in identities:
        for rotation in range(4):
            candidate={'tile':tile,'center':center,'corners':corners[rotation:]+corners[:rotation]}
            result=read_visible_melds(faces+[candidate],[],None,position)
            if not result['complete']:continue
            # Guessing an identity is not independent evidence of a fourth
            # tile. A guessed face may complete a chi/pung, never create a kong.
            if any(center in g['centers'] and g['kind'] in ('GANG','BUGANG','ANGANG') for g in result['groups']):continue
            key=str([(g['kind'],g['tiles'],g['calledIndex'],g['fromRelative']) for g in result['groups']])
            answers[key]=(result,tile)
    if len(answers)!=1:return None
    result,tile=next(iter(answers.values()))
    result['estimated']=True
    result['inferences']=[{'tile':tile,'center':center,'source':'unique_legal_meld_completion','redFiveUnknown':tile in ('W5','B5','T5')}]
    for group in result['groups']:
        if center in group['centers']:
            group['estimated']=True
            group['evidence']='one missing face inferred from unique legal exposed meld'
    return result
