"""Calibrate proportional client resizing and return targets in original pixels."""
import cv2
import numpy as np

def calibrate(image):
    h,w=image.shape[:2]
    if h<600 or abs((w-2)/(h-32)-1366/768)>.004:
        raise ValueError('Unsupported client aspect ratio')
    sx,sy=(w-2)/1366,(h-32)/768
    if (h,w)==(800,1368):return image,(sx,sy)
    result=np.zeros((800,1368,3),dtype=np.uint8)
    result[31:799,1:1367]=cv2.resize(image[31:h-1,1:w-1],(1366,768))
    return result,(sx,sy)

def restore_coordinates(result,scale):
    sx,sy=scale
    visited=set()
    def point(p):return [round(1+(p[0]-1)*sx),round(31+(p[1]-31)*sy)]
    def walk(obj):
        # HU aliases RONG/TSUMO: shared containers must be transformed once.
        if isinstance(obj,(dict,list)):
            if id(obj) in visited:return
            visited.add(id(obj))
        if isinstance(obj,dict):
            for key,value in obj.items():
                if key=='center' and isinstance(value,list):obj[key]=point(value)
                elif key in ('corners','centers'):obj[key]=[point(p) for p in value]
                elif key=='face_polygons':obj[key]=[[point(p) for p in polygon] for polygon in value]
                elif key=='face_boxes':obj[key]=[point(b[:2])+[round(b[2]*sx),round(b[3]*sy)] for b in value]
                else:walk(value)
        elif isinstance(obj,list):
            for item in obj:walk(item)
    walk(result)
    return result
