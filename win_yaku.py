"""Read the two columns of four yaku on a player's win settlement."""
from functools import lru_cache
from pathlib import Path
import re
import sys
import threading
import cv2
import numpy as np

# Round badge centres on the 1920x1080 client (+1,+31 captured border).
SLOTS = ((1207,473),(1157,564),(1193,656),(1304,726),
         (1746,401),(1834,475),(1861,564),(1753,666))
DORA = {'宝牌','里宝牌','红宝牌','拔北宝牌'}
REGULAR = {}
for values, names in [
    ((1,), '立直 一发 门前清自摸和 平和 断幺九 一杯口 枪杠 岭上开花 海底摸月 河底捞鱼 白 发 中 场风 自风'),
    ((2,), '两立直 七对子 对对和 三暗刻 三杠子 三色同刻 混老头 小三元'),
    ((1,2), '混全带幺九 一气通贯 三色同顺'),
    ((2,3), '纯全带幺九 混一色'), ((3,), '二杯口'), ((5,6), '清一色')]:
    REGULAR.update(dict.fromkeys(names.split(),values))
LIMIT = {s:1 for s in '天和 地和 大三元 四暗刻 字一色 绿一色 清老头 国士无双 小四喜 四杠子 九莲宝灯'.split()}
LIMIT.update(dict.fromkeys('纯正九莲宝灯 四暗刻单骑 国士无双十三面 大四喜'.split(),2))

def canonical(text):
    text=re.sub(r'[\s:：·・]','',text)
    # OCR occasionally renders the single horizontal stroke as punctuation.
    if re.fullmatch(r'[~～_—–-]+气通贯',text):return '一气通贯'
    if re.fullmatch(r'(役牌)?(门风|自风)牌?[东南西北]?',text):return '自风'
    if re.fullmatch(r'(役牌)?场风牌?[东南西北]?',text):return '场风'
    return re.sub(r'^役牌([白发中])$',r'\1',text)

def format_yaku(rows,han=None,multiple=None):
    """Require a complete accounting of the displayed total before naming."""
    if not rows:return ''
    if multiple:
        if any(name not in LIMIT for name,_ in rows) or sum(LIMIT[n] for n,_ in rows)!=multiple:return ''
        return ''.join(n for n,_ in rows)
    if not han:return ''
    parts=[];bonus=0;total=0
    for name,value in rows:
        if name in DORA and value==0:continue
        if not isinstance(value,int) or value<1:return ''
        if name in DORA:bonus+=value
        elif value in REGULAR.get(name,()):parts.append(('门清自摸' if name=='门前清自摸和' else name)+str(value))
        else:return ''
        total+=value
    if total!=han or not parts:return ''
    return ''.join(parts)+(f'宝牌{bonus}' if bonus else '')

_RECOGNIZER_LOCK = threading.Lock()
_RECOGNIZER = None


def _recognizer():
    global _RECOGNIZER
    if _RECOGNIZER is not None:
        return _RECOGNIZER
    with _RECOGNIZER_LOCK:
        if _RECOGNIZER is None:
            local = str(Path(__file__).parent / 'runtime/ocr-packages')
            if local not in sys.path:
                sys.path.insert(0, local)
            from rapidocr_onnxruntime import RapidOCR
            _RECOGNIZER = RapidOCR(use_det=False, use_cls=False, intra_op_num_threads=1, inter_op_num_threads=1)
        return _RECOGNIZER


def warmup_recognizer():
    try:
        rec = _recognizer()
        rec(np.full((32, 64, 3), 255, dtype=np.uint8), use_det=False, use_cls=False)
    except Exception:
        pass

def _strip(im,x,y,lo,hi):
    # Deskew just the indicated strip, retaining its native pixel density.
    h,w=im.shape[:2];sx=(w-2)/1920;sy=(h-32)/1080
    xs=np.arange(max(0,round(1+(x+lo-1)*sx)),min(w,round(1+(x+hi-1)*sx)))
    yc=31+(y-31)*sy-.13*((xs-1)/sx+1-x)*sy
    ys=np.rint(yc)[None,:].astype(int)+np.arange(-round(29*sy),round(29*sy)+1)[:,None]
    return im[ys,xs]

def _line(mask):
    ys,xs=np.nonzero(mask)
    if len(xs)<12:return None
    cut=mask[ys.min():ys.max()+1,xs.min():xs.max()+1]
    return cv2.copyMakeBorder(255-cut,5,5,6,6,cv2.BORDER_CONSTANT,value=255)

@lru_cache(maxsize=256)
def _ocr(shape,data):
    im=np.frombuffer(data,np.uint8).reshape(shape)
    result,_=_recognizer()(cv2.cvtColor(im,cv2.COLOR_GRAY2BGR),use_det=False,use_cls=False)
    if not result:return ''
    value,score=result[0]
    return canonical(value) if score>=.70 else ''

def _label(im,x,y):
    strip=_strip(im,x,y,-335,-30)
    b,g,r=cv2.split(strip)
    mask=np.uint8((np.minimum(np.minimum(b,g),r)>142)&
                  (np.ptp(strip,axis=2)<43))*255
    # Select the contiguous run of text around the slot's label, excluding
    # parts of a neighbouring badge or character portrait on longer crops.
    cols=np.flatnonzero(mask.any(axis=0))
    if not len(cols):return ''
    scale=(im.shape[1]-2)/1920
    groups=np.split(cols,np.where(np.diff(cols)>30*scale)[0]+1)
    center=strip.shape[1]-125*scale
    group=min(groups,key=lambda a:max(a[0]-center,center-a[-1],0))
    if min(abs(group[0]-center),abs(group[-1]-center))>85*scale and not group[0]<=center<=group[-1]:return ''
    line=_line(mask[:,group[0]:group[-1]+1])
    return _ocr(line.shape,line.tobytes()) if line is not None else ''

def _badge(im,x,y):
    strip=_strip(im,x,y,-39,39)
    hsv=cv2.cvtColor(strip,cv2.COLOR_BGR2HSV)
    gold=cv2.inRange(hsv,(9,114,150),(43,255,255))
    return gold

def _value(mask):
    # Numeric glyphs stand taller than the small 番 to their right.
    _,labels,stats,_=cv2.connectedComponentsWithStats(mask)
    peaks=[(i,x,y,w,h) for i,(x,y,w,h,area) in enumerate(stats[1:],1)
           if h>=mask.shape[0]*.55 and area>=15]
    if not peaks:return None
    from win_value_vision import glyph
    digits=[]
    for i,x,y,w,h in sorted(peaks,key=lambda p:p[1]):
        sample=np.uint8(labels[y:y+h,x:x+w]==i)*255
        res=glyph(sample)
        if not res or res['error']>.25 or res['margin']<.015:return None
        digits.append(res['digit'])
    return int(''.join(digits))

def read_yaku(im,totals):
    han=totals.get('han');multiple=totals.get('yakuman')
    if not han and not multiple:return ''
    rows=[]
    for x,y in SLOTS:
        mask=_badge(im,x,y)
        if not multiple and cv2.countNonZero(mask)<mask.size*.023:continue
        name=_label(im,x,y)
        if multiple:
            if not name:continue
            if name not in LIMIT:return ''
            rows.append((name,None))
        else:
            if name not in REGULAR and name not in DORA:return ''
            value=_value(mask)
            rows.append((name,value))
    return format_yaku(rows,han,multiple)
