import { FEATURE_VECTOR_KEYS, levelFeatureVector } from './features.mjs';

const EPSILON = 1e-9;

function sigmoid(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function featureArray(features) {
  const vector = levelFeatureVector(features);
  return FEATURE_VECTOR_KEYS.map(key => Number(vector[key]) || 0);
}

function candidateIndex(benchmark) {
  const index = new Map();
  for (const level of benchmark.pilot.levels) {
    index.set(level.id, { id: level.id, parentLevelId: level.id, features: level.features, role: 'reference-original' });
    for (const variant of level.variants) {
      index.set(variant.id, {
        id: variant.id,
        parentLevelId: level.id,
        features: variant.features,
        role: 'synthetic-counterfactual',
        operator: variant.operator
      });
    }
  }
  return index;
}

function buildRows(benchmark, review) {
  if (benchmark.id !== review.benchmarkId) throw new Error('Review belongs to a different benchmark.');
  if (review.decisions?.length !== benchmark.reviewPairs.length) throw new Error('A complete review is required to train the preference model.');
  const pairs = new Map(benchmark.reviewPairs.map(pair => [pair.id, pair]));
  const candidates = candidateIndex(benchmark);
  const decisions = new Map();
  const rows = [];
  for (const decision of review.decisions) {
    const pair = pairs.get(decision.pairId);
    if (!pair) throw new Error(`Unknown review pair ${decision.pairId}.`);
    if (!['left', 'right', 'tie'].includes(decision.choice)) throw new Error(`Invalid choice for ${decision.pairId}.`);
    decisions.set(decision.pairId, decision);
    const comparisonType = pair.comparisonType || 'reference-vs-variant';
    if (comparisonType === 'repeat-control' || decision.choice === 'tie') continue;
    const left = candidates.get(pair.left.levelId);
    const right = candidates.get(pair.right.levelId);
    if (!left || !right) throw new Error(`${pair.id} references an unavailable candidate.`);
    rows.push({
      id: pair.id,
      groupId: left.parentLevelId || right.parentLevelId,
      comparisonType,
      label: decision.choice === 'left' ? 1 : 0,
      left,
      right,
      humanSelectedRole: decision.choice === 'left' ? left.role : right.role
    });
  }

  const repeatControls = benchmark.reviewPairs
    .filter(pair => pair.comparisonType === 'repeat-control')
    .map(pair => {
      const decision = decisions.get(pair.id);
      const sourcePair = pairs.get(pair.truth.repeatOf);
      const sourceDecision = decisions.get(pair.truth.repeatOf);
      if (!decision || !sourceDecision || !sourcePair) return { pairId: pair.id, consistent: false, missing: true };
      const selectedId = decision.choice === 'tie' ? null : pair[decision.choice].levelId;
      const sourceSelectedId = sourceDecision.choice === 'tie' ? null : sourcePair[sourceDecision.choice].levelId;
      return {
        pairId: pair.id,
        repeatOf: pair.truth.repeatOf,
        consistent: decision.choice === 'tie' && sourceDecision.choice === 'tie'
          ? true
          : selectedId != null && selectedId === sourceSelectedId,
        selectedId,
        sourceSelectedId
      };
    });
  return { rows, repeatControls };
}

function fitScale(rows) {
  const vectors = rows.flatMap(row => [featureArray(row.left.features), featureArray(row.right.features)]);
  return FEATURE_VECTOR_KEYS.map((_key, index) => {
    const average = vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length;
    const variance = vectors.reduce((sum, vector) => sum + ((vector[index] - average) ** 2), 0) / vectors.length;
    return Math.max(1e-6, Math.sqrt(variance));
  });
}

function differenceVector(row, scale) {
  const left = featureArray(row.left.features);
  const right = featureArray(row.right.features);
  return left.map((value, index) => (value - right[index]) / scale[index]);
}

export function trainPairwisePreferenceModel(rows, options = {}) {
  if (rows.length < 2) throw new Error('At least two decided non-repeat pairs are required.');
  const scale = fitScale(rows);
  const prepared = rows.map(row => ({ ...row, vector: differenceVector(row, scale) }));
  const positiveCount = prepared.filter(row => row.label === 1).length;
  const negativeCount = prepared.length - positiveCount;
  if (!positiveCount || !negativeCount) throw new Error('Preference training requires decisions on both left and right candidates.');
  const weights = Array.from({ length: FEATURE_VECTOR_KEYS.length }, () => 0);
  let sideIntercept = 0;
  const epochs = Math.max(200, Math.trunc(options.epochs || 2400));
  const learningRate = Number(options.learningRate || 0.08);
  const l2 = Number(options.l2 ?? 0.035);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = Array.from({ length: weights.length }, () => 0);
    let interceptGradient = 0;
    for (const row of prepared) {
      const classWeight = row.label === 1 ? 0.5 / positiveCount : 0.5 / negativeCount;
      const logit = sideIntercept + row.vector.reduce((sum, value, index) => sum + value * weights[index], 0);
      const error = (sigmoid(logit) - row.label) * classWeight;
      interceptGradient += error;
      for (let index = 0; index < weights.length; index++) gradient[index] += error * row.vector[index];
    }
    const rate = learningRate / Math.sqrt(1 + epoch / 400);
    sideIntercept -= rate * interceptGradient;
    for (let index = 0; index < weights.length; index++) {
      weights[index] -= rate * (gradient[index] + l2 * weights[index]);
    }
  }
  return {
    method: 'regularized-pairwise-logistic-preference/v1',
    featureKeys: FEATURE_VECTOR_KEYS,
    scale,
    weights,
    sideIntercept,
    training: { pairCount: rows.length, positiveCount, negativeCount, epochs, learningRate, l2 },
    interpretation: 'Candidate utility is the dot product of normalized motif/layout features and weights; sideIntercept is retained only as a review-bias diagnostic.'
  };
}

