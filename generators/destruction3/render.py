import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'quality'))
from render import draw_level
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'generators/destruction3/report/images';OUT.mkdir(parents=True,exist_ok=True)
proof=json.loads((ROOT/'data/des3/proof.json').read_text())
campaign=json.loads((ROOT/'data/des3/campaign.json').read_text())
rows=[next(r for r in proof['accepted'] if r['id']==l['id']) for l in campaign['levels']]
for start in range(0,len(rows),8):
    selected=rows[start:start+8]
    sheet=Image.new('RGB',(4*268+8,2*448+8),'#243645')
    routes=Image.new('RGB',(3*268+8,len(selected)*448+8),'#243645')
    for i,r in enumerate(selected):
        frames=r['proof']['frames'];cap=f"{start+i+1}: {r['options']['seed']} ({r['proof']['shots']} shots)"
        sheet.paste(draw_level(frames[0],260,440,cap),(8+(i%4)*268,8+(i//4)*448))
        for j,f in enumerate([frames[0],frames[1],frames[-1]]):routes.paste(draw_level(f,260,440,f"{start+i+1}: turn {f['turn']}"),(8+j*268,8+i*448))
    sheet.save(OUT/f'catalog-{start}.png');routes.save(OUT/f'routes-{start}.png');print(start)
