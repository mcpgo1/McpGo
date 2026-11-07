"""McpGo infinity/play vector mark and deterministic macOS icon export."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import math, subprocess

ROOT = Path(__file__).resolve().parent
S = 1024
# A closed two-loop infinity ribbon, defined once for both SVG and raster exports.
START = (512, 515)
CUBICS = [
    ((417, 423), (371, 388), (298, 388)),
    ((217, 388), (164, 446), (164, 518)),
    ((164, 592), (218, 651), (298, 651)),
    ((376, 651), (427, 598), (512, 515)),
    ((597, 428), (640, 388), (724, 388)),
    ((802, 388), (860, 445), (860, 519)),
    ((860, 593), (805, 651), (724, 651)),
    ((644, 651), (595, 592), (512, 515)),
]
play_pts = [(703, 465), (787, 519), (703, 573)]
d = 'M %s %s ' % START + ' '.join('C %s %s %s %s %s %s' % (*c1, *c2, *end) for c1, c2, end in CUBICS)
play_path = 'M 703 465 L 787 519 L 703 573 Z'
SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="McpGo — infinity and play">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0C2549"/><stop offset=".52" stop-color="#101936"/><stop offset="1" stop-color="#261247"/></linearGradient>
  <radialGradient id="halo" cx=".23" cy=".07" r=".95"><stop stop-color="#1E66A0" stop-opacity=".56"/><stop offset="1" stop-color="#10152E" stop-opacity="0"/></radialGradient>
  <linearGradient id="ribbon" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#20E8EE"/><stop offset=".47" stop-color="#5EADFF"/><stop offset="1" stop-color="#B65BFF"/></linearGradient>
  <linearGradient id="play" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#DFFFFF"/><stop offset="1" stop-color="#A7ADFF"/></linearGradient>
  <filter id="glow" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="25"/></filter>
</defs>
<rect x="74" y="74" width="876" height="876" rx="216" fill="url(#bg)"/>
<rect x="74" y="74" width="876" height="876" rx="216" fill="url(#halo)"/>
<rect x="75.5" y="75.5" width="873" height="873" rx="214" fill="none" stroke="#9BA9FF" stroke-opacity=".25" stroke-width="3"/>
<path d="{d}" fill="none" stroke="#6D74FF" stroke-opacity=".42" stroke-width="102" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
<path d="{d}" fill="none" stroke="url(#ribbon)" stroke-width="80" stroke-linecap="round" stroke-linejoin="round"/>
<path d="{play_path}" fill="#111936" stroke="#151C47" stroke-width="26" stroke-linejoin="round"/>
<path d="M 719 483 L 770 519 L 719 555 Z" fill="url(#play)" stroke="#D1EFFF" stroke-width="5" stroke-linejoin="round"/>
</svg>
'''
(ROOT/'McpGoMark.svg').write_text(SVG, encoding='utf8')

def sample():
    points=[START]
    p=START
    for p1,p2,p3 in CUBICS:
        for i in range(1,81):
            t=i/80.; u=1-t
            points.append((u**3*p[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t**3*p3[0],
                           u**3*p[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t**3*p3[1]))
        p=p3
    return points

base=Image.new('RGBA',(S,S),(0,0,0,0))
shape=Image.new('L',(S,S),0)
ImageDraw.Draw(shape).rounded_rectangle((74,74,950,950),radius=216,fill=255)
background=Image.new('RGBA',(S,S),(12,23,49,255))
p=background.load()
for y in range(S):
    for x in range(S):
        distance=math.sqrt(((x-290)/840)**2+((y-140)/960)**2)
        light=max(0,1-distance)
        purple=min(1,max(0,((x+y)-730)/1200))
        p[x,y]=(int(11+17*light+20*purple),int(24+37*light-4*purple),int(49+45*light+23*purple),255)
base.paste(background,(0,0),shape)
outline=ImageDraw.Draw(base,'RGBA')
outline.rounded_rectangle((75,75,949,949),radius=215,outline=(155,169,255,61),width=3)
ribbon_mask=Image.new('L',(S,S),0)
line_points=[(round(x),round(y)) for x,y in sample()]
ImageDraw.Draw(ribbon_mask).line(line_points,fill=255,width=80,joint='curve')
for x,y in [START]+[c[2] for c in CUBICS]:
    ImageDraw.Draw(ribbon_mask).ellipse((x-40,y-40,x+40,y+40),fill=255)
glow=ribbon_mask.filter(ImageFilter.GaussianBlur(26)).point(lambda a: int(a*.31))
base.alpha_composite(Image.merge('RGBA',(Image.new('L',(S,S),92),Image.new('L',(S,S),85),Image.new('L',(S,S),255),glow)))
gradient=Image.new('RGBA',(S,S))
g=gradient.load()
stops=[(0,(32,232,238)),(.47,(94,173,255)),(1,(182,91,255))]
for x in range(S):
    t=min(1,max(0,x/S))
    left,right=(stops[0],stops[1]) if t<.47 else (stops[1],stops[2])
    f=(t-left[0])/(right[0]-left[0])
    rgb=tuple(round(a+(b-a)*f) for a,b in zip(left[1],right[1]))
    for y in range(S):g[x,y]=(*rgb,255)
base.paste(gradient,(0,0),ribbon_mask)
draw=ImageDraw.Draw(base)
# Dark inset isolates the play triangle from the bright ribbon at 32/64px sizes.
draw.polygon(play_pts,fill=(17,25,54,255))
draw.line(play_pts+[play_pts[0]],fill=(25,29,72,255),width=18,joint='curve')
draw.polygon([(719,483),(770,519),(719,555)],fill=(223,246,255,255))
preview=ROOT/'McpGoMark.png'
base.save(preview)
out=ROOT/'AppIcon.iconset'
out.mkdir(exist_ok=True)
for pixels,name in [(16,'icon_16x16.png'),(32,'icon_16x16@2x.png'),(32,'icon_32x32.png'),(64,'icon_32x32@2x.png'),(128,'icon_128x128.png'),(256,'icon_128x128@2x.png'),(256,'icon_256x256.png'),(512,'icon_256x256@2x.png'),(512,'icon_512x512.png'),(1024,'icon_512x512@2x.png')]:
    base.resize((pixels,pixels),Image.Resampling.LANCZOS).save(out/name)
subprocess.run(['iconutil','-c','icns',str(out),'-o',str(ROOT/'AppIcon.icns')],check=True)
print('McpGo vector SVG, PNG, iconset and ICNS generated')
