# Level And Character Asset Storage

This project stores image blobs outside JSON using:

- Primary origin: Bunny Storage.
- Primary delivery: Bunny Pull Zone CDN (`*.b-cdn.net` or another Bunny hostname).
- Fallback delivery: same-origin Vercel API (`/api/assets`) that reads Bunny Storage first, then Google Drive.
- Last-resort mirror: Google Drive under a separate assets folder.

Existing levels and characters are not migrated yet. This storage layer is ready for that migration.

## What Pavel Needs To Provide

### Bunny Storage

Created Bunny Storage Zone:

```text
alea-assets
```

From the Storage Zone Access page, copy:

```text
BUNNY_STORAGE_ZONE=alea-assets
BUNNY_STORAGE_ACCESS_KEY=<storage-zone-password>
```

Pick the correct HTTP API endpoint for the storage zone primary region. Bunny's default Frankfurt endpoint is:

```text
BUNNY_STORAGE_ENDPOINT=https://storage.bunnycdn.com
```

Other Bunny endpoints include `uk.storage.bunnycdn.com`, `ny.storage.bunnycdn.com`, `la.storage.bunnycdn.com`, etc. Use the endpoint shown in the Bunny dashboard for the zone.

### Bunny Pull Zone

Created Pull Zone connected to the Storage Zone as its origin:

```text
https://alea-assets.b-cdn.net
```

Set:

```text
BUNNY_CDN_BASE_URL=https://alea-assets.b-cdn.net
```

Do not touch Vercel DNS. Do not set `alea.sh` as a Bunny custom hostname because it is the production app hostname on Vercel. Do not use `assets.alea.sh` unless you later decide to add a DNS record yourself. The default Bunny `*.b-cdn.net` hostname is enough.

### Google Drive Fallback

The existing Google Drive mirror credentials are reused:

```text
GOOGLE_DRIVE_MIRROR_ENABLED=1
GOOGLE_DRIVE_CLIENT_ID=...
GOOGLE_DRIVE_CLIENT_SECRET=...
GOOGLE_DRIVE_REFRESH_TOKEN=...
GOOGLE_DRIVE_ROOT_FOLDER_NAME=Alea_Data
```

Optional folder override:

```text
GOOGLE_DRIVE_ASSETS_FOLDER_NAME=assets
```

Assets will be stored under role-specific paths:

```text
Alea_Data/assets/level-assets/<role>/<sha256>.<ext>
```

Expected roles:

```text
backgrounds
characters
pvp-portraits
survival-backgrounds
```

## Vercel Environment Variables

Set these in Vercel:

```text
BUNNY_STORAGE_ZONE=
BUNNY_STORAGE_ACCESS_KEY=
BUNNY_STORAGE_ENDPOINT=https://storage.bunnycdn.com
BUNNY_CDN_BASE_URL=
ASSET_KEY_PREFIX=level-assets

GOOGLE_DRIVE_ASSETS_FOLDER_NAME=assets
```

`ASSET_KEY_PREFIX` is optional; default is `level-assets`.

## Delivery Shape

After upload, the stored JSON field should look like:

```json
{
  "kind": "asset",
  "storageVersion": 1,
  "key": "level-assets/backgrounds/<sha256>.webp",
  "url": "https://realpeggle-assets.b-cdn.net/level-assets/backgrounds/<sha256>.webp",
  "primaryUrl": "https://realpeggle-assets.b-cdn.net/level-assets/backgrounds/<sha256>.webp",
  "fallbackUrl": "/api/assets?key=level-assets%2Fbackgrounds%2F<sha256>.webp"
}
```

Runtime should try:

1. `asset.primaryUrl` / `asset.url` from Bunny CDN.
2. `asset.fallbackUrl` from Vercel API if the CDN request fails.
3. Legacy inline data URL while old content is still unmigrated.

## API

Upload one image:

```bash
curl -X POST "https://alea.sh/api/assets" \
  -H "Content-Type: application/json" \
  --data '{"dataUrl":"data:image/webp;base64,...","role":"backgrounds"}'
```

Read through the Vercel fallback path:

```bash
curl -I "https://alea.sh/api/assets?key=level-assets/backgrounds/<sha256>.webp"
```

Force Google Drive fallback:

```bash
curl -I "https://alea.sh/api/assets?key=level-assets/backgrounds/<sha256>.webp&source=drive"
```

Check configuration without exposing secrets:

```bash
curl "https://alea.sh/api/assets?status=1"
```

Local smoke check after env setup:

```bash
npm run test:assets
```

## Vercel Load After Migration

At 1000 players visiting 5 times/day:

```text
150,000 visits/month
```

Image blobs should be served by Bunny CDN, not Vercel. Vercel still serves:

