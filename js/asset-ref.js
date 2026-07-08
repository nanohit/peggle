const REMOTE_API_ORIGIN = 'https://peggle.vercel.app';

// Some ISPs (notably consumer providers in Russia) blackhole the Bunny CDN
// hostname: connections hang without an error, so <img> fallback chains stall
// for the browser's full connect timeout on every asset. A cheap reachability
// probe per CDN origin reorders candidates: healthy CDNs/mirrors first; the
// Vercel-served /api/assets fallback is a strict last resort (it costs paid
// function invocations + bandwidth), tried only after every CDN and mirror
// front; known-unreachable origins go last.
const CDN_HEALTH_STORAGE_KEY = 'peggle_cdn_health_v2';
const CDN_PROBE_TIMEOUT_MS = 4000;
const CDN_HEALTH_TTL_MS = 5 * 60 * 1000;
const IMAGE_CANDIDATE_TIMEOUT_MS = 8000;
// Happy-eyeballs stagger: if the leading candidate hasn't answered in this
// window, the next one starts in parallel — first success wins, losers are
// cancelled. A blackholed CDN then costs one stagger step instead of a
// multi-second timeout on every asset.
const IMAGE_RACE_STAGGER_MS = 650;
// The /api/assets candidate does NOT join the race on the normal stagger:
// while any CDN/mirror attempt is still in flight it waits this extra grace
// period, so a merely-slow jsDelivr response doesn't burn a Vercel request.
// It still starts immediately once every earlier candidate has hard-failed.
const API_RACE_EXTRA_DELAY_MS = 1800;

// Alternative delivery fronts for the same content. For every candidate on
// the blocked-prone default hostname, alias candidates with the same asset
// path are inserted right after it: cdn.alea.sh pins Bunny EU edge IPs;
// jsDelivr and GitHub Pages serve the public nanohit/alea-assets mirror
// (synced via scripts/mirror-assets-to-github.mjs). Per-origin health probes
// rank whichever fronts are reachable first, so dead ones cost nothing.
const CDN_ALIAS_ORIGINS = {
  'https://alea-assets.b-cdn.net': [
    'https://cdn.alea.sh',
    'https://cdn.jsdelivr.net/gh/nanohit/alea-assets@main',
    'https://nanohit.me/alea-assets'
  ]
};

// Russian residential ISPs blackhole Bunny's edge IPs (b-cdn.net AND the
// pinned cdn.alea.sh alias — the block is by IP, not hostname). Until a live
// probe verdict exists, clients that look like they're on a Russian network
// skip those origins in favor of the jsDelivr/GitHub-Pages mirrors, so the
// first session never waits out a blackholed connection. A probe that later
// proves Bunny reachable (VPN, unblocked ISP) restores it to the front.
const RU_SUSPECT_ORIGINS = new Set([
  'https://alea-assets.b-cdn.net',
  'https://cdn.alea.sh'
]);

const RU_TIMEZONES = new Set([
  'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Simferopol', 'Europe/Volgograd',
  'Europe/Kirov', 'Europe/Astrakhan', 'Europe/Saratov', 'Europe/Ulyanovsk',
  'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk', 'Asia/Novosibirsk',
  'Asia/Barnaul', 'Asia/Tomsk', 'Asia/Novokuznetsk', 'Asia/Krasnoyarsk',
  'Asia/Irkutsk', 'Asia/Chita', 'Asia/Yakutsk', 'Asia/Khandyga',
  'Asia/Vladivostok', 'Asia/Ust-Nera', 'Asia/Magadan', 'Asia/Sakhalin',
  'Asia/Srednekolymsk', 'Asia/Kamchatka', 'Asia/Anadyr'
]);

let likelyRuClientCached = null;
function isLikelyRuClient() {
  if (likelyRuClientCached !== null) return likelyRuClientCached;
  let ru = false;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (RU_TIMEZONES.has(tz)) ru = true;
  } catch { /* Intl unavailable */ }
  if (!ru) {
    try {
      const langs = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || [];
      ru = langs.some(lang => /^ru\b/i.test(String(lang || '')));
    } catch { /* navigator unavailable */ }
  }
  likelyRuClientCached = ru;
  return ru;
}

const cdnHealthByOrigin = new Map(); // origin -> { status: 'ok'|'down', checkedAt }
const cdnProbesInFlight = new Set();

function loadPersistedCdnHealth() {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(CDN_HEALTH_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const origins = data && typeof data.origins === 'object' ? data.origins : null;
    if (!origins) return;
    for (const [origin, entry] of Object.entries(origins)) {
      if (!entry || (entry.status !== 'ok' && entry.status !== 'down')) continue;
      cdnHealthByOrigin.set(origin, {
        status: entry.status,
        checkedAt: Number(entry.checkedAt) || 0
      });
    }
  } catch { /* storage unavailable */ }
}

