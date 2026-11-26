"""Calibrate proportional client resizing and return targets in original pixels."""
import cv2
import numpy as np

def calibrate(image):
    from native_layout import scale_of
    # Legacy function name: coordinates are calibrated, pixels are untouched.
    return image,scale_of(image)


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
