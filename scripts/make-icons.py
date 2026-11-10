"""Rasterize our own vector fan mark using only Python's standard library."""
import binascii
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', binascii.crc32(kind + data) & 0xffffffff)

def bezier(a, b, c, d):
    return [tuple((1-t)**3*a[j] + 3*(1-t)**2*t*b[j] + 3*(1-t)*t*t*c[j] + t**3*d[j] for j in range(2)) for t in (i/40 for i in range(41))]

blade = bezier((49,45),(20,39),(27,9),(47,11)) + bezier((47,11),(69,13),(65,33),(54,45))

def raster(size):
    factor = 2
    n = size * factor
    pixels = bytearray(bytes((66,107,80)) * (n*n))
    cream = bytes((239,243,223))
    def polygon(points):
        coords = [(x*n/100,y*n/100) for x,y in points]
        for y in range(n):
            yy = y+.5
            hits = []
            for (x1,y1),(x2,y2) in zip(coords,coords[1:]+coords[:1]):
                if (y1 > yy) != (y2 > yy): hits.append(x1+(yy-y1)*(x2-x1)/(y2-y1))
            hits.sort()
            for left,right in zip(hits[::2],hits[1::2]):
                start,end = max(0,math.ceil(left-.5)),min(n,math.ceil(right-.5))
                pixels[(y*n+start)*3:(y*n+end)*3] = cream*(end-start)
    for angle in [0, 2*math.pi/3, 4*math.pi/3]:
        polygon([(50+(x-50)*math.cos(angle)-(y-50)*math.sin(angle),50+(x-50)*math.sin(angle)+(y-50)*math.cos(angle)) for x,y in blade])
    for y in range(int(n*.4),int(n*.6)):
        for x in range(int(n*.4),int(n*.6)):
            radius = math.hypot((x+.5)*100/n-50,(y+.5)*100/n-50)
            if radius < 8:
                pixels[(y*n+x)*3:(y*n+x)*3+3] = bytes((66,107,80)) if radius < 4 else cream
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            for c in range(3): rows.append(sum(pixels[((y*2+dy)*n+x*2+dx)*3+c] for dx in range(2) for dy in range(2))//4)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,2,0,0,0)) + chunk(b'IDAT',zlib.compress(rows)) + chunk(b'IEND',b'')

(ROOT/'public/apple-touch-icon.png').write_bytes(raster(180))
png = raster(512)
(ROOT/'Fan Control.app/Contents/Resources/FanControl.icns').write_bytes(b'icns'+struct.pack('>I',len(png)+16)+b'ic09'+struct.pack('>I',len(png)+8)+png)
