import json,importlib.util
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('des5_render',ROOT/'generators/destruction5/render.py')
renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)
sequence=json.loads((ROOT/'data/des6/sequence.json').read_text())['rows']
proof=json.loads((ROOT/'data/des6/bank-proof.json').read_text())
rows={r['id']:r for r in proof['accepted']}
out=ROOT/'generators/destruction6/report/images';out.mkdir(parents=True,exist_ok=True)
study=ROOT/'generators/destruction6/study';study.mkdir(parents=True,exist_ok=True)
for start in range(0,len(sequence),8):
 sheet=Image.new('RGB',(4*298+8,2*478+8),'#243645')
 for i,e in enumerate(sequence[start:start+8]):
  number=start+i+1;frames=rows[e['id']]['proof']['frames'];title=f"{number}. {e['source']} / {e['action']} / {e['shots']} shots"
  sheet.paste(renderer.draw(frames[0],caption=title),(8+i%4*298,8+i//4*478))
  renderer.draw(frames[0],400,640,title).save(out/f'level-{number:02}.webp',quality=90)
  route=Image.new('RGB',(4*298+8,478+8),'#243645')
  for j,f in enumerate([frames[0],frames[1],frames[-2],frames[-1]]):route.paste(renderer.draw(f,caption=f"{number}. turn {f['turn']}"),(8+j*298,8))
  route.save(out/f'route-{number:02}.webp',quality=88)
 sheet.save(out/f'catalog-{start}.webp',quality=90);print(out/f'catalog-{start}.webp')
 # Grouping four level routes is for direct machine-frame review, without UI.
for start in range(0,len(sequence),4):
 sheet=Image.new('RGB',(4*298+8,4*478+8),'#243645')
 for i,e in enumerate(sequence[start:start+4]):
  frames=rows[e['id']]['proof']['frames']
  for j,f in enumerate([frames[0],frames[1],frames[-2],frames[-1]]):sheet.paste(renderer.draw(f,caption=f"{start+i+1}. {e['source']} / turn {f['turn']}"),(8+j*298,8+i*478))
 sheet.save(study/f'routes-{start}.webp',quality=90)
