# Quality benchmark v0

> **Deprecated and invalid for labels.** The v0 semantic renderer interpreted
> curved-brick radius as straight-rectangle width, used base transforms for
> moving objects, and exposed mutation names in supposedly blind previews.
> Existing v0 decisions are audit artifacts only. Use `BENCHMARK_V1.md`.

The benchmark is the first falsifiable layer between source ingestion and a
procedural generator. It deliberately separates four claims that would be
unsafe to collapse into one score:

1. **mechanical validity**: finite transforms, declared bounds, collision-risk
   diagnostics, and supported object coverage;
2. **reference structure**: a robust profile over professional Peggle layouts;
3. **synthetic discrimination**: whether static features distinguish original
   layouts from controlled perturbations;
4. **target-physics response**: a deterministic one-shot angle sweep through
   the browser game's DOM-free `PhysicsEngine` subset.

None of these is named `fun`. The production Alea corpus is target-domain and
mechanics adaptation data, not an automatic quality-positive corpus. Synthetic
mutations are negative hypotheses until a human blind review confirms them.

## Reproduce the current pilot

Build the pinned PeggleEdit adapter:

```powershell
powershell -ExecutionPolicy Bypass -File research\tools\peggleedit-exporter\build.ps1 -PeggleEditRoot ..\upstream\PeggleEdit
```

Ingest the 55 Deluxe layouts and the 60 Nights adventure layouts. `Tilt.dat` is
a separate special level and is excluded from the 60-level Nights holdout:

```powershell
node research/tools/export-peggle-pak-corpus.mjs '..\Peggle Deluxe\main.pak'
node research/tools/export-peggle-pak-corpus.mjs '..\Peggle Nights\main.pak' --exclude 'levels[\\/]Tilt\.dat$'
```

Take a read-only snapshot of the production API:

```powershell
node research/tools/import-production-corpus.mjs --deployment-revision 6201ec1120f7dbadecf76a6e40710bb9bacab915
```

Build the benchmark. Deluxe is the reference source, Nights is an external
professional holdout, and Alea production is adaptation context:

```powershell
node research/tools/build-benchmark.mjs research\generated\peggle-deluxe\corpus.json --holdout research\generated\peggle-nights\corpus.json --adaptation research\generated\production\corpus.json --pilot-size 10 --mutation-count 10 --review-pairs 40 --simulate originals --angle-count 17 --max-steps 3600 --seed deluxe-pilot-v0
node research/tools/verify-benchmark.mjs research\generated\benchmark-v0\benchmark.json
```

All extracted commercial records and production snapshots remain below the
ignored `research/generated/` boundary.

## Outputs

`research/generated/benchmark-v0/` contains:

- `benchmark.json`: machine-readable features, physics sweeps, model, mutation
  comparisons, external holdout result, and blind review queue;
- `report.md`: compact human-readable result;
- `levels/originals/`: the ten selected canonical reference records;
- `levels/variants/`: 100 canonical synthetic perturbations;
- `previews/`: one semantic SVG per layout instead of a frame dump;
- `llm-dossiers.jsonl`: ten compact dossiers for normal web LLM chats;
- `review.html`: blind A/B reviewer with local autosave and JSON export.

The ten pilot layouts are selected by deterministic farthest-point coverage over
the normalized feature space. No names are manually cherry-picked.

## Static features and mutation families

The current 22-dimensional vector covers population, shape mix, actual movement
definitions, normalized centroid/spread/coverage, x/y entropy, occupancy,
edge use, nearest-neighbor statistics, proximity graph structure, mirror
symmetry, and approximate collision-risk measurements.

Mutation operators are deterministic from a stored seed:

- moderate and severe positional jitter;
- center and vertical-band collapse;
- coarse-grid quantization;
- independent x/y shuffling;
- uniform random placement;
- edge packing;
- four-cluster packing;
- overlapping pairs.

The class-balanced logistic discriminator is evaluated with grouped folds: an
original level and every mutation derived from it stay in the same fold. This
prevents exact parent leakage. The separate Nights check is stronger: neither
its selected originals nor its generated variants fit the Deluxe pilot model.
Even so, a high result only proves discrimination from these mutation families.
It does not prove general level quality.

## Blind review loop

Serve the repository root over HTTP, then open the generated reviewer:

```powershell
npm run research:review
```

```text
http://localhost:8765/research/generated/benchmark-v0/review.html
```

Keys `1`, `2`, and `0` choose A, B, or tie. The interface does not display which
side is original. Exported decisions can be summarized without exposing the
truth during review:

```powershell
node research/tools/summarize-benchmark-review.mjs research\generated\benchmark-v0\benchmark.json benchmark-review.json research\generated\benchmark-v0\review-summary.json
```

A variant preferred over its source is useful evidence: that mutation family is
not a universally safe negative label, or the variant found a genuine
improvement. The next quality ranker must use these reviewed outcomes rather
than overwriting them with the synthetic assumption.

## Known limits

- The physics sweep is one shot per angle, not a complete-level agent.
- Classic source movement is preserved in canonical records but not executed by
  the static headless subset.
- Orange assignment, power-ups, complete turn policy, native Peggle physics,
  camera pacing, and vertical macro-structure are not scored yet.
- Reference conformity is useful for outlier detection, not as an objective to
  maximize; maximizing it would encourage imitation and suppress novelty.
- The first human review is required before training a preference-aware quality
  ranker or using synthetic labels to guide generation.
