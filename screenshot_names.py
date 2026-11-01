"""Windows-safe screenshot filenames with explicit China local time."""
from datetime import datetime,timezone,timedelta
import re

def screenshot_time(captured_at):
 t=datetime.fromtimestamp(captured_at/1000,timezone(timedelta(hours=8))) if isinstance(captured_at,(int,float)) else datetime.now(timezone(timedelta(hours=8)))
 return t.strftime('%Y-%m-%d_%H-%M-%S-')+f'{t.microsecond//1000:03d}'

def safe_name(text):return re.sub(r'[<>:"/\\|?*\x00-\x1f]','_',str(text))[:120]

def result_filename(stamp,page):
 if page['kind']=='own-win-settlement':
  fields=[str(page.get(k)) if page.get(k) is not None else '未识别' for k in ('han','fu','points')]
  return f"{stamp}_{fields[0]}番{fields[1]}符{fields[2]}点.png"
 rank=page.get('rank');points=page.get('points');pt=page.get('ptChange')
 return f"{stamp}_终局_第{rank if rank is not None else '未识别'}名_{points if points is not None else '未识别'}点_PT{format(pt,'+d') if isinstance(pt,int) else '未识别'}.png"
