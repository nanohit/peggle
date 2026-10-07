import {createHash} from 'node:crypto';
export const RUNTIME_SOURCES=['generators/destruction/native-simulator.mjs','generators/quality/machine.mjs','js/game.js','js/physics.js','js/destruction-mode.js','js/destruction-hinge.js','js/animation.js','js/blast-rig.js','js/levels.js'];
export function geometryKey(l){return createHash('sha256').update(JSON.stringify([l.pegs,l.groups,l.bezierCurves,l.destruction,l.ballCount,l.pegRadius,l.hitPegTimedClearEnabled,l.hitPegClearDelayMs,l.bucketEnabled,l.flippers])).digest('hex');}