loadPersistedCdnHealth();

function persistCdnHealth() {
  try {
    const origins = {};
    for (const [origin, entry] of cdnHealthByOrigin) origins[origin] = entry;
    localStorage.setItem(CDN_HEALTH_STORAGE_KEY, JSON.stringify({ origins }));
  } catch { /* storage unavailable */ }
}

function urlOrigin(url) {
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://alea.sh/';
    return new URL(url, base).origin;
  } catch {
    return '';
  }
}

function isLocalAssetUrl(url) {
  if (typeof url !== 'string' || !url) return true;
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (typeof location === 'undefined') return true;
  const origin = urlOrigin(url);
  return !origin || origin === 'null' || origin === location.origin;
}

// The Vercel-served asset fallback. Matched by path, not origin: on prod it
// is same-origin '/api/assets?...', in dev resolveApiPath rewrites it to the
// remote API origin — both must rank as the paid last resort.
function isApiFallbackUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('data:') || url.startsWith('blob:')) return false;
  try {
    const base = typeof location !== 'undefined' ? location.href : 'https://alea.sh/';
    return new URL(url, base).pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

// Fired on every probe verdict so in-flight image loads against a
// just-declared-dead origin can bail out immediately instead of waiting
// out their own timeout.
const cdnHealthListeners = new Set();

function noteCdnReachability(origin, reachable) {
  if (!origin) return;
  const status = reachable ? 'ok' : 'down';
  cdnHealthByOrigin.set(origin, { status, checkedAt: Date.now() });
  persistCdnHealth();
  for (const listener of [...cdnHealthListeners]) {
    try { listener(origin, status); } catch { /* listener errors must not break probes */ }
  }
}

function getOriginStatus(origin) {
  const entry = cdnHealthByOrigin.get(origin);
  return entry ? entry.status : 'unknown';
}

function ensureCdnProbe(origin) {
  if (!origin || cdnProbesInFlight.has(origin)) return;
  if (typeof fetch !== 'function' || typeof AbortController !== 'function') return;
  const entry = cdnHealthByOrigin.get(origin);
  if (entry && (Date.now() - entry.checkedAt) < CDN_HEALTH_TTL_MS) return;
  cdnProbesInFlight.add(origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_PROBE_TIMEOUT_MS);
  // no-cors: an opaque response (even a 404) still proves the host answers;
  // a blackholed connection aborts on the timer instead.
  fetch(`${origin}/`, { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
    .then(() => noteCdnReachability(origin, true))
    .catch(() => noteCdnReachability(origin, false))
    .finally(() => {
      clearTimeout(timer);
      cdnProbesInFlight.delete(origin);
    });
}

export function getCdnHealthStatus() {
  const origins = {};
  for (const [origin, entry] of cdnHealthByOrigin) origins[origin] = { ...entry };
  return { origins };
}

// Probe every known delivery front at startup instead of lazily on the first
// asset reference: verdicts are usually in before gameplay assets are even
// requested, so candidate ordering is correct from the first real load.
// ensureCdnProbe respects the persisted TTL, so this is at most one tiny
// no-cors request per origin per 5 minutes.
function warmKnownCdnProbes() {
  if (typeof location === 'undefined' || typeof fetch !== 'function') return;
  const origins = new Set();
  for (const [origin, bases] of Object.entries(CDN_ALIAS_ORIGINS)) {
    origins.add(origin);
    for (const base of bases) origins.add(urlOrigin(base));
  }
  for (const origin of origins) {
    if (origin && origin !== location.origin) ensureCdnProbe(origin);
  }
}

warmKnownCdnProbes();

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isLocalHost(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function resolveApiPath(path) {
  const value = String(path || '').trim();
  if (!value.startsWith('/api/')) return value;
  if (typeof window !== 'undefined' && typeof window.__PEGGLE_API_BASE__ === 'string') {
    return `${window.__PEGGLE_API_BASE__.replace(/\/$/, '')}${value.slice(4)}`;
  }
  if (typeof location !== 'undefined' && (location.protocol === 'file:' || isLocalHost(location.hostname))) {
    return `${REMOTE_API_ORIGIN}${value}`;
  }
  return value;
}

function cleanUrl(value) {
  if (typeof value !== 'string') return '';
  return resolveApiPath(value.trim());
}

function cleanAssetKey(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
}

function fallbackUrlForKey(key, source = '') {
  const normalized = cleanAssetKey(key);
  if (!normalized) return '';
  const params = new URLSearchParams({ key: normalized });
  if (source) params.set('source', source);
  return resolveApiPath(`/api/assets?${params.toString()}`);
}

export function isAssetReference(value) {
  if (!isPlainObject(value)) return false;
  if (value.kind === 'asset') return true;
  return !!(
    value.storageVersion
    || value.key
    || value.primaryUrl
    || value.fallbackUrl
    || value.url
  );
}

export function normalizeAssetReference(value) {
  if (!isAssetReference(value)) return null;
  const key = cleanAssetKey(value.key);
  const primaryUrl = cleanUrl(value.primaryUrl || value.url);
  const fallbackUrl = cleanUrl(value.fallbackUrl) || fallbackUrlForKey(key);
  const url = cleanUrl(value.url || primaryUrl) || primaryUrl || fallbackUrl;
  if (!url && !primaryUrl && !fallbackUrl && !key) return null;
  return {
    kind: 'asset',
    storageVersion: Number.isFinite(value.storageVersion) ? value.storageVersion : 1,
    ...(key ? { key } : {}),
    ...(typeof value.hash === 'string' && value.hash ? { hash: value.hash } : {}),
    ...(Number.isFinite(value.bytes) ? { bytes: value.bytes } : {}),
    ...(typeof value.contentType === 'string' && value.contentType ? { contentType: value.contentType } : {}),
    ...(url ? { url } : {}),
    ...(primaryUrl ? { primaryUrl } : {}),
    ...(fallbackUrl ? { fallbackUrl } : {})
  };
}

export function normalizeAssetImageValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return normalizeAssetReference(value);
}

export function isAssetImageSource(value) {
  return !!normalizeAssetImageValue(value);
}

function withCdnAliases(urls) {
  const expanded = [];
  for (const url of urls) {
    expanded.push(url);
    for (const [origin, bases] of Object.entries(CDN_ALIAS_ORIGINS)) {
      if (!url.startsWith(`${origin}/`)) continue;
      for (const base of bases) expanded.push(base + url.slice(origin.length));
    }
  }
  return [...new Set(expanded)];
}

// 0 = inline data/blob or a remote origin probed alive, 1 = unprobed
// CDN/mirror (benefit of the doubt), 2 = the Vercel /api/assets fallback —
// strictly after every CDN and mirror front, 3 = unprobed origin that RU
// networks are known to blackhole (a worse bet than the paid fallback),
// 4 = remote known unreachable. Stable within each rank.
function candidateRank(url) {
  if (typeof url === 'string' && (url.startsWith('data:') || url.startsWith('blob:'))) return 0;
  if (isApiFallbackUrl(url) || isLocalAssetUrl(url)) return 2;
  const origin = urlOrigin(url);
  const status = getOriginStatus(origin);
  if (status === 'down') return 4;
  if (status === 'ok') return 0;
  if (RU_SUSPECT_ORIGINS.has(origin) && isLikelyRuClient()) return 3;
  return 1;
}

export function assetUrlCandidates(value) {
  if (typeof value === 'string') {
    const url = cleanUrl(value);
    return url ? [url] : [];
  }
  const asset = normalizeAssetReference(value);
  if (!asset) return [];
  const candidates = withCdnAliases([...new Set([
    asset.primaryUrl,
    asset.url,
    asset.fallbackUrl,
    asset.key ? fallbackUrlForKey(asset.key) : ''
  ].map(cleanUrl).filter(Boolean))]);
  const remoteOrigins = [...new Set(
    candidates.filter(url => !isLocalAssetUrl(url)).map(urlOrigin).filter(Boolean)
  )];
  if (!remoteOrigins.length) return candidates;
  for (const origin of remoteOrigins) ensureCdnProbe(origin);
  return candidates
    .map((url, index) => ({ url, index, rank: candidateRank(url) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.url);
}

export function assetPrimaryUrl(value) {
  return assetUrlCandidates(value)[0] || '';
}

export function assetCacheKey(value) {
  if (typeof value === 'string') return cleanUrl(value);
  const asset = normalizeAssetReference(value);
  if (!asset) return '';
  return asset.key || asset.primaryUrl || asset.url || asset.fallbackUrl || JSON.stringify(asset);
}

function loadOneImage(url, crossOrigin, timeoutMs, registerCancel) {
  return new Promise(resolve => {
    let settled = false;
    let timer = 0;
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    const remoteOrigin = isLocalAssetUrl(url) ? '' : urlOrigin(url);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (remoteOrigin) cdnHealthListeners.delete(onHealthChange);
      if (!ok) {
        // Cancel the pending request: frees the socket and stops the
        // browser's page-loading spinner from hanging on a blackholed host.
        try { img.src = ''; } catch { /* ignore */ }
      }
      resolve(ok ? img : null);
    };
    const onHealthChange = (origin, status) => {
      if (origin === remoteOrigin && status === 'down') finish(false);
    };
    if (remoteOrigin) cdnHealthListeners.add(onHealthChange);
    if (typeof registerCancel === 'function') registerCancel(() => finish(false));
    // The timeout is what makes fallback usable on blackholing ISPs: a hung
    // candidate would otherwise stall the chain for the browser's own
    // multi-minute connect timeout.
    timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

// A successful asset load is itself a health verdict — refresh it so the
// ordering stays warm without waiting for the next probe cycle. Throttled to
// avoid a localStorage write per image.
function noteOriginAliveFromAssetLoad(url) {
  if (isLocalAssetUrl(url) || isApiFallbackUrl(url)) return;
  const origin = urlOrigin(url);
  if (!origin) return;
  const entry = cdnHealthByOrigin.get(origin);
  if (entry && entry.status === 'ok' && (Date.now() - entry.checkedAt) < CDN_HEALTH_TTL_MS / 2) return;
  noteCdnReachability(origin, true);
}

// Staggered parallel race over the ranked candidate list (happy eyeballs):
// candidate N+1 starts IMAGE_RACE_STAGGER_MS after N unless N already
// answered; any failure pulls the next candidate in immediately; the first
// success wins and cancels the rest. Known-dead origins are skipped outright
// unless they are the final fallback. The /api/assets candidate is held back
// while any CDN/mirror attempt is still pending until API_RACE_EXTRA_DELAY_MS
// has passed — Vercel only pays when the free fronts fail or truly stall.
function raceImageCandidates(candidates, crossOrigin, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let nextIndex = 0;
    let pending = 0;
    let staggerTimer = 0;
    let lastSkippedUrl = null;
    let lastResortTried = false;
    let apiDeferUntil = 0;
    const cancels = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(staggerTimer);
      for (const cancel of cancels) {
        try { cancel(); } catch { /* ignore */ }
      }
      resolve(result);
    };

    const launch = (url) => {
      pending++;
      loadOneImage(url, crossOrigin, timeoutMs, cancel => cancels.push(cancel)).then(img => {
        pending--;
        if (settled) return;
        if (img) {
          noteOriginAliveFromAssetLoad(url);
          finish({ img, url });
          return;
        }
        if (nextIndex < candidates.length) {
          startNext();
        } else if (pending === 0) {
          handleExhausted();
        }
      });
    };

    // Every candidate either failed or was skipped as known-dead. Before
    // giving up, try one skipped origin anyway — health data can be stale.
    const handleExhausted = () => {
      if (settled) return;
      if (lastSkippedUrl && !lastResortTried) {
        lastResortTried = true;
        launch(lastSkippedUrl);
        return;
      }
      finish(null);
    };

    const scheduleStagger = () => {
      if (settled || nextIndex >= candidates.length) return;
      clearTimeout(staggerTimer);
      staggerTimer = setTimeout(startNext, IMAGE_RACE_STAGGER_MS);
    };

    const startNext = () => {
      if (settled) return;
      while (nextIndex < candidates.length) {
        const url = candidates[nextIndex];
        if (isApiFallbackUrl(url) && pending > 0) {
          const now = Date.now();
          if (!apiDeferUntil) apiDeferUntil = now + API_RACE_EXTRA_DELAY_MS;
          if (now < apiDeferUntil) {
            clearTimeout(staggerTimer);
            staggerTimer = setTimeout(startNext, apiDeferUntil - now);
            return;
          }
        }
        nextIndex++;
        if (!isLocalAssetUrl(url) && getOriginStatus(urlOrigin(url)) === 'down') {
          lastSkippedUrl = url;
          continue;
        }
        launch(url);
        scheduleStagger();
        return;
      }
      if (pending === 0) handleExhausted();
    };

    startNext();
  });
}

const imageResultCache = new Map();

// Walks assetUrlCandidates(value) in order and resolves with the first image
// that loads: { img, url } or null. Successes are cached per asset+crossOrigin;
// failures are not, so a later call retries (possibly with reordered candidates
// once the CDN probe has settled).
export function loadImageFromCandidates(value, options = {}) {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  const crossOrigin = options.crossOrigin || '';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : IMAGE_CANDIDATE_TIMEOUT_MS;
  const cacheKey = `${crossOrigin}|${assetCacheKey(value)}`;
  const cached = imageResultCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const candidates = assetUrlCandidates(value);
    if (candidates.length === 0) return null;
    return await raceImageCandidates(candidates, crossOrigin, timeoutMs);
  })();
  imageResultCache.set(cacheKey, promise);
  promise.then(result => {
    if (!result) imageResultCache.delete(cacheKey);
  }, () => imageResultCache.delete(cacheKey));
  return promise;
}

export function assetCssUrl(value) {
  const url = assetPrimaryUrl(value);
  return url ? `url("${url.replace(/"/g, '\\"')}")` : '';
}

export function assetDisplayUrl(value) {
  return assetPrimaryUrl(value);
}
