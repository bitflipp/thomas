#!/usr/bin/env python3
"""crop.py in.svg x y w h out.png [pixel-width]  -- region in staff spaces"""
import re, subprocess, sys
src, x, y, w, h, out = sys.argv[1], *map(float, sys.argv[2:6]), sys.argv[6]
px = int(sys.argv[7]) if len(sys.argv) > 7 else 1400
s = open(src).read()
s = re.sub(r'viewBox="[^"]*"', f'viewBox="{x} {y} {w} {h}"', s, count=1)
s = re.sub(r'width="[^"]*mm" height="[^"]*mm"', f'width="{px}" height="{int(px*h/w)}"', s, count=1)
tmp = out + '.svg'
open(tmp, 'w').write(s)
subprocess.check_call(['rsvg-convert', tmp, '-o', out])
