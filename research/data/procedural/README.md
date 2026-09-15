# Procedural research data

This directory contains the small, portable evidence set needed to continue
the generator work on another machine. The source code and generator rules are
in the repository; these files preserve the observations that motivated the
current external-support experiment.

## Included

- `repair/radial-v1-50eea9c5-repair-54902cfd-draft.json` — the canonical
  author repair archive: three levels, before/after native states, command
  evidence, notes and dispositions. It is a draft because the calibration
  candidate was not accepted. SHA-256:
  `4ee9883391c8492460947b8a75d377b066a7b05d97e175cbc8348c159dc41412`.
- `repair/digest/` — a compact v4 digest and SVG comparison previews derived
  from that archive. The raw archive remains authoritative. The digest is
  independently recomputed and fits the 100,000-byte combined model-text
  budget (`digest.md` + `digest.json`).
- `benchmark-reviews/` — the three human review exports and the derived
  summaries/model diagnostics from quality v1 and preference v2. Quality v0 is
  retained only with its explicit invalidation record; do not train or report
  it as valid preference data.

## Important interpretation limits

The radial repair archive is actual author evidence, but it is one repair
session in one procedural family. It supports the hypothesis of external
support contacts; it does not establish that the proposed supports improve
quality. The support study remains an explicit, manually specified experiment
with three seeds and two matched comparisons.

The preference v1/v2 files are useful historical labels for mutation and
representation diagnostics. The v2 preference model is marked
`diagnostic-only` and has imperfect repeat consistency. They are not a
definition of PopCap-quality design and must not be treated as a trained
generator objective.

The digest reports an expected stored-summary mismatch for one old repair after
the bumper semantic-scope fix. This is a method revision signal, not permission
to alter the canonical archive. Re-run the digest from the raw archive when
needed:

```text
node research/tools/digest-repair-session.mjs research/data/procedural/repair/radial-v1-50eea9c5-repair-54902cfd-draft.json research/generated/procedural-author-digest --no-png
```

Build the current explicitly specified support comparison with:

```text
npm run research:supports:build
```

No file here enables automatic rule learning or updates rules from user
feedback. The full commercial/source corpora under the local ignored
`research/generated/` tree are intentionally not mirrored into GitHub; they
are large, source-sensitive inputs and can be transferred privately if later
needed for corpus-level work.
