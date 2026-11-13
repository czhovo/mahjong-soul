"""Prune generated screenshots only; preserve live delta-frame dependencies."""
import json,struct,time
from pathlib import Path

ROOT=Path(__file__).resolve().parent
EXTENSIONS={'.mjc','.png','.bmp','.jpg','.jpeg'}

def prune(directory,seconds=120,pins=()):
    directory=Path(directory).resolve()
    if not directory.is_relative_to(ROOT):raise ValueError('Outside interface workspace')
    if any(directory.is_relative_to(ROOT/name) for name in ('saved-win-screenshots','saved-rebuild-screenshots','saved-debug-screenshots')):
        return {'files':0,'bytes':0}
    if not directory.exists():return {'files':0,'bytes':0}
    cutoff=time.time()-seconds
    files={p:p.stat() for p in directory.iterdir() if p.is_file() and p.suffix.lower() in EXTENSIONS}
    keep={p for p,s in files.items() if s.st_mtime>=cutoff}|{Path(p).resolve() for p in pins if p}
    todo=list(keep)
    while todo:
        p=todo.pop()
        if p.suffix!='.mjc' or not p.exists():continue
        with p.open('rb') as f:
            if f.read(9)!=b'MJFRAME1\n':raise ValueError('Invalid archive header')
            n=struct.unpack('<I',f.read(4))[0]
            if not 0<n<=2048:raise ValueError('Invalid archive metadata')
            base=json.loads(f.read(n)).get('base')
        if base:
            if Path(base).name!=base:raise ValueError('Invalid base path')
            dep=p.parent/base
            if dep not in keep:keep.add(dep);todo.append(dep)
    count=size=0
    for p,s in files.items():
        if p in keep:continue
        try:p.unlink();count+=1;size+=s.st_size
        except FileNotFoundError:pass
    return {'files':count,'bytes':size}

if __name__=='__main__':
    total={'files':0,'bytes':0};results=[]
    dirs=[ROOT/'test-evidence/native-archive',ROOT/'test-evidence/native-capture',ROOT/'observations']
    dirs+=list((ROOT/'test-evidence/resident').glob('*/captures'))
    dirs+=list((ROOT/'test-evidence').glob('continuous-*'))
    for directory in dirs:
        result=prune(directory,seconds=300)
        if result['files']:results.append({'directory':str(directory),**result})
        for k in total:total[k]+=result[k]
    report={'at':time.time(),'retained_recent_seconds':300,'deleted':total,'directories':results}
    (ROOT/'test-evidence/screenshot-cleanup.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))
