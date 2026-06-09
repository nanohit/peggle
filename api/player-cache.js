const DEFAULT_PLAYER_CACHE_TTL_SECONDS = 120;
const DEFAULT_PLAYER_CACHE_STALE_SECONDS = 600;

export function isPlayerCacheRequest(req) {
  const player = req?.query?.player;
  const cache = req?.query?.cache;
  return player === '1' || player === 'true' || cache === 'player';
}

export function setPlayerAwareCache(req, res, options = {}) {
  if (!isPlayerCacheRequest(req)) {
    res.setHeader('Cache-Control', 'no-store');
    return;
  }

  const ttl = Number.isFinite(options.ttlSeconds)
    ? Math.max(1, Math.floor(options.ttlSeconds))
    : DEFAULT_PLAYER_CACHE_TTL_SECONDS;
  const stale = Number.isFinite(options.staleSeconds)
    ? Math.max(0, Math.floor(options.staleSeconds))
    : DEFAULT_PLAYER_CACHE_STALE_SECONDS;
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${stale}`);
}
