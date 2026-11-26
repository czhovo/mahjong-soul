from recognize_coded_frame import region

def read_call_choices(image):
    r=region(image,(400,535,975,635),check_faces=True)
    tiles=sorted(r['tiles'],key=lambda t:t['center'][0])
    invalid={'verified':False,'choices':[]}
    if not r['complete'] or len(tiles) not in (2,4,6):return invalid
    if len(r['face_boxes'])!=len(tiles) or any(not(40<=b[2]<=70 and 65<=b[3]<=100) for b in r['face_boxes']):return invalid
    choices=[]
    for i in range(0,len(tiles),2):
        a,b=tiles[i:i+2]
        if abs(a['center'][1]-b['center'][1])>5 or not 40<=b['center'][0]-a['center'][0]<=65:return invalid
        if i and a['center'][0]-tiles[i-1]['center'][0]<70:return invalid
        choices.append({'consumed':[a['tile'],b['tile']],'target':{'center':[(a['center'][0]+b['center'][0])/2,(a['center'][1]+b['center'][1])/2]}})
    return {'verified':True,'choices':choices}