export function predictPairwisePreference(model, leftFeatures, rightFeatures) {
  const row = { left: { features: leftFeatures }, right: { features: rightFeatures } };
  const vector = differenceVector(row, model.scale);
  const logit = model.sideIntercept + vector.reduce((sum, value, index) => sum + value * model.weights[index], 0);
  return sigmoid(logit);
}

export function scorePreferenceCandidate(model, features) {
  const vector = featureArray(features);
  return vector.reduce((sum, value, index) => sum + (value / model.scale[index]) * model.weights[index], 0);
}

function predictionMetrics(rows, predictions) {
  const leftRows = rows.filter(row => row.label === 1);
  const rightRows = rows.filter(row => row.label === 0);
  const correct = rows.filter(row => (predictions[row.id] >= 0.5 ? 1 : 0) === row.label).length;
  const leftAccuracy = leftRows.length
    ? leftRows.filter(row => predictions[row.id] >= 0.5).length / leftRows.length
    : 0;
  const rightAccuracy = rightRows.length
    ? rightRows.filter(row => predictions[row.id] < 0.5).length / rightRows.length
    : 0;
  const referenceRows = rows.filter(row => row.comparisonType === 'reference-vs-variant');
  const humanVariantRows = referenceRows.filter(row => row.humanSelectedRole !== 'reference-original');
  const humanOriginalRows = referenceRows.filter(row => row.humanSelectedRole === 'reference-original');
  const predictedRole = row => (predictions[row.id] >= 0.5 ? row.left.role : row.right.role);
  const logLoss = rows.reduce((sum, row) => {
    const probability = Math.max(EPSILON, Math.min(1 - EPSILON, predictions[row.id]));
    return sum - (row.label * Math.log(probability) + (1 - row.label) * Math.log(1 - probability));
  }, 0) / rows.length;
  return {
    pairCount: rows.length,
    accuracy: correct / rows.length,
    balancedSideAccuracy: (leftAccuracy + rightAccuracy) / 2,
    leftAccuracy,
    rightAccuracy,
    logLoss,
    variantRecall: humanVariantRows.length
      ? humanVariantRows.filter(row => predictedRole(row) !== 'reference-original').length / humanVariantRows.length
      : null,
    originalRecall: humanOriginalRows.length
      ? humanOriginalRows.filter(row => predictedRole(row) === 'reference-original').length / humanOriginalRows.length
      : null,
    alwaysOriginalBaseline: referenceRows.length
      ? humanOriginalRows.length / referenceRows.length
      : null,
    majoritySideBaseline: Math.max(leftRows.length, rightRows.length) / rows.length,
    byComparisonType: Object.fromEntries([...new Set(rows.map(row => row.comparisonType))].map(type => {
      const values = rows.filter(row => row.comparisonType === type);
      return [type, {
        count: values.length,
        accuracy: values.filter(row => (predictions[row.id] >= 0.5 ? 1 : 0) === row.label).length / values.length
      }];
    }))
  };
}