- `player.html`.
- `js/player-bootstrap.js` and its browser ES module graph in the current production setup.
- CSS/static UI assets still referenced by the app.
- JSON/API without inline images.
- Character, campaign, level, config, and PvP room APIs.
- `/api/assets` only when Bunny CDN fails or a user/client cannot reach it.

Campaign progress is localStorage-only in the current player, so it is not regular Vercel API traffic.

Measured current production payloads:

```text
primary initial campaign: 75.8 KB gzip now, about 3.8 KB gzip after image refs
primary full campaign: 1575.6 KB gzip now, about 173.5 KB gzip after image refs
character-2 subset: 389.9 KB gzip now, about 1.1 KB gzip after image refs
full character registry: 911.0 KB gzip now, about 1.2 KB gzip after image refs
all level JSON total: 5100.7 KB gzip now, about 361.1 KB gzip after image refs
```

Measured local player shell sizes:

```text
player.html + current ES module graph + loaded CSS:
  about 345 KB brotli/gzip-class transfer for a cold initial visit

player shell + level-map dynamic import + touched static UI art:
  about 843 KB brotli/gzip-class transfer for a cold full/hydrated visit
```

Vercel has separate request limits:

- Edge Requests: every request that reaches Vercel's edge network, including static assets and cached API responses.
- Function Invocations: only when a Vercel Function actually runs. A cached API response still counts as an Edge Request, but should not count as a Function Invocation.

Observed production cache behavior:

```text
/api/campaigns?primary=true&initial=true:
  Cache-Control: no-store
  x-vercel-cache: MISS, MISS
  likely invocation every visit

/api/campaigns?primary=true&initial=true&player=1:
  x-vercel-cache: MISS, then HIT

/api/campaigns?primary=true&resolve=true&player=1:
  x-vercel-cache: MISS, then HIT

/api/characters?ids=character-2&player=1:
  x-vercel-cache: MISS, then HIT
```

So player API GETs must include `player=1` to keep invocations low. `player.html` now preloads the primary initial campaign with `player=1`; otherwise that one request would invoke a function on every visit.

With 1000 returning players, static app assets should be cached by the browser after the first visit per player. Under that realistic model:

```text
initial-only path:
  static once/player + thin initial APIs each visit
  about 2.5 GB/month
  about 0.35M-0.65M Edge Requests/month
  about 40k-80k Function Invocations/month for cacheable player API keys,
  assuming steady traffic and one active CDN cache layer

full campaign hydration path:
  static once/player + thin full campaign/character APIs each visit
  about 27 GB/month
  about 0.52M-0.81M Edge Requests/month
  about 65k-110k Function Invocations/month for cacheable player API keys,
  assuming steady traffic and one active CDN cache layer
```

Worst-case cold cache on every visit is very different:

```text
cold initial every visit:
  about 53 GB/month
  about 7.5M Edge Requests/month
  Function Invocations stay low for cacheable player API keys,
  but static/browser-cache misses still burn Edge Requests

cold full hydration every visit:
  about 150 GB/month
  about 9.75M Edge Requests/month
  Function Invocations stay low for cacheable player API keys,
  but static/browser-cache misses still burn Edge Requests
```

PvP polling is its own multiplier and is not cacheable. These requests count as both Edge Requests and Function Invocations. Current polling intervals include 3s while waiting, 750ms after submitted aim, 1.2s while waiting for results, plus a 15s heartbeat. A small 2 KB poll payload still adds:

```text
60 polls/visit:
  about 17 GB/month
  about 9M Edge Requests/month
  about 9M Function Invocations/month

180 polls/visit:
  about 52 GB/month
  about 27M Edge Requests/month
  about 27M Function Invocations/month
```

So the Bunny design fits the Vercel free tier for normal returning non-PvP traffic. The likely wall is Edge Requests, not Function Invocations, as long as player GET APIs use `player=1`. PvP polling can exceed both request limits quickly because it bypasses cache by design.

## Next Migration Step

Migrate image fields in two tracks.

### Level Background Fields

```text
visuals.background.image
visuals.background.progressionImage
survival.background.image
visuals.slots.character.customSrc
```

### Character Registry Fields

```text
characters.<id>.slots.<slot>
characters.<id>.slots.<slot>[]
characters.<id>.pvpPortraits.<slot>
```

Character images are stored separately from levels in `/api/characters`, but levels can reference a character by ID and can carry a small reference snapshot. Player APIs already strip full `character.snapshot.slots` and `character.snapshot.emotions` from levels, so the main character payload to slim down is the registry itself.

Saving should compress the image first, upload it through `/api/assets`, then store the returned `asset` object in the level or character JSON.
