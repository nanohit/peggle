import {SurvivalGenerator} from '../generators/survival/grammar.js';

// Bounded live window. Generated geometry is appended to the existing native
// Game; old animation phases, body velocities and launcher balls keep running.
export class SurvivalStream {
  constructor(seed) {
    this.generator=new SurvivalGenerator(seed);
    this.generated=0; this.familyCounts={}; this.recent=[];
    this.nextMaintenanceAt=0;
  }

  maintain(game) {
    const runtime=game.survivalRuntime, camera=runtime.getCameraY(), height=game.canvas.height;
    let changed=false;
    while(this.generator.cursorY<camera+height*2.2) {
      const patch=this.generator.next();
      game.pegs.push(...patch.pegs);game.groups.push(...patch.groups);
      game.initialOrangePegs+=patch.targets;game.totalSurvivalTargets+=patch.targets;
      this.generated++;this.familyCounts[patch.family]=(this.familyCounts[patch.family]||0)+1;
      this.recent.push({index:patch.index,family:patch.family,targets:patch.targets,knockback:patch.knockback});
      if(this.recent.length>8)this.recent.shift();changed=true;
    }
    if(!changed&&game.levelElapsedMs<this.nextMaintenanceAt&&camera<=4096)return;
    this.nextMaintenanceAt=game.levelElapsedMs+500;
    const before=game.pegs.length;
    // Enough history for the largest supported pushback. Consumed pegs are
    // never reconstructed and reversing the camera never generates duplicates.
    const retained=game.pegs.filter(p=>p.y>camera-1050);
    if(retained.length!==before)game.pegs=retained;
    const live=new Set(game.pegs.map(p=>p.id));
    const groups=game.groups.filter(g=>game.pegs.some(p=>p.groupId===g.id));
    if(groups.length!==game.groups.length){game.groups=groups;changed=true;}
    game.hitPegIds=game.hitPegIds.filter(id=>live.has(id));
    game.turnHitPegIds=game.turnHitPegIds.filter(id=>live.has(id));
    for(const map of [game.pendingHitPegClears,game.pendingDestructionPileClears])
      for(const id of map.keys())if(!live.has(id))map.delete(id);
    for(const id of game.survivalEscapedPegIds)if(!live.has(id))game.survivalEscapedPegIds.delete(id);
    for(const id of game.animator.suspendedPegIds)if(!live.has(id))game.animator.suspendedPegIds.delete(id);
    if(changed||before!==game.pegs.length) {
      game.animator.loadFromLevel(game.pegs,game.groups,{preserveGroupOrigins:true});
      game.physics.setPegs(game.pegs);game.syncPhysicsHitPegState();
      game.destructionSystem.markStructureDirty();game.destructionSystem.syncBodies(game.pegs,game.groups);
      game.suspendDestructionPhysicsOwnedAnimations();
    }
    if(camera>4096) this.rebase(game,3072);
    if(changed)game.emitUiStateIfChanged(true,'survival-generated');
  }

  rebase(game,shift) {
    for(const p of game.pegs){p.y-=shift;for(const slice of p.curveSlices||[])slice.y-=shift;}
    for(const ball of game.balls)ball.y-=shift;
    for(const snap of game.animator.originalPositions.values()){
      snap.y-=shift;for(const slice of snap.curveSlices||[])slice.y-=shift;
    }
    for(const a of game.animator.animations)a.centerY-=shift;
    for(const body of game.destructionSystem.bodies.values()){
      body.y-=shift;if(body.hinge)body.hinge.anchorY-=shift;
      body.aabb.minY-=shift;body.aabb.maxY-=shift;body.transformDirty=true;
    }
    game.survivalRuntime.rebase(shift);this.generator.rebase(shift);
    game.trajectory=null;game.resetStuckBallTracking();
    game.physics.markPegGridDirty();game.destructionSystem.markStructureDirty();
    game.renderer.clearPegExitAnimations?.();game.renderer.clearPegEntryAnimations?.();
  }
}
