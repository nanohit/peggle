from render import draw_level,sheet,root,OUT
import json,sys,math
from PIL import Image
campaign=json.loads((root/'data/des2/campaign.json').read_text());proof=json.loads((root/'data/des2/proof.json').read_text())
from pathlib import Path
sys.path.insert(0,str(root/'generators/quality'))
sheet(campaign['levels'],'des2',3,360,585)
for name,rows in [('des2',[r['proof'] for r in proof['accepted']]),('des1',json.loads((root/'data/quality/machine.json').read_text())['sets']['des1'])]:
 for start in range(0,len(rows),4):
  im=Image.new('RGB',(3*368+8,4*593+8),'#243645')
  for i,r in enumerate(rows[start:start+4]):
   frames=r['frames'];show=[frames[0],frames[min(1,len(frames)-1)],frames[-1]]
   for j,f in enumerate(show):
    caption=r['id']+' / '+str(f['turn'])+' shot'
    im.paste(draw_level(f,caption=caption),(8+j*368,8+i*593))
  im.save(OUT/(name+'-routes-'+str(start)+'.png'))
