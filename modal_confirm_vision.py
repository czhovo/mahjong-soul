"""Detect the yellow confirmation button in its central screen region."""
import cv2
from frame_layout import calibrate, restore_coordinates

def read_modal_confirm(native):
    try:
        image, scale = calibrate(native)
    except ValueError:
        return None
    # Inspect only the button region, independently of panel or message pixels.
    x_offset,y_offset=450,335
    hsv = cv2.cvtColor(image[y_offset:685,x_offset:920], cv2.COLOR_BGR2HSV)
    gold = cv2.inRange(hsv, (12, 75, 120), (40, 255, 255))
    contours, _ = cv2.findContours(gold, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    buttons = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        x+=x_offset;y+=y_offset
        if not (140 <= w <= 310 and 35 <= h <= 85 and 2.5 <= w/h <= 5.5):
            continue
        if not (610 <= x+w/2 <= 758 and 380 <= y+h/2 <= 640):
            continue
        if cv2.contourArea(c)/(w*h) < .75:
            continue
        center=round(x+w/2)
        buttons.append({'verified':True,'center':[center,round(y+h/2)],'source':'central-confirm-button',
                        'text_region':{'corners':[[center-265,max(100,y-240)],[center+265,y-25]]}})
    if len(buttons)!=1:
        return None
    return restore_coordinates(buttons[0],scale)
