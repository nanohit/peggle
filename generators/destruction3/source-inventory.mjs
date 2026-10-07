import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const files={blast:'data/gen/blast.json',main:'cdn-data/primary.json',des:'data/des/campaign.json',des1:'data/des1/campaign.json',des2:'data/des2/campaign.json'},inventory={};
for(const [name,file] of Object.entries(files)){
 const raw=await readFile(file),levels=JSON.parse(raw).levels,counts={};const count=k=>counts[k]=(counts[k]||0)+1;
 for(const l of levels){for(const p of l.pegs)count('peg:'+p.type);for(const g of l.groups||[])if(g.animation||g.blastRig)count('moving-assembly');count('curves:'+Math.min(8,Object.keys(l.bezierCurves||{}).length));for(const a of l.metadata?.generator?.plan?.assemblies||[])count('assembly:'+a.type);}
 inventory[name]={file,sha256:createHash('sha256').update(raw).digest('hex'),levels:levels.length,counts};
}
await writeFile('data/des3/source-inventory.json',JSON.stringify({inventory,transfer:{blast:['arc/ring openings','compound Bezier ribbons','radial symmetry','branching silhouettes','whole-assembly movement'],des:['native hinged platforms','counterweighted cargo','paired bridge leaves with open sides'],des1:['receiving cups','clearable shelves','release-transfer-catch graph'],des2:['native scale','true warped brick ribbons','free transfer corridors','native portal/magnet eligibility'],main:['functional paired portals','magnet fields on movable cargo','bounce deflectors','moving motifs']},boundaries:['No new native peg types, objectives, stages or defeat rules.','No arbitrary Blast drawings reconstructed by a model. Shapes come from numerical profiles.','Default generation expands a bounded DAG; calibration forms remain optional regression cases.']},null,2));
console.log('source inventory written');
