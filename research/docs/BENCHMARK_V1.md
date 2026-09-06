# Quality benchmark v1

Benchmark v1 is the first reviewable pilot. It supersedes v0; no v0 decision is
accepted by the review summarizer.

## What changed

- Straight Peggle bricks use the editor's actual long-axis angle convention.
- Curved bricks are exported and rendered as annular sectors with world-space
  centerline slices. Their radius is never treated as rectangle width.
- Moving objects use PeggleEdit's deterministic initial-phase `DrawLocation`
  and estimated draw angle for the semantic snapshot. The authored source
  transform remains preserved in provenance.
- Object-wise mutations are allowed only when every target is a static circle
  or verified straight brick. Curved and moving layouts remain reference data,
  but are excluded from these mutation operators.
- Destructive artifact operators were replaced by five mild counterfactuals:
  subtle jitter, spacing compression, fine-grid quantization, band drift, and
  lateral bias.
- Both review candidates show the same parent title. Mutation identity is not
  printed in the SVG.
- The default pilot is 8 distinct originals, 5 variants each, and 20 blinded
  comparisons. This is intentionally a calibration pass, not a large labeling
  job.

## Rebuild and verify

Run these commands in PowerShell from the `peggle` repository directory:

```powershell
npm run research:audit-pak-corpus -- research/generated/peggle-deluxe/corpus.json
npm run research:audit-pak-corpus -- research/generated/peggle-nights/corpus.json
npm run research:benchmark:v1
npm run research:verify-benchmark:v1
```

The verifier rejects legacy benchmark envelopes, unsupported reviewed targets,
operator leaks in variant titles, and review pairs with different visible
candidate names.

## Review

From the same PowerShell window, run:

```powershell
npm run research:review
```

That command starts a local read-only web server. Leave the window open and
open:

`http://localhost:8765/research/generated/benchmark-v1/review.html`

Use `1` for the left candidate, `2` for the right candidate, and `0` for a tie.
Exported v1 reviews carry both the benchmark ID and representation revision;
the summarizer checks both before accepting decisions.

## Scope boundary

The v1 A/B queue evaluates small compositional perturbations on faithfully
rendered static layouts. It does not yet evaluate animation quality or mutate
individual curved sectors. Those require structure-aware operators that move a
whole motion rig or curved motif as one unit.
