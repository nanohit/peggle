import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {RUNTIME_SOURCES,geometryKey} from '../destruction3/cache.mjs';
export {geometryKey};
export const SOURCES=['generators/destruction5/morphology.js','generators/destruction5/components.js','generators/destruction5/planner.js','generators/destruction5/grammar.js','generators/destruction5/evaluate.mjs','generators/destruction5/observe.mjs','generators/destruction4/grammar.js','generators/destruction4/shapes.js','generators/destruction4/envelope.js','generators/destruction4/geometry.js','generators/destruction4/observe.mjs','generators/destruction2/ribbon-geometry.js','generators/destruction2/bezier-geometry.js','generators/destruction/grammar.js','generators/quality/metrics.js',...RUNTIME_SOURCES];
export async function fingerprint(){return createHash('sha256').update((await Promise.all(SOURCES.map(p=>readFile(p)))).join('\n')).digest('hex');}
