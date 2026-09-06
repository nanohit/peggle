# Preference benchmark v2

Benchmark v2 turns the corrected static renderer into a usable human-preference
experiment. It does not assume that a synthetic alternative is worse than its
source: every new comparison is an unknown counterfactual until the reviewer
chooses.

## Review design

The queue contains 100 decisions:

- 20 accepted v1 decisions, imported as a locked prefix;
- 30 new source-versus-global-layout comparisons;
- 30 source-versus-motif-aware comparisons;
- 10 comparisons between two synthetic alternatives;
- 10 hidden, side-swapped repeats used only to measure reviewer consistency.

The 80 new decisions are balanced across 16 static Peggle Deluxe levels. Each
of the five global operators has 10 source comparisons in the complete dataset;
each of the five motif-aware operators has 6. Visible titles are identical on
both sides and never disclose the operator.

Motif-aware operators first detect coherent lines, arcs, grids, and proximity
clusters. Tightening, expansion, rotation, translation, and rhythm
regularization then transform the selected group as one unit. Verification
rejects a generated artifact if its declared motif membership and changed
object count disagree.

## Run the review

From PowerShell in the `peggle` repository:

```powershell
npm run research:review
```

Keep that window open and visit:

`http://localhost:8765/research/generated/benchmark-v2/review.html`

The page must begin at `20 / 100 (20 imported)`. Keys `1`, `2`, and `0` select
left, right, and tie. Undo and Reset cannot cross the imported checkpoint.

## Turn the review into a preference signal

After all 100 decisions, export the review JSON and run:

```powershell
npm run research:train-preference -- research/generated/benchmark-v2/benchmark.json "J:/path/to/exported-review.json" research/generated/benchmark-v2/preference-model.json
```

Training excludes ties and repeat controls. It fits a regularized pairwise
logistic model over layout and motif features, then evaluates it by holding out
entire parent levels rather than random pairs. The output reports held-out
accuracy, side bias, log loss, original/variant recall, repeat consistency, and
simple baselines.

The model is marked `diagnostic-only` unless there are at least 75 usable unique
decisions, repeat consistency is at least 80%, held-out accuracy beats the
majority-side baseline by five percentage points, and it can recognize at least
half of human-preferred variants. A failed gate is evidence that more or better
comparisons are needed, not a generator objective.

## Rebuild and verify

```powershell
npm run research:benchmark:v2
npm run research:verify-benchmark:v2
npm run test:research
```

The rebuild command cryptographically pins the imported review and fails instead
of silently creating a fresh dataset if the prior evidence no longer matches.
