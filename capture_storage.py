from pathlib import Path
import shutil
import time
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from frame_archive import write_frame

_spec=importlib.util.spec_from_file_location('screenshot_retention',Path(__file__).with_name('screenshot-retention.py'))
_retention=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(_retention)

class CaptureStorage:
    """Reuse bytes only after a new capture is pixel-for-pixel identical."""
    def __init__(self,min_free_bytes=512*1024*1024):
        self.previous=None
        self.archive_previous=None
        self.min_free_bytes=min_free_bytes
        self.cleanup_pool=ThreadPoolExecutor(max_workers=1)
        self.cleanup=None
        self.last_cleanup=0

    def save(self,image,path,retain=False,allow_reuse=True):
        pixels=(image.mode,image.size,image.tobytes())
        if allow_reuse and not retain and self.previous and pixels==self.previous[0] and self.previous[1].is_file():
            return self.previous[1],True
        path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
        if shutil.disk_usage(path.parent).free < self.min_free_bytes:
            raise OSError('Capture storage reserve reached; preserve space for checkpoint and evidence logs')
        if path.suffix=='.mjc':
            self.archive_previous=write_frame(image,path,self.archive_previous)
        else:
            image.save(path,format='BMP')
        self.previous=(pixels,path)
        if not retain and path.suffix=='.mjc' and time.monotonic()-self.last_cleanup>=30 and (self.cleanup is None or self.cleanup.done()):
            self.last_cleanup=time.monotonic()
            self.cleanup=self.cleanup_pool.submit(_retention.prune,path.parent,120,(path,))
        return path,False
