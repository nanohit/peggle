import json,math,importlib.util
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('quality_render',root/'generators/quality/render.py')
renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)
out=root/'generators/survival/study'
streams=json.loads((out/'flow-streams.json').read_text())
for batch in range(2):
    sheet=Image.new('RGB',(900,1920),'#243645')
    strip=Image.new('RGB',(900,1840),'#243645')
    for col,row in enumerate(streams[batch*3:batch*3+3]):
        strip.paste(renderer.draw_level({'id':row['seed'],'pegs':[p for p in row['pegs'] if p['y']<2450]},290,1810),(8+col*298,8))
        for rank,camera in enumerate([0,450,900,1350]):
            ps=[{**p,'y':p['y']-camera,'curveSlices':[{**q,'y':q['y']-camera} for q in p.get('curveSlices',[])]}
                for p in row['pegs'] if camera-35<p['y']<camera+635]
            im=renderer.draw_level({'id':row['seed']+' @ '+str(camera),'pegs':ps},290,470)
            sheet.paste(im,(8+col*298,8+rank*478))
    sheet.save(out/f'flow-views-{batch}.webp',quality=92)
    strip.save(out/f'flow-strips-{batch}.webp',quality=92)
    print(out/f'flow-views-{batch}.webp')
