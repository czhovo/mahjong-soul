"""Map reference coordinates to native pixels; never resize a captured image."""
import cv2
import numpy as np

def scale_of(image):
    h,w=image.shape[:2]
    if h<600 or abs((w-2)/(h-32)-16/9)>.004:
        raise ValueError('Unsupported proportional game client dimensions')
    return (w-2)/1366,(h-32)/768

def pixel_points(points,image):
    return (np.asarray(points)-[1,31])*scale_of(image)+[1,31]

def layout_points(points,image):
    return (np.asarray(points)-[1,31])/scale_of(image)+[1,31]

def pixel_box(image,box):
    a,b=pixel_points([box[:2],box[2:]],image)
    h,w=image.shape[:2]
    return max(0,round(a[0])),max(0,round(a[1])),min(w,round(b[0])),min(h,round(b[1]))

def crop_native(image,box):
    x,y,x1,y1=pixel_box(image,box)
    return image[y:y1,x:x1]

def reference_pixels(reference,shape):
    # Only stored reference artwork changes size; observed pixels stay native.
    h,w=shape[:2]
    if reference.shape[:2]==(h,w):return reference
    return cv2.resize(reference,(w,h),interpolation=cv2.INTER_LINEAR)

def glyph_features(binary,size):
    # Extract occupancy features directly from the native segmented glyph.
    # No raster image is resized or fed through a reduced-resolution detector.
    width,height=size
    ys=np.linspace(0,binary.shape[0],height+1)
    xs=np.linspace(0,binary.shape[1],width+1)
    # Integrate exact coverage of source pixels in each feature cell.
    def weights(edges,length):
        lo=np.arange(length)[None,:];hi=lo+1
        return np.maximum(0,np.minimum(edges[1:,None],hi)-np.maximum(edges[:-1,None],lo))
    wy=weights(ys,binary.shape[0]);wx=weights(xs,binary.shape[1])
    return (wy@(binary.astype(float)/255)@wx.T)/(np.diff(ys)[:,None]*np.diff(xs)[None,:])
