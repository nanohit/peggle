import json,math,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
root=Path(__file__).resolve().parents[2]
OUT=root/'generators/quality/images';OUT.mkdir(parents=True,exist_ok=True)
FONT='/System/Library/Fonts/Supplemental/Arial.ttf'
colors={'orange':'#ff923c','blue':'#40dce5','obstacle':'#8c9ca9','portalBlue':'#4de9ff','portalOrange':'#ff9549','bombMagnet':'#ec6ee3','bumper':'#74acff','multi':'#ba83ef','bomb':'#ff535a','gamble':'#e8dd70'}
def draw_level(level,width=360,height=585,caption=None,paths=None):
    im=Image.new('RGB',(width,height),'#08121e');d=ImageDraw.Draw(im)
    s=min(width/400,(height-40)/600);ox=(width-400*s)/2;oy=34
    def xy(x,y):return (ox+x*s,oy+y*s)
    for x in range(0,401,50):d.line([xy(x,0),xy(x,600)],fill='#1e2e3b')
    for y in range(0,601,50):d.line([xy(0,y),xy(400,y)],fill='#1e2e3b')
    r=level.get('radius',8.5)
    for p in level['pegs']:
        x,y=p['x'],p['y'];c=colors.get(p['type'],'#e2e7ed');rad=r*p.get('bumperScale',1)
        if p['type']=='bombMagnet':
            mr=p.get('magnetRadius',96);a=xy(x-mr,y-mr);b=xy(x+mr,y+mr);d.ellipse((*a,*b),outline='#74346e',width=1)
        if p['type'].startswith('portal'):
            size=34*p.get('portalScale',1);d.line([xy(x-size/2,y),xy(x+size/2,y)],fill=c,width=max(2,int(5*s)));continue
        if p.get('shape')=='brick':
            h=p.get('height',10.2);slices=p.get('curveSlices')
            if slices:
                poly=[xy(q['x']+q.get('nx',0)*h/2,q['y']+q.get('ny',1)*h/2) for q in slices]+[xy(q['x']-q.get('nx',0)*h/2,q['y']-q.get('ny',1)*h/2) for q in reversed(slices)]
            else:
                w=p.get('width',34);a=p.get('angle',0);poly=[xy(x+u*math.cos(a)-v*math.sin(a),y+u*math.sin(a)+v*math.cos(a)) for u,v in [(-w/2,-h/2),(w/2,-h/2),(w/2,h/2),(-w/2,h/2)]]
            d.polygon(poly,fill=c)
        else:
            a,b=xy(x-rad,y-rad),xy(x+rad,y+rad);d.ellipse((*a,*b),fill=c)
    paths=paths or level.get('paths')
    if paths:
        for path in paths:
            if len(path)>1:d.line([xy(p['x'],p['y']) for p in path],fill='#f6f3a7',width=1)
    a,b=xy(191.5,31.5),xy(208.5,48.5);d.ellipse((*a,*b),fill='#ffffff')
    title=caption or level.get('id','');font=ImageFont.truetype(FONT,max(9,int(width/28)))
    d.text((5,8),title[:60],fill='#d9eaf3',font=font)
    return im

def sheet(levels,name,cols=3,width=360,height=585):
    rows=math.ceil(len(levels)/cols);im=Image.new('RGB',(cols*(width+8)+8,rows*(height+8)+8),'#243645')
    for i,l in enumerate(levels):im.paste(draw_level(l,width,height),(8+(i%cols)*(width+8),8+(i//cols)*(height+8)))
    p=OUT/(name+'.png');im.save(p);return p
if __name__=='__main__':
    designs=json.loads((root/'data/quality/designs.json').read_text())
    for name,levels in designs.items():
        if name=='blast':
            for i in range(0,len(levels),75):print(sheet(levels[i:i+75],f'blast-{i:03}',15,100,175))
        else:print(sheet(levels,name,3 if len(levels)<13 else 4,360,585))
