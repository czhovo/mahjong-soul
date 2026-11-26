"""Retain name-identified result pages, replacing the old pre-HU capture."""
from pathlib import Path
import cv2
from win_yaku import read_yaku
from result_page_vision import read_result_page
from player_nickname import Nickname
from frame_layout import calibrate
from screenshot_names import screenshot_time,result_filename
ROOT=Path(__file__).resolve().parent

class ResultPageArchive:
 def __init__(self,root=ROOT,players=4):
  self.players=players
  self.nickname=Nickname()
  self.root=Path(root);self.active=None;self.missing=0
  self.pending_win=None
  self.last_match_seen=None
  self.match_finalized=False
 def begin_match(self):
  if self.nickname is not None:
   self.nickname.table_checked=False;self.nickname.candidates.clear()
  self.active=None;self.match_finalized=False;self.missing=0
 def restore_match(self,page,captured_at):
  path=Path(page.get('screenshot',''))
  if page.get('kind')!='match-result' or not path.is_file() or path.parent.resolve()!=(self.root/'saved-match-results').resolve():return
  self.active=('match-result',path)
  self.stamp=path.name.split('_终局_',1)[0]
  self.last_match_seen=captured_at
  self.match_finalized=bool(page.get('archiveFinalized'))
  if self.match_finalized:self.final_page=dict(page)
 def finalize_match(self,native,captured_at=None,*,ranking_page=False):
  if self.match_finalized:return str(self.active[1])
  image,_=calibrate(native);page=read_result_page(image,players=self.players,nickname=self.nickname)
  if not page or page.get('kind')!='match-result':
   if not ranking_page:return None
   # The rank screen was positively identified on this very frame. Without
   # the local nickname, no score row can be attributed to this player.
   page={'kind':'match-result','complete':False,'rank':None,'points':None,'ptChange':None}
  directory=self.root/'saved-match-results';directory.mkdir(parents=True,exist_ok=True)
  self.stamp=screenshot_time(captured_at)
  path=directory/result_filename(self.stamp,page)
  ok,data=cv2.imencode('.png',native)
  if not ok:raise ValueError('Final match screenshot encoding failed')
  temporary=path.with_suffix('.png.tmp');temporary.write_bytes(data.tobytes());temporary.replace(path)
  self.active=('match-result',path)
  self.match_finalized=True
  self.final_page={**page,'screenshot':str(path),'archiveFinalized':True}
  return str(path)
 def flush_win(self):
  if self.pending_win is None:return None
  frame,page,stamp=self.pending_win
  if page['complete']:
   image,_=calibrate(frame)
   page={**page,'yakuSuffix':read_yaku(image,page)}
  directory=self.root/'saved-win-settlements';directory.mkdir(parents=True,exist_ok=True)
  path=directory/result_filename(screenshot_time(stamp),page)
  ok,data=cv2.imencode('.png',frame)
  if not ok:raise ValueError('Win screenshot encoding failed')
  temporary=path.with_suffix('.png.tmp');temporary.write_bytes(data.tobytes());temporary.replace(path)
  self.pending_win=None
  return str(path)

 def observe(self,native,observation,captured_at,*,confirm=None):
  image,_=calibrate(native)
  page=read_result_page(image,players=self.players,confirm=confirm,nickname=self.nickname,include_yaku=False)
  return self.observe_page(native,page,captured_at)

 def observe_page(self,native,page,captured_at):
  if not page:
   self.missing+=1
   # One failed name match during an animation is not a page exit.
   saved=self.flush_win() if self.missing>=2 else None
   return {'kind':'saved-screenshot','screenshot':saved} if saved else None
  self.missing=0
  if page['kind']=='match-result':
   self.last_match_seen=captured_at
   result={**page,'archivePending':True}
   saved=self.flush_win()
   if saved:result['additional_screenshots']=[saved]
   return result
  if page['kind']=='own-win-settlement' and not self.match_finalized:
   # Keep the last observed pixels even when the recognized fields are unchanged.
   self.pending_win=(native.copy(),page,captured_at)
  return page
