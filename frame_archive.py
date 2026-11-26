"""Lossless visible-frame archive: bounded XOR chains with checked RGB hashes."""
from pathlib import Path
from collections import OrderedDict
import hashlib,json,struct
import lz4.frame
import numpy as np

MAGIC=b'MJFRAME1\n'
MAX_DEPTH=2
_CACHE=OrderedDict()

def write_frame(image,path,previous=None):
    if image.mode!='RGB': raise ValueError('Archive requires RGB pixels')
    path=Path(path)
    pixels=image.tobytes()
    header={'size':list(image.size),'sha256':hashlib.sha256(pixels).hexdigest(),'depth':0}
    raw=pixels
    if previous:
        prior,prior_path,prior_size,depth=previous
        if prior_size==image.size and prior_path.parent==path.parent and prior_path.is_file() and depth<MAX_DEPTH:
            raw=np.bitwise_xor(np.frombuffer(pixels,np.uint8),np.frombuffer(prior,np.uint8)).tobytes()
            header.update(base=prior_path.name,depth=depth+1)
    payload=lz4.frame.compress(raw,content_checksum=True)
    meta=json.dumps(header,separators=(',',':')).encode('utf-8')
    temporary=path.with_suffix(path.suffix+'.tmp')
    try:
        with temporary.open('wb') as f:
            f.write(MAGIC);f.write(struct.pack('<I',len(meta)));f.write(meta);f.write(payload)
        temporary.replace(path)
    finally:
        if temporary.exists():temporary.unlink()
    return (pixels,path,image.size,header['depth'])

def _read(path,stack):
    path=Path(path).resolve()
    if path in stack or len(stack)>MAX_DEPTH:raise ValueError('Invalid frame dependency chain')
    stamp=path.stat();key=(str(path),stamp.st_size,stamp.st_mtime_ns)
    if key in _CACHE:
        _CACHE.move_to_end(key);return _CACHE[key]
    data=path.read_bytes()
    if not data.startswith(MAGIC) or len(data)<len(MAGIC)+4:raise ValueError('Invalid frame archive')
    n=struct.unpack('<I',data[len(MAGIC):len(MAGIC)+4])[0]
    if not 0<n<=2048:raise ValueError('Invalid frame header length')
    off=len(MAGIC)+4;header=json.loads(data[off:off+n]);width,height=header['size']
    if type(width)!=int or type(height)!=int or min(width,height)<1 or width*height>16000000:raise ValueError('Invalid frame size')
    depth=header['depth']
    if type(depth)!=int or not 0<=depth<=MAX_DEPTH:raise ValueError('Invalid frame depth')
    packed=data[off+n:]
    if lz4.frame.get_frame_info(packed)['content_size']!=width*height*3:raise ValueError('Invalid decompressed size')
    pixels=lz4.frame.decompress(packed)
    if len(pixels)!=width*height*3:raise ValueError('Invalid pixel count')
    if depth:
        base=header.get('base','')
        if Path(base).name!=base or not base.endswith('.mjc'):raise ValueError('Invalid base filename')
        prior,size,prior_depth=_read(path.parent/base,stack|{path})
        if size!=(width,height) or prior_depth!=depth-1:raise ValueError('Frame dependency mismatch')
        pixels=np.bitwise_xor(np.frombuffer(pixels,np.uint8),np.frombuffer(prior,np.uint8)).tobytes()
    elif 'base' in header:raise ValueError('Key frame cannot have base')
    if hashlib.sha256(pixels).hexdigest()!=header['sha256']:raise ValueError('Frame pixel checksum mismatch')
    value=(pixels,(width,height),depth);_CACHE[key]=value
    while len(_CACHE)>16:_CACHE.popitem(last=False)
    return value

def read_rgb(path):
    pixels,(width,height),_= _read(path,set())
    return np.frombuffer(pixels,np.uint8).reshape(height,width,3).copy()

if __name__=='__main__':
    import argparse
    from PIL import Image
    parser=argparse.ArgumentParser();parser.add_argument('source');parser.add_argument('output')
    args=parser.parse_args();Image.fromarray(read_rgb(args.source)).save(args.output)
