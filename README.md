# Peggle

Mobile-first browser game inspired by Peggle, with a touch-friendly level editor.

Play the deployed build at [alea.sh](https://alea.sh). The repository is [nanohit/peggle](https://github.com/nanohit/peggle).

## App

- `player.html` — player for baked levels, named levels, and campaigns.
- `editor.html` — create, test, bake, import, and export levels.
- `player.html#<baked-level>` or `player.html?level=<name>` — open one level.
- `player.html?campaign=<name>` — play a campaign and follow its level graph.

The editor supports grid/magnet snapping, selection and transforms, curved bricks, animations, flippers, themes, characters, dialogue, training-data export, and campaign/PvP level management.

## Gameplay

Classic Peggle gameplay includes orange targets, blue/green/purple pegs, obstacles, bumpers, portals, multiball, gamble, bomb, and magnet pegs. Levels can also use:

- Survival / vertical mode
- Billiard mode
- Destruction mode with physics-driven groups
- CPU PvP Duel; online room PvP is feature-flagged

Player progress and editor data are stored locally. Remote levels, campaigns, characters, configuration, and assets are served by Vercel Functions with Redis/Google Drive mirroring and Bunny CDN delivery with fallbacks.

## Visual branch

[`Better-Visuals`](https://github.com/nanohit/peggle/tree/Better-Visuals) is the visual-rendering track for the player:

- `NEON DROP` procedural machine skin built from CSS and Canvas2D materials.
- WebGL2 playfield with height-field geometry, deferred lighting, radiance cascades, real shadows, bloom, tone mapping, and Canvas2D fallback.
- Quality profiles, live lighting tuner, and transition-safe layer capture/reveal to prevent stale or ghost frames.
- Small Vercel shell backed by an immutable jsDelivr bundle and CDN player-data snapshots; same-origin APIs remain the fallback.

Useful branch checks and labs include `npm run test:cdn-shell`, `test/playfield-lab.html`, `test/renderer-lab.html`, `test/gpu-benchmark.html`, `test/shader-check.html`, and `test/tuner-check.html`.

```bash
git switch Better-Visuals
npm run dev
```

The branch is intentionally separate from `main` until its rendering changes are merged.

## Local development

Requirements: Node.js, npm, and Python 3.

```bash
npm install
./dev.sh
```

Open `http://localhost:8080/` for the editor or `http://localhost:8080/player.html` for the player. `dev.sh` builds and watches the player bundle, then proxies `/api/*` to the shared Vercel backend.

## Checks

```bash
npm run check
npm run test:destruction
npm run test:player-regression
npm run test:assets        # requires asset-store environment variables
```

## Structure

```text
player.html / editor.html   browser entry points
js/                         game, editor, physics, rendering, modes, data
css/                        application styles
data/player/                static player data and fallback content
api/                        Vercel API handlers
server/                     asset storage adapters
scripts/                    build, migration, backup, and smoke tools
vercel.json                 Vercel build, routing, and function config
```

The frontend is vanilla JavaScript, HTML5 Canvas, and ES modules. The production player bundle is built with esbuild.
