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

function vectorize(features) {
  const values = levelFeatureVector(features);
  return FEATURE_VECTOR_KEYS.map(key => Number(values[key]) || 0);
}

function fitNormalization(samples) {
  const raw = samples.map(sample => vectorize(sample.features));
  const mean = FEATURE_VECTOR_KEYS.map((_key, index) => (
    raw.reduce((sum, vector) => sum + vector[index], 0) / raw.length
  ));
  const scale = FEATURE_VECTOR_KEYS.map((_key, index) => {
    const variance = raw.reduce((sum, vector) => sum + ((vector[index] - mean[index]) ** 2), 0) / raw.length;
    return Math.max(1e-6, Math.sqrt(variance));
  });
  return { mean, scale };
}

function normalize(vector, normalization) {
  return vector.map((value, index) => (value - normalization.mean[index]) / normalization.scale[index]);
}

export function trainSyntheticDiscriminator(samples, options = {}) {
  if (!samples.some(sample => sample.label === 1) || !samples.some(sample => sample.label === 0)) {
    throw new Error('Synthetic discriminator requires both positive and negative samples.');
  }
  const normalization = fitNormalization(samples);
  const prepared = samples.map(sample => ({
    ...sample,
    vector: normalize(vectorize(sample.features), normalization)
  }));
  const positiveCount = prepared.filter(sample => sample.label === 1).length;
  const negativeCount = prepared.length - positiveCount;
  const weights = Array.from({ length: FEATURE_VECTOR_KEYS.length }, () => 0);
  let intercept = 0;
  const epochs = Math.max(100, Math.trunc(options.epochs || 1800));
  const learningRate = Number(options.learningRate || 0.12);
  const l2 = Number(options.l2 ?? 0.012);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = Array.from({ length: weights.length }, () => 0);
    let interceptGradient = 0;
    for (const sample of prepared) {
      const classWeight = sample.label === 1 ? 0.5 / positiveCount : 0.5 / negativeCount;
      const logit = intercept + sample.vector.reduce((sum, value, index) => sum + value * weights[index], 0);
      const error = (sigmoid(logit) - sample.label) * classWeight;
      interceptGradient += error;
      for (let index = 0; index < gradient.length; index++) gradient[index] += error * sample.vector[index];
    }
    const rate = learningRate / Math.sqrt(1 + epoch / 300);
    intercept -= rate * interceptGradient;
    for (let index = 0; index < weights.length; index++) {
      weights[index] -= rate * (gradient[index] + l2 * weights[index]);
    }
  }
  return {
    method: 'class-balanced-logistic-regression/v1',
    featureKeys: FEATURE_VECTOR_KEYS,
    normalization,
    weights,
    intercept,
    training: { sampleCount: samples.length, positiveCount, negativeCount, epochs, learningRate, l2 },
    caveat: 'Probability means original-vs-current-synthetic-mutations under these features, not fun or universal quality.'
  };
}

export function predictSyntheticDiscriminator(model, features) {
  const vector = normalize(vectorize(features), model.normalization);
  const logit = model.intercept + vector.reduce((sum, value, index) => sum + value * model.weights[index], 0);
  return sigmoid(logit);
}

function predictionMetrics(samples, predictions) {
  const positive = samples.filter(sample => sample.label === 1);
  const negative = samples.filter(sample => sample.label === 0);
  const positiveAccuracy = positive.filter(sample => predictions[sample.id] >= 0.5).length / positive.length;
  const negativeAccuracy = negative.filter(sample => predictions[sample.id] < 0.5).length / negative.length;
  let pairWins = 0;
  let pairCount = 0;
  for (const original of positive) {
    for (const variant of negative.filter(sample => sample.groupId === original.groupId)) {
      pairWins += predictions[original.id] > predictions[variant.id] ? 1 : 0;
      pairCount++;
    }
  }
  let aucWins = 0;
  let aucPairs = 0;
  for (const original of positive) {
    for (const variant of negative) {
      const difference = predictions[original.id] - predictions[variant.id];
      aucWins += difference > 0 ? 1 : (difference === 0 ? 0.5 : 0);
      aucPairs++;
    }
  }
  const logLoss = samples.reduce((sum, sample) => {
    const probability = Math.max(EPSILON, Math.min(1 - EPSILON, predictions[sample.id]));
    return sum - (sample.label * Math.log(probability) + (1 - sample.label) * Math.log(1 - probability));
  }, 0) / samples.length;
  return {
    balancedAccuracy: (positiveAccuracy + negativeAccuracy) / 2,
    positiveAccuracy,
    negativeAccuracy,
    withinParentPairWinRate: pairCount ? pairWins / pairCount : 0,
    rocAuc: aucPairs ? aucWins / aucPairs : 0,
    logLoss
  };
}

export function crossValidateSyntheticDiscriminator(samples, options = {}) {
  const groups = [...new Set(samples.map(sample => sample.groupId))].sort();
  const foldCount = Math.max(2, Math.min(groups.length, Math.trunc(options.folds || 5)));
  const groupFold = new Map(groups.map((group, index) => [group, index % foldCount]));
  const predictions = {};
  const folds = [];
  for (let fold = 0; fold < foldCount; fold++) {
    const training = samples.filter(sample => groupFold.get(sample.groupId) !== fold);
    const testing = samples.filter(sample => groupFold.get(sample.groupId) === fold);
    const model = trainSyntheticDiscriminator(training, options);
    for (const sample of testing) predictions[sample.id] = predictSyntheticDiscriminator(model, sample.features);
    folds.push({ fold, trainingGroups: new Set(training.map(sample => sample.groupId)).size, testingGroups: new Set(testing.map(sample => sample.groupId)).size });
  }
  return {
    method: 'grouped-cross-validation-by-parent-level/v1',
    foldCount,
    folds,
    predictions,
    metrics: predictionMetrics(samples, predictions),
    finalModel: trainSyntheticDiscriminator(samples, options)
  };
}
