#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMotifLibrary } from '../generator/lib/motif-library.mjs';
import { buildVerticalProfile } from '../generator/lib/vertical-profile.mjs';
import { writeJson } from './lib/node-io.mjs';

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = {
    reference: [
      path.join(GAME_ROOT, 'research', 'generated', 'peggle-deluxe', 'corpus.json'),
      path.join(GAME_ROOT, 'research', 'generated', 'peggle-nights', 'corpus.json')
    ],
    adaptation: path.join(GAME_ROOT, 'research', 'generated', 'production', 'corpus.json'),
    output: path.join(GAME_ROOT, 'research', 'generated', 'generator-v0', 'foundation'),
    at: new Date().toISOString()
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--reference') options.reference = argv[++index].split(',').map(item => path.resolve(item.trim()));
    else if (value === '--adaptation') options.adaptation = path.resolve(argv[++index]);
    else if (value === '--output') options.output = path.resolve(argv[++index]);
    else if (value === '--at') options.at = argv[++index];
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

export async function buildGeneratorFoundation(options) {
  const motifLibrary = await buildMotifLibrary(options.reference, { at: options.at });
  const verticalProfile = await buildVerticalProfile(options.adaptation, { at: options.at });
  await writeJson(path.join(options.output, 'motif-library.json'), motifLibrary);
  await writeJson(path.join(options.output, 'vertical-profile.json'), verticalProfile);
  const eligibleTypes = Object.entries(motifLibrary.counts.eligibleByType)
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `- ${type}: ${count}`)
    .join('\n');
  const summary = `# Generator v0 foundation

Built at: ${options.at}

## Reference vocabulary

- Peggle source levels: ${motifLibrary.counts.levels}
- Detected motifs retained for audit: ${motifLibrary.counts.templates}
- Static motifs eligible for construction: ${motifLibrary.counts.generatorEligible}
- Non-overlapping motifs in per-level generator covers: ${motifLibrary.counts.disjointGeneratorCoverTemplates}
- Connected multi-motif fragments available to the generator: ${motifLibrary.counts.generatorFragments}
- Unique motif signatures: ${motifLibrary.counts.uniqueSignatures}

Eligible motif types:

${eligibleTypes || '- none'}

## Target-game pacing

- Authored primary standard levels used: ${verticalProfile.eligibleProfileCount}
- Target-count 20/50/80%: ${verticalProfile.targetCount.low} / ${verticalProfile.targetCount.median} / ${verticalProfile.targetCount.high}
- Orange fraction 20/50/80%: ${verticalProfile.orangeFraction.low.toFixed(3)} / ${verticalProfile.orangeFraction.median.toFixed(3)} / ${verticalProfile.orangeFraction.high.toFixed(3)}
- Rectangular-peg fraction 20/50/80%: ${verticalProfile.brickFraction.low.toFixed(3)} / ${verticalProfile.brickFraction.median.toFixed(3)} / ${verticalProfile.brickFraction.high.toFixed(3)}
- Target viewport: ${verticalProfile.viewport.width}x${verticalProfile.viewport.height}

The two sources have deliberately separate jobs: Peggle contributes local compositional motifs; authored Alea levels contribute only continuous portrait pacing and occupancy. No learned model is involved.
`;
  await writeFile(path.join(options.output, 'summary.md'), summary, 'utf8');
  return { motifLibrary, verticalProfile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const result = await buildGeneratorFoundation(options);
  console.log(`foundation: ${options.output}`);
  console.log(`motifs: ${result.motifLibrary.counts.generatorEligible}/${result.motifLibrary.counts.templates} eligible`);
  console.log(`portrait profiles: ${result.verticalProfile.eligibleProfileCount}`);
}
