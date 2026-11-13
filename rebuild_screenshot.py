"""Permanent standalone pixels and recognition evidence for a rebuild trigger."""
from pathlib import Path
from screenshot_names import screenshot_time
import re
import cv2

DIRECTORY = Path(__file__).resolve().parent / 'saved-rebuild-screenshots'

def save_rebuild(image, observation, captured_at, evidence, *, directory=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', observation):
        raise ValueError('Invalid observation id')
    directory = DIRECTORY if directory is None else Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (screenshot_time(captured_at) + '_局面重建.png')
    if not destination.exists():
        ok, data = cv2.imencode('.png', image, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        if not ok:
            raise ValueError('PNG encoding failed')
        temporary = destination.with_suffix('.png.tmp')
        temporary.write_bytes(data.tobytes())
        temporary.replace(destination)
    return str(destination)