export function crossValidatePairwisePreference(rows, options = {}) {
  const groups = [...new Set(rows.map(row => row.groupId))].sort();
  const foldCount = Math.max(2, Math.min(groups.length, Math.trunc(options.folds || 5)));
  const groupFold = new Map(groups.map((group, index) => [group, index % foldCount]));
  const predictions = {};
  const folds = [];
  for (let fold = 0; fold < foldCount; fold++) {
    const training = rows.filter(row => groupFold.get(row.groupId) !== fold);
    const testing = rows.filter(row => groupFold.get(row.groupId) === fold);
    const model = trainPairwisePreferenceModel(training, options);
    for (const row of testing) predictions[row.id] = predictPairwisePreference(model, row.left.features, row.right.features);
    folds.push({
      fold,
      trainingGroups: new Set(training.map(row => row.groupId)).size,
      testingGroups: new Set(testing.map(row => row.groupId)).size,
      testingPairs: testing.length
    });
  }
  return {
    method: 'grouped-cross-validation-by-parent-level/v1',
    foldCount,
    folds,
    predictions,
    metrics: predictionMetrics(rows, predictions),
    finalModel: trainPairwisePreferenceModel(rows, options)
  };
}

export function trainPreferenceFromReview(benchmark, review, options = {}) {
  const { rows, repeatControls } = buildRows(benchmark, review);
  const crossValidation = crossValidatePairwisePreference(rows, options);
  const repeatConsistency = repeatControls.length
    ? repeatControls.filter(control => control.consistent).length / repeatControls.length
    : null;
  const metrics = crossValidation.metrics;
  const qualityChecks = {
    enoughUniqueDecisions: rows.length >= 75,
    repeatConsistencyAdequate: repeatConsistency == null || repeatConsistency >= 0.8,
    beatsMajoritySideBaseline: metrics.accuracy >= metrics.majoritySideBaseline + 0.05,
    detectsPreferredVariants: metrics.variantRecall == null || metrics.variantRecall >= 0.5
  };
  return {
    format: 'peggle-human-preference-model',
    formatVersion: 1,
    benchmarkId: benchmark.id,
    reviewExportedAt: review.exportedAt || null,
    trainingPairs: rows.length,
    excludedTies: review.decisions.filter(decision => decision.choice === 'tie').length,
    repeatConsistency: {
      count: repeatControls.length,
      consistent: repeatControls.filter(control => control.consistent).length,
      rate: repeatConsistency,
      controls: repeatControls
    },
    crossValidation,
    qualityGate: {
      status: Object.values(qualityChecks).every(Boolean) ? 'passed' : 'diagnostic-only',
      checks: qualityChecks
    },
    caveat: 'Do not use this model as a generator objective unless grouped held-out performance beats baselines and repeat consistency is adequate.'
  };
}

