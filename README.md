# Peggle Level Editor

A mobile-first browser-based Peggle clone with a built-in level editor designed for creating training data for procedural level generation.

## Quick Start

1. Open `index.html` in a browser, or serve with any HTTP server:
   ```bash
   python3 -m http.server 8080
   ```
2. Navigate to `http://localhost:8080`

## Features

### Level Editor
- **Tap to place pegs** - Tap anywhere on the canvas to place a peg
- **5 peg types**: 
  - Orange (must hit to win)
  - Blue (normal scoring)
  - Green (special power)
  - Purple (bonus points)
  - Obstacle (doesn't disappear when hit)
- **2 shapes**: Circle and Brick (rectangle)
- **Drag to move** - Tap and drag existing pegs to reposition
- **Marquee selection** - Drag to select multiple pegs at once
- **Rotation** - Press R to rotate selected pegs or bricks
- **Grid snap** - Toggle grid overlay and snapping for precise placement
- **Undo/Redo** - Full undo/redo support (Ctrl+Z / Ctrl+Shift+Z)
- **Mirror tools** - Mirror selected pegs horizontally or vertically
- **Duplicate** - Duplicate selected pegs with offset

### Play Mode
- Press the **Play button (▶)** to test your level
- **Aim** by touching/clicking and dragging
- **Trajectory preview** shows where the ball will go (up to first hit)
- **Release** to launch the ball
- Hit all **orange pegs** to win
- **Pegs disappear after the turn ends** (not instantly)
- **Bucket catch** gives you a free ball
- **Obstacles stay** - they don't disappear when hit

### Physics Controls
Access via Menu → Physics Settings:
- **Gravity** - How fast the ball falls (0.01 - 0.50)
- **Bounce** - How bouncy collisions are (0.20 - 0.95)
- **Speed** - Game speed multiplier (0.25 - 2.00)
- **Peg Size** - Size of pegs and ball (5 - 20)
- **Launch Power** - Initial ball velocity (4 - 16)
- **Full Trajectory** - Debug mode showing complete ball path

### Level Management
- Create multiple levels
- Set difficulty (1-5)
- Add levels to training data set
- Export individual levels as JSON
- Import levels from JSON
- Export all training data for ML analysis

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `P` | Toggle Play/Edit mode |
| `G` | Toggle grid |
| `S` | Toggle snap to grid |
| `R` | Rotate selected pegs +15° |
| `Shift+R` | Rotate selected pegs -15° |
| `Delete` | Delete selected pegs |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Ctrl+A` | Select all pegs |
| `Escape` | Deselect all |

## Level Data Format (ML-Ready)

```json
{
  "version": 1,
  "id": "unique-id",
  "name": "Level Name",
  "difficulty": 3,
  "tags": ["symmetric", "dense-center"],
  "pegs": [
    {
      "id": "peg-id",
      "type": "orange",
      "x": 200,
      "y": 300,
      "angle": 0,
      "shape": "circle",
      "groupId": null
    },
    {
      "id": "brick-id",
      "type": "obstacle",
      "x": 150,
      "y": 400,
      "angle": 0.5,
      "shape": "brick",
      "width": 40,
      "height": 12,
      "groupId": null
    }
  ],
  "groups": [],
  "metadata": {
    "created": "2026-01-31",
    "modified": "2026-01-31T12:00:00.000Z",
    "playCount": 0,
    "avgCompletionRate": null,
    "authorNotes": ""
  }
}
```

## Architecture

```
realpeggle/
├── index.html          # Single entry point
├── css/
│   └── styles.css      # Mobile-first styles
├── js/
│   ├── main.js         # App initialization & UI
│   ├── physics.js      # Custom physics engine
│   ├── renderer.js     # Canvas rendering
│   ├── editor.js       # Level editor logic
│   ├── game.js         # Game loop & mechanics
│   ├── levels.js       # Level management
│   └── utils.js        # Math & collision helpers
└── data/
    └── training/       # Exported training data
```

## Game Mechanics

### Canvas Size
- Fixed 3:4.5 aspect ratio (portrait)
- Maximum width: 400px
- Centered in viewport

### Physics
- Custom lightweight physics engine
- Circle-circle collision for round pegs
- Circle-rectangle collision for brick pegs (with rotation)
- Configurable gravity, bounce, and speed
- Wall bouncing on all sides
- Moving bucket at bottom

### Peg Behavior
- Pegs light up when hit but stay visible
- All hit pegs disappear when ball falls/caught
- Obstacles never disappear (permanent)
- Score multiplier increases as orange pegs decrease

## Future: Procedural Generation

The data structure is designed to support future ML-based level generation:

1. **Phase 1 (Current)**: Manual level creation with shapes, obstacles, and physics tuning
2. **Phase 2**: Pattern extraction from human-designed levels
3. **Phase 3**: Constraint-based generation with learned rules
4. **Phase 4**: ML model (VAE/GAN) for generating level variations

### ML-Ready Features
- `peg.shape` - Circle or brick for variety
- `peg.angle` - Rotation for brick pegs
- `peg.type` - Including obstacles for complexity
- `level.tags[]` - Supervised pattern labels
- `level.groups[]` - Structural annotations
- `level.metadata.playCount` - Engagement tracking
- `level.metadata.avgCompletionRate` - Difficulty validation

## Tech Stack

- Vanilla JS + HTML5 Canvas
- Zero dependencies (~20KB total)
- Custom lightweight physics engine
- localStorage for persistence
- ES6 modules
