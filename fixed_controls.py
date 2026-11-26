"""Classify the colours inside six fixed reaction-button positions."""
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from native_layout import crop_native, scale_of


SLOT_X = (527, 733, 939)
SLOT_Y = (515, 620)
HALF_W, HALF_H = 58, 22
ART = {
    'CHI': 'op_chi', 'PENG': 'op_peng', 'GANG': 'op_gang',
    'RONG': 'op_hu', 'TSUMO': 'op_zimo', 'LIZHI': 'op_lizhi',
    'PASS': 'op_x', 'KYUSHU': 'op_liuju', 'KITA': 'op_babei',
}
ASSETS = Path(__file__).resolve().parent.parent / 'majsoul-interface/static-assets/extracted/controls'


def colour_signature(pixels):
    hsv = cv2.cvtColor(pixels, cv2.COLOR_BGR2HSV)
    h, s, v = hsv.astype(np.int32).transpose(2, 0, 1)
    # Keep the grey levels separate: PASS has grey paint and white lettering.
    neutral = (s < 50) | (v < 40)
    bins = np.where(neutral, v // 32, 8 + ((h + 3) // 6 % 30) * 3 + v // 86)
    counts = np.bincount(bins.ravel(), minlength=98)
    return np.sqrt(counts / bins.size)


@lru_cache(maxsize=2)
def palettes(sanma):
    actions = tuple(a for a in ART if a != ('CHI' if sanma else 'KITA'))
    with np.load(Path(__file__).with_name('button-colours.npz'), allow_pickle=False) as bank:
        return actions, np.stack([bank[action] for action in actions])


def recognize_controls(image, *, sanma=False):
    sx, sy = scale_of(image)
    actions, profiles = palettes(sanma)
    step_y, step_x = max(1, round(2*sy)), max(1, round(2*sx))
    result = {}
    for y in SLOT_Y:
        for x in SLOT_X:
            core = crop_native(image, (x-HALF_W, y-HALF_H, x+HALF_W, y+HALF_H))
            scores = profiles @ colour_signature(core[::step_y, ::step_x])
            runner_up, best = np.argsort(scores)[-2:]
            if scores[best] < .86 or scores[best] - scores[runner_up] < .035:
                continue
            action = actions[best]
            error = 1 - float(scores[best])
            if action not in result or error < result[action]['error']:
                result[action] = {'center': [x, y], 'error': max(0., error)}
    for win in ('RONG', 'TSUMO'):
        if win in result:
            result['HU'] = result[win]
    return result
