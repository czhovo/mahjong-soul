"""Read visible dialog lines with local OCR; never infer text from button type."""
from pathlib import Path
from hashlib import sha256
from collections import OrderedDict
import sys
import cv2
import numpy as np

_engine=None
_cache=OrderedDict()

def read_modal_text(image,dialog):
    global _engine
    (x0,y0),(x1,y1)=dialog['text_region']['corners']
    crop=image[max(0,y0):y1,max(0,x0):x1]
    key=sha256(crop.tobytes()).hexdigest()
    if key in _cache:return dict(_cache[key])
    try:
        if _engine is None:
            # The machine-wide ONNX DLL cannot initialize on this host. Keep
            # the tested CPU runtime local rather than altering global Python.
            local=str(Path(__file__).parent/'runtime/ocr-packages')
            if local not in sys.path:sys.path.insert(0,local)
            from rapidocr_onnxruntime import RapidOCR
            _engine=RapidOCR(intra_op_num_threads=1,inter_op_num_threads=1)
        hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
        mask=cv2.inRange(hsv,(0,0,145),(179,100,255))
        rows=np.flatnonzero(np.count_nonzero(mask,axis=1)>=3)
        bands=[]
        for row in rows:
            if not bands or row-bands[-1][1]>4:bands.append([int(row),int(row)])
            else:bands[-1][1]=int(row)
        lines=[]
        for top,bottom in bands:
            if bottom-top<7:continue
            columns=np.flatnonzero(np.count_nonzero(mask[top:bottom+1],axis=0))
            if not len(columns):continue
            line=crop[max(0,top-4):bottom+5,max(0,int(columns[0])-4):int(columns[-1])+5]
            results,_=_engine(line,use_det=False,use_cls=False)
            for text,score in results or []:
                lines.append((text,float(score)))
        if lines and all(score>=.85 for _,score in lines):
            result={'text':' '.join(text for text,_ in lines),'text_confidence':min(score for _,score in lines)}
        else:result={'text':None,'text_error':'未能可靠识别提示正文'}
    except Exception as error:
        result={'text':None,'text_error':str(error)}
    # Do not cache failures: a fresh observation must be allowed to retry OCR.
    if result['text']:
        _cache[key]=dict(result)
        while len(_cache)>8:_cache.popitem(last=False)
    return result
