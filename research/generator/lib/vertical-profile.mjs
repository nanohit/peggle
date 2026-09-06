import path from 'node:path';

import { readJson, sha256Value } from '../../tools/lib/node-io.mjs';

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values, average = mean(values)) {
  return values.length ? Math.sqrt(mean(values.map(value => (value - average) ** 2))) : 0;
}

function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function effectiveBounds(record) {
  const bounds = record.authored.coordinateSystem.bounds;
  const viewport = record.authored.coordinateSystem.viewport;
  const survival = record.authored.mechanics?.mode === 'survival' || record.extensions?.nativeLevel?.survival?.enabled;
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: survival ? bounds.maxY : bounds.minY + finite(viewport?.height, bounds.maxY - bounds.minY)
  };
}

function profileForRecord(record, sampleCount, bandwidth) {
  const bounds = effectiveBounds(record);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const targets = record.authored.objects.filter(object => (
    object.role === 'target'
    && Number.isFinite(Number(object.transform?.x))
    && Number.isFinite(Number(object.transform?.y))
    && object.transform.x >= bounds.minX
    && object.transform.x <= bounds.maxX
    && object.transform.y >= bounds.minY
    && object.transform.y <= bounds.maxY
  ));
  const samples = Array.from({ length: sampleCount }, (_value, index) => {
    const y = index / (sampleCount - 1);
    const weighted = targets.map(object => {
      const normalizedY = (object.transform.y - bounds.minY) / height;
      const delta = (normalizedY - y) / bandwidth;
      return { object, weight: Math.exp(-0.5 * delta * delta) };
    });
    const weightSum = weighted.reduce((sum, value) => sum + value.weight, 0);
    const centerX = weightSum
      ? weighted.reduce((sum, value) => sum + value.weight * ((value.object.transform.x - bounds.minX) / width), 0) / weightSum
      : 0.5;
    const spreadX = weightSum
      ? Math.sqrt(weighted.reduce((sum, value) => {
        const x = (value.object.transform.x - bounds.minX) / width;
        return sum + value.weight * ((x - centerX) ** 2);
      }, 0) / weightSum)
      : 0.2;
    return { y, intensity: weightSum, centerX, spreadX };
  });
  const totalIntensity = samples.reduce((sum, sample) => sum + sample.intensity, 0) || 1;
  samples.forEach(sample => { sample.density = sample.intensity / totalIntensity; });
  const orangeCount = targets.filter(object => String(object.targetType || '').toLowerCase().includes('orange')).length;
  return {
    id: record.id,
    name: record.authored.name,
    primaryCampaign: !!record.extensions?.production?.primaryCampaign,
    mode: record.authored.mechanics?.mode || 'standard',
    width,
    height,
    targetCount: targets.length,
    orangeFraction: targets.length ? orangeCount / targets.length : 0,
    brickFraction: targets.length ? targets.filter(object => object.kind === 'brick').length / targets.length : 0,
    samples
  };
}

export async function buildVerticalProfile(manifestPath, options = {}) {
  const absolute = path.resolve(manifestPath);
  const root = path.dirname(absolute);
  const manifest = await readJson(absolute);
  const sampleCount = Math.max(9, Math.trunc(options.sampleCount || 25));
  const bandwidth = Math.max(0.02, Number(options.bandwidth || 0.085));
  const profiles = [];
  for (const entry of manifest.records || []) {
    const record = await readJson(path.resolve(root, entry.recordPath));
    const profile = profileForRecord(record, sampleCount, bandwidth);
    if (profile.mode === 'standard' && profile.primaryCampaign && profile.targetCount >= 20) profiles.push(profile);
  }
  if (profiles.length < 5) throw new Error(`Only ${profiles.length} usable authored pacing profiles were found.`);
  const aggregateSamples = Array.from({ length: sampleCount }, (_value, index) => ({
    y: index / (sampleCount - 1),
    density: quantile(profiles.map(profile => profile.samples[index].density), 0.5),
    densityLow: quantile(profiles.map(profile => profile.samples[index].density), 0.2),
    densityHigh: quantile(profiles.map(profile => profile.samples[index].density), 0.8),
    centerX: quantile(profiles.map(profile => profile.samples[index].centerX), 0.5),
    spreadX: quantile(profiles.map(profile => profile.samples[index].spreadX), 0.5)
  }));
  const densityTotal = aggregateSamples.reduce((sum, sample) => sum + sample.density, 0) || 1;
  aggregateSamples.forEach(sample => { sample.density /= densityTotal; });
  const targetCounts = profiles.map(profile => profile.targetCount);
  const orangeFractions = profiles.map(profile => profile.orangeFraction);
  const brickFractions = profiles.map(profile => profile.brickFraction);
  return {
    format: 'peggle-vertical-pacing-profile',
    formatVersion: 1,
    id: options.id || 'vertical-profile:alea-primary-standard:v1',
    createdAt: options.at || new Date().toISOString(),
    source: { corpusId: manifest.id, manifestSha256: sha256Value(manifest) },
    interpretation: 'Only continuous vertical density and horizontal occupancy are transferred; source compositions are not copied.',
    viewport: { width: 400, height: 600 },
    sampleCount,
    bandwidth,
    eligibleProfileCount: profiles.length,
    targetCount: {
      low: quantile(targetCounts, 0.2),
      median: quantile(targetCounts, 0.5),
      high: quantile(targetCounts, 0.8)
    },
    orangeFraction: {
      low: quantile(orangeFractions, 0.2),
      median: quantile(orangeFractions, 0.5),
      high: quantile(orangeFractions, 0.8)
    },
    brickFraction: {
      low: quantile(brickFractions, 0.2),
      median: quantile(brickFractions, 0.5),
      high: quantile(brickFractions, 0.8)
    },
    aggregateSamples,
    profiles
  };
}
