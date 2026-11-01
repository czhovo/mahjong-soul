"""Retain name-identified result pages, replacing the old pre-HU capture."""
from pathlib import Path
import json,cv2
from result_page_vision import read_result_page
from frame_layout import calibrate
from screenshot_names import screenshot_time,result_filename
ROOT=Path(__file__).resolve().parent

class ResultPageArchive:
 def __init__(self,root=ROOT):
  self.root=Path(root);self.active=None;self.missing=0;self.last_signature=None;self.last_complete=None
  self.pending_win=None
  self.last_match_seen=None
  self.match_finalized=False
 def begin_match(self):
  self.active=None;self.last_signature=None;self.last_complete=None;self.match_finalized=False;self.missing=0
 def restore_match(self,page,captured_at):
  path=Path(page.get('screenshot',''))
  if page.get('kind')!='match-result' or not path.is_file() or path.parent.resolve()!=(self.root/'saved-match-results').resolve():return
  self.active=('match-result',path)
  self.stamp=path.name.split('_终局_',1)[0]
  self.last_match_seen=captured_at
  self.last_complete=page if page.get('complete') else None
  self.match_finalized=bool(page.get('archiveFinalized'))
  if self.match_finalized:self.final_page=dict(page)
  self.last_signature=json.dumps({k:page.get(k) for k in ('kind','name','rank','han','fu','points','ptChange','complete')},sort_keys=True)
 def finalize_match(self,native,captured_at=None):
  if self.match_finalized:return str(self.active[1])
  image,_=calibrate(native);page=read_result_page(image)
  if not page or page.get('kind')!='match-result':return None
  directory=self.root/'saved-match-results';directory.mkdir(parents=True,exist_ok=True)
  self.stamp=screenshot_time(captured_at)
  path=directory/result_filename(self.stamp,page)
  ok,data=cv2.imencode('.png',native)
  if not ok:raise ValueError('Final match screenshot encoding failed')
  temporary=path.with_suffix('.png.tmp');temporary.write_bytes(data.tobytes());temporary.replace(path)
  self.active=('match-result',path)
  self.match_finalized=True
  self.final_page={**page,'screenshot':str(path),'archiveFinalized':True}
  self.last_complete=page if page.get('complete') else None
  return str(path)
 def observe(self,native,observation,captured_at):
  image,_=calibrate(native);page=read_result_page(image)
  fallback=None
  if self.pending_win and (page and page['kind']!='own-win-settlement' or not page and self.missing>=1):
   frame,previous,stamp=self.pending_win
   directory=self.root/'saved-win-settlements';directory.mkdir(parents=True,exist_ok=True)
   path=directory/result_filename(screenshot_time(stamp),previous)
   ok,data=cv2.imencode('.png',frame)
   if not ok:raise ValueError('Result screenshot encoding failed')
   temporary=path.with_suffix('.png.tmp');temporary.write_bytes(data.tobytes());temporary.replace(path)
   fallback=str(path);self.pending_win=None
  result=self.observe_page(native,page,captured_at)
  if fallback:
   if result is None:return {'kind':'saved-screenshot','screenshot':fallback}
   result={**result,'additional_screenshots':[fallback]}
  return result
 def observe_page(self,native,page,captured_at):
  if not page:
   self.missing+=1
   # A short recognition gap during the final-page animation is not a new
   # match. Preserve the original file/time across that gap.
   match_gap=self.active and self.active[0]=='match-result'
   if self.missing>=2 and not match_gap:self.active=None;self.last_signature=None;self.last_complete=None
   return None
  self.missing=0
  kind=page['kind']
  if kind=='match-result':
   self.last_match_seen=captured_at
   # Observation never saves or substitutes earlier OCR. Only the frame
   # immediately preceding a confirmation click is archived.
   return {**page,'archivePending':True}
  if self.active and self.active[0]=='match-result':return page
  # Wait for complete totals; incomplete observations remain in memory.
  if kind=='own-win-settlement' and not page['complete']:
   if self.active and self.active[0]==kind and self.last_complete:
    return {**self.last_complete,'screenshot':str(self.active[1])}
   self.pending_win=(native.copy(),page,captured_at)
   return page
  if kind=='own-win-settlement':self.pending_win=None
  if self.active is None or self.active[0]!=kind:
   directory=self.root/('saved-win-settlements' if kind=='own-win-settlement' else 'saved-match-results')
   directory.mkdir(parents=True,exist_ok=True)
   self.stamp=screenshot_time(captured_at)
   self.active=(kind,directory/result_filename(self.stamp,page));self.last_signature=None;self.last_complete=None
  path=self.active[1]
  if not page['complete'] and self.last_complete:return {**self.last_complete,'screenshot':str(path)}
  if page['complete']:self.last_complete=page
  # Save only when the recognized result changes.
  signature=json.dumps({k:page.get(k) for k in ('kind','name','rank','han','fu','points','ptChange','complete')},sort_keys=True)
  if signature!=self.last_signature:
   previous=path;path=path.with_name(result_filename(self.stamp,page));self.active=(kind,path)
   ok,data=cv2.imencode('.png',native)
   if not ok:raise ValueError('Result screenshot encoding failed')
   temporary=path.with_suffix('.png.tmp');temporary.write_bytes(data.tobytes());temporary.replace(path)
   if previous!=path and previous.exists():previous.unlink()
   self.last_signature=signature
  return {**page,'screenshot':str(path)}
