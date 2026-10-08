import json,math,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[2]
FONT='/System/Library/Fonts/Supplemental/Arial.ttf'
COLORS={'orange':'#ff923c','blue':'#40dce5','obstacle':'#8c9ca9','portalBlue':'#4de9ff','portalOrange':'#ff9549','bombMagnet':'#ec6ee3','bumper':'#74acff','multi':'#ba83ef','bomb':'#ff535a'}
def draw(level,width=290,height=470,caption=None,paths=None):
 im=Image.new('RGB',(width,height),'#08121e');d=ImageDraw.Draw(im);s=min(width/400,(height-30)/600);ox=(width-400*s)/2;oy=30
 def xy(x,y):return (ox+x*s,oy+y*s)
 for x in range(0,401,50):d.line([xy(x,0),xy(x,600)],fill='#1e2e3b')
 for y in range(0,601,50):d.line([xy(0,y),xy(400,y)],fill='#1e2e3b')
 for p in level['pegs']:
  x,y=p['x'],p['y'];c=COLORS.get(p['type'],'#e2e7ed');rad=8.5*(p.get('bumperScale',1) if p['type']=='bumper' else p.get('radiusScale',1))
  if p['type']=='bombMagnet':
   mr=p.get('magnetRadius',96);d.ellipse((*xy(x-mr,y-mr),*xy(x+mr,y+mr)),outline='#74346e',width=1)
  if p['type'].startswith('portal'):
   w=34*p.get('portalScale',1);a=p.get('angle',0);d.line([xy(x-w/2*math.cos(a),y-w/2*math.sin(a)),xy(x+w/2*math.cos(a),y+w/2*math.sin(a))],fill=c,width=max(3,int(6*s)))
   sign=1 if p.get('portalOneWayFlip') else -1;nx=-math.sin(a)*sign;ny=math.cos(a)*sign;d.line([xy(x,y),xy(x+nx*16,y+ny*16)],fill=c,width=2);continue
  if p.get('shape')=='brick':
   h=p.get('height',10.2);sl=p.get('curveSlices')
   if sl:poly=[xy(q['x']+q.get('nx',0)*h/2,q['y']+q.get('ny',1)*h/2) for q in sl]+[xy(q['x']-q.get('nx',0)*h/2,q['y']-q.get('ny',1)*h/2) for q in reversed(sl)]
   else:
    w=p.get('width',34);a=p.get('angle',0);poly=[xy(x+u*math.cos(a)-v*math.sin(a),y+u*math.sin(a)+v*math.cos(a)) for u,v in [(-w/2,-h/2),(w/2,-h/2),(w/2,h/2),(-w/2,h/2)]]
   d.polygon(poly,fill=c)
  else:d.ellipse((*xy(x-rad,y-rad),*xy(x+rad,y+rad)),fill=c)
 for path in paths or level.get('paths',[]):
  if len(path)>1:d.line([xy(p['x'],p['y']) for p in path],fill='#fff294',width=1)
 d.ellipse((*xy(191.5,31.5),*xy(208.5,48.5)),fill='#ffffff');font=ImageFont.truetype(FONT,max(10,int(width/28)));d.text((6,7),(caption or level.get('id',''))[:57],fill='#d9eaf3',font=font)
 return im
if __name__=='__main__':
 iteration=sys.argv[1] if len(sys.argv)>1 else '01';out=ROOT/'generators/destruction5/study';out.mkdir(exist_ok=True,parents=True)
 if '--native' in sys.argv or '--catalog-native' in sys.argv:
  data=json.loads((ROOT/'data/des5/proof.json' if '--catalog-native' in sys.argv else ROOT/f'data/des5/iterations/{iteration}-native.json').read_text());rows=[r for r in data.get('accepted',data.get('rows',[])) if r.get('proof',{}).get('frames')]
  for start in range(0,len(rows),3):
   sheet=Image.new('RGB',(4*298+8,3*478+8),'#243645')
   for i,row in enumerate(rows[start:start+3]):
    proof=row['proof'];frames=proof['frames'];shown=[frames[0],frames[1],frames[-2],frames[-1]]
    for j,f in enumerate(shown):sheet.paste(draw(f,caption=f"{row['options'].get('seed','meta')} / turn {f['turn']}"),(8+j*298,8+i*478))
   label='catalog' if '--catalog-native' in sys.argv else iteration
   sheet.save(out/f'native-{label}-{start}.png');print(out/f'native-{label}-{start}.png')
  sys.exit()
 if '--catalog' in sys.argv:
  rows=json.loads((ROOT/'data/des5/proof.json').read_text())['accepted'];out=ROOT/'generators/destruction5/report/images';out.mkdir(exist_ok=True,parents=True)
  for start in range(0,len(rows),8):
   sheet=Image.new('RGB',(4*298+8,2*478+8),'#243645')
   for i,row in enumerate(rows[start:start+8]):
    frames=row['proof']['frames'];title=f"{start+i+1}. {row['options'].get('seed','meta')} / {row['proof']['shots']} shots";sheet.paste(draw(frames[0],caption=title),(8+i%4*298,8+i//4*478))
    draw(frames[0],400,640,title).save(out/f'level-{start+i+1:02}.png');route=Image.new('RGB',(4*298+8,478+8),'#243645')
    for j,f in enumerate([frames[0],frames[1],frames[-2],frames[-1]]):route.paste(draw(f,caption=f"{start+i+1}. turn {f['turn']}"),(8+j*298,8))
    route.save(out/f'route-{start+i+1:02}.png')
   sheet.save(out/f'catalog-{start}.png');print(out/f'catalog-{start}.png')
  sys.exit()
 data=json.loads((ROOT/f'data/des5/iterations/{iteration}.json').read_text());rows=data['levels']
 for start in range(0,len(rows),8):
  sheet=Image.new('RGB',(4*298+8,2*478+8),'#243645')
  for i,l in enumerate(rows[start:start+8]):sheet.paste(draw(l),(8+i%4*298,8+i//4*478))
  sheet.save(out/f'iteration-{iteration}-{start}.png');print(out/f'iteration-{iteration}-{start}.png')
