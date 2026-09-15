# Peggle quality benchmark v1

Generated: 2026-08-25T13:21:33.511Z

This is a screening benchmark, not a trained definition of fun. Original
commercial layouts are professional reference examples. Synthetic mutations are
negative hypotheses awaiting blind human review. Production Alea levels are used
as target-domain/mechanics adaptation data, not silently promoted to positives.

## Corpus

- Reference corpus: corpus:peggle-deluxe
- Eligible unique reference layouts: 55
- Mutation-safe reference layouts: 16
- Pilot selection: 8 layouts via deterministic farthest-point coverage
- Synthetic variants: 40
- Blind review queue: 20 pairs
- Physics mode: originals
- External holdout: corpus:peggle-nights (4 levels, 20 unseen variants)

## Pilot

| Level | Targets | Obstacles | Moving | Mirror symmetry | Screening | Sweep reachability |
|---|---:|---:|---:|---:|---:|---:|
| baseball | 105 | 0 | 0 | 0.67 | 0.867 | 0.59 |
| level1 | 96 | 6 | 0 | 0.69 | 0.642 | 0.85 |
| blocks | 106 | 0 | 0 | 0.40 | 0.791 | 0.44 |
| crisscross | 134 | 0 | 0 | 0.62 | 0.781 | 0.19 |
| fourdoors | 100 | 4 | 4 | 0.62 | 0.764 | 0.73 |
| dice | 109 | 0 | 0 | 0.64 | 0.793 | 0.39 |
| aim | 85 | 3 | 0 | 0.54 | 0.701 | 0.78 |
| plinko | 112 | 0 | 0 | 0.74 | 0.707 | 0.71 |

## Mutation sanity check

The win rate below asks only whether the reference layout has the higher
validity-plus-reference-conformity screening score. It does not establish that
the reference is more fun.

| Operator | Variants | Profile wins | Discriminator wins | Variant validity | Variant conformity |
|---|---:|---:|---:|---:|---:|
| jitter-subtle | 8 | 88% | 100% | 1.000 | 0.360 |
| spacing-compress | 8 | 100% | 100% | 1.000 | 0.253 |
| fine-grid | 8 | 50% | 100% | 1.000 | 0.400 |
| band-drift | 8 | 50% | 88% | 1.000 | 0.385 |
| lateral-bias | 8 | 13% | 75% | 1.000 | 0.400 |

Overall profile win rate: 60.0%.

Grouped out-of-fold synthetic-discriminator pair win rate: 92.5%; balanced accuracy: 61.3%; ROC AUC: 0.662.

External-corpus pair win rate: 75.0%. This is the more important transfer check because neither the Nights layouts nor their mutations were used to fit the discriminator.


## Interpretation boundaries

- Reference conformity detects distribution shift; it must not become a copy-the-corpus objective.
- Every reviewed target is a verified static circle or straight brick. Curved and moving layouts remain in the reference corpus but are not object-wise mutated.
- The headless sweep uses the target game's static PhysicsEngine subset and one shot per angle.
- Source animation, complete turn strategy, power-ups, orange assignment, camera pacing, and subjective quality remain outside this pilot.
- Human A/B decisions exported by review.html are the next calibration layer.
