import json, importlib.util, math
from pathlib import Path
from PIL import Image
root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('quality_render',root/'generators/quality/render.py')
renderer=importlib.util.module_from_spec(spec);spec.loader.exec_module(renderer)
out=root/'generators/survival/study'
for source in out.glob('*.json'):
    if source.name=='tuning.json': continue
    rows=json.loads(source.read_text())
    sheet=Image.new('RGB',(4*298+8,math.ceil(len(rows)/4)*478+8),'#243645')
    for i,row in enumerate(rows):
        sheet.paste(renderer.draw_level(row,290,470),(8+i%4*298,8+i//4*478))
    sheet.save(out/(source.stem+'.webp'),quality=90)
    print(out/(source.stem+'.webp'))
