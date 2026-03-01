// Peggle Editor - Level editor logic

import { Renderer } from './renderer.js';
import { LevelManager } from './levels.js';
import { Utils } from './utils.js';
import { PHYSICS_CONFIG } from './physics.js';
import {
  PegAnimator,
  MIN_VISIBLE_RATIO,
  ANIMATION_WRAP_VISIBLE_RATIO,
  estimatePegExtents,
  resolveWrappedMotion,
  wrapPointWithVisibility,
  mirrorWrapTrace
} from './animation.js';

export class Editor {
  constructor(canvas, levelManager) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas);
    this.levelManager = levelManager;
    
    // Editor state
    this.selectedPegType = 'blue';
    this.selectedShape = 'circle';
    this.selectedPegIds = new Set();
    this.mode = 'place'; // place, select, draw
    
    // Grid settings
    this.showGrid = true;
    this.snapToGrid = false;
    this.gridSize = 20;
    
    // Interaction state
    this.isInteracting = false;
    this.interactionType = null; // 'marquee', 'drag', 'rotate', 'draw', 'place'
    this.startX = 0;
    this.startY = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.dragPegId = null;
    this.selectionBox = null;
    this.hasMoved = false;
    this.dragStartPositions = null;
    this.dragAnchorId = null;
    
    // Alt-drag copy
    this.isCopying = false;
    
    // Draw mode state
    this.drawPath = [];
    this.ghostBricks = [];
    this.drawShapeMode = 'free'; // 'free', 'circle', 'sine'
    
    // Rotation state
    this.rotationCenter = null;
    this.rotationStartAngle = 0;
    
    // Rotation for new bricks
    this.currentRotation = 0;

    // Animation mode
    this.animationMode = false;
    this.animationTarget = null;       // { type: 'peg'|'group', id }
    this.animationGhostOffset = null;  // { dx, dy }
    this.animationRotation = 0;        // radians
    this.animationDuration = 2;
    this.animationEasing = 'easeInOut';
    this.animationInverse = false;
    this.animationCycle = false;
    this.animationPreview = false;
    this.animationPreviewAnimator = null;
    this.onAnimationOffsetChange = null; // callback for slider sync

    // Undo/Redo
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndoSteps = 50;
    
    // Animation
    this.animationId = null;

    // Listener cleanup
    this.abortController = new AbortController();

    // Callbacks
    this.onPegCountChange = null;
    this.onSelectionChange = null;
    this.onGridChange = null;
    this.onSnapChange = null;
    
    this.setupInput();
  }

  setupInput() {
    const canvas = this.canvas;
    
    const handleStart = (e) => {
      e.preventDefault();
      const pos = this.getEventPosition(e);

      // Animation mode: only handle ghost drag (hit any ghost peg)
      if (this.animationMode) {
        if (this.animationGhostOffset) {
          const ghosts = this.getAnimationGhosts();
          let nearGhost = false;
          for (const g of ghosts) {
            if (Utils.distance(pos.x, pos.y, g.x, g.y) < 20) {
              nearGhost = true;
              break;
            }
          }
          if (nearGhost) {
            this.isInteracting = true;
            this.interactionType = 'animDrag';
            this.startX = pos.x;
            this.startY = pos.y;
            this._animDragStart = { dx: this.animationGhostOffset.dx, dy: this.animationGhostOffset.dy };
          }
        }
        return;
      }

      this.startX = pos.x;
      this.startY = pos.y;
      this.lastX = pos.x;
      this.lastY = pos.y;
      this.hasMoved = false;
      this.isInteracting = true;
      this.isCopying = e.altKey;

      // Check if clicking on rotation handle first
      if (this.selectedPegIds.size > 0) {
        const handle = this.getRotationHandlePosition();
        if (handle && Utils.distance(pos.x, pos.y, handle.x, handle.y) < 15) {
          this.interactionType = 'rotate';
          this.rotationCenter = this.getSelectionCenter();
          this.rotationStartAngle = Utils.angleBetween(
            this.rotationCenter.x, this.rotationCenter.y, pos.x, pos.y
          );
          this.saveUndoState();
          return;
        }
      }
      
      // Check if clicking on existing peg
      const peg = this.getPegAtPosition(pos.x, pos.y);
      
      if (peg) {
        this.dragPegId = peg.id;
        
        // Handle selection
        if (!this.selectedPegIds.has(peg.id)) {
          if (!e.shiftKey) {
            this.selectedPegIds.clear();
          }
          this.selectedPegIds.add(peg.id);
          this.notifySelectionChange();
        }
        
        // Alt+drag = copy
        if (this.isCopying) {
          this.saveUndoState();
          this.duplicateSelectedPegsInPlace();
        } else {
          this.saveUndoState();
        }
        
        this.interactionType = 'drag';
        this.captureDragStartPositions();
      } else {
        // Clicking on empty space
        if (this.mode === 'select') {
          // Always marquee in select mode
          this.interactionType = 'marquee';
          this.selectionBox = {
            startX: pos.x,
            startY: pos.y,
            endX: pos.x,
            endY: pos.y
          };
          if (!e.shiftKey) {
            this.selectedPegIds.clear();
            this.notifySelectionChange();
          }
        } else if (this.mode === 'draw') {
          // Draw mode - works for circles and bricks
          this.interactionType = 'draw';
          this.drawPath = [{ x: pos.x, y: pos.y }];
          this.ghostBricks = [];
        } else {
          // Place mode - will place on release if no movement
          this.interactionType = 'place';
        }
      }
    };

    const handleMove = (e) => {
      if (!this.isInteracting) return;
      e.preventDefault();
      
      const pos = this.getEventPosition(e);
      const dx = pos.x - this.lastX;
      const dy = pos.y - this.lastY;
      const totalDx = pos.x - this.startX;
      const totalDy = pos.y - this.startY;
      
      if (Math.abs(totalDx) > 3 || Math.abs(totalDy) > 3) {
        this.hasMoved = true;
      }
      
      switch (this.interactionType) {
        case 'animDrag':
          if (this._animDragStart) {
            let nextDx = this._animDragStart.dx + totalDx;
            let nextDy = this._animDragStart.dy + totalDy;
            if (e.shiftKey) {
              const mag = Math.hypot(nextDx, nextDy);
              if (mag > 0.001) {
                const snapStep = Math.PI / 18; // 10°
                const snapped = Math.round(Math.atan2(nextDy, nextDx) / snapStep) * snapStep;
                nextDx = Math.cos(snapped) * mag;
                nextDy = Math.sin(snapped) * mag;
              }
            }
            this.animationGhostOffset = {
              dx: nextDx,
              dy: nextDy
            };
            if (this.onAnimationOffsetChange) {
              this.onAnimationOffsetChange(this.animationGhostOffset);
            }
          }
          break;

        case 'rotate':
          if (this.rotationCenter) {
            const currentAngle = Utils.angleBetween(
              this.rotationCenter.x, this.rotationCenter.y, pos.x, pos.y
            );
            const deltaAngle = currentAngle - this.rotationStartAngle;
            this.rotateSelectedPegsAbsolute(deltaAngle);
            this.rotationStartAngle = currentAngle;
          }
          break;
          
        case 'marquee':
          this.selectionBox.endX = pos.x;
          this.selectionBox.endY = pos.y;
          break;
          
        case 'drag':
          if (this.hasMoved && this.selectedPegIds.size > 0) {
            this.moveSelectedPegs(totalDx, totalDy);
          }
          break;
          
        case 'draw':
          this.continueDraw(pos.x, pos.y, e.shiftKey);
          break;
          
        case 'place':
          // If we start moving in place mode, switch to marquee
          if (this.hasMoved) {
            this.interactionType = 'marquee';
            this.selectionBox = {
              startX: this.startX,
              startY: this.startY,
              endX: pos.x,
              endY: pos.y
            };
          }
          break;
      }
      
      this.lastX = pos.x;
      this.lastY = pos.y;
    };

    const handleEnd = (e) => {
      if (!this.isInteracting) return;
      
      const pos = this.lastX !== undefined ? { x: this.lastX, y: this.lastY } : this.getEventPosition(e);
      
      switch (this.interactionType) {
        case 'animDrag':
          this._animDragStart = null;
          break;

        case 'rotate':
          this.levelManager.save();
          break;
          
        case 'marquee':
          if (this.selectionBox) {
            const boxWidth = Math.abs(this.selectionBox.endX - this.selectionBox.startX);
            const boxHeight = Math.abs(this.selectionBox.endY - this.selectionBox.startY);
            if (boxWidth > 5 || boxHeight > 5) {
              this.selectPegsInBox(this.selectionBox);
            }
          }
          this.selectionBox = null;
          break;
          
        case 'drag':
          this.levelManager.save();
          break;
          
        case 'draw':
          this.commitGhostBricks();
          break;
          
        case 'place':
          // Only place if we didn't move (it's a click, not a drag)
          if (!this.hasMoved) {
            this.saveUndoState();
            this.placePeg(this.startX, this.startY);
          } else if (this.selectionBox) {
            // We switched to marquee
            const boxWidth = Math.abs(this.selectionBox.endX - this.selectionBox.startX);
            const boxHeight = Math.abs(this.selectionBox.endY - this.selectionBox.startY);
            if (boxWidth > 5 || boxHeight > 5) {
              this.selectPegsInBox(this.selectionBox);
            }
            this.selectionBox = null;
          }
          break;
      }
      
      this.isInteracting = false;
      this.interactionType = null;
      this.dragPegId = null;
      this.rotationCenter = null;
      this.isCopying = false;
      this.dragStartPositions = null;
      this.dragAnchorId = null;
    };

    const sig = { signal: this.abortController.signal };

    // Touch events
    canvas.addEventListener('touchstart', handleStart, { passive: false, ...sig });
    canvas.addEventListener('touchmove', handleMove, { passive: false, ...sig });
    canvas.addEventListener('touchend', handleEnd, { passive: false, ...sig });
    canvas.addEventListener('touchcancel', handleEnd, { passive: false, ...sig });

    // Mouse events
    canvas.addEventListener('mousedown', handleStart, sig);
    canvas.addEventListener('mousemove', handleMove, sig);
    canvas.addEventListener('mouseup', handleEnd, sig);
    canvas.addEventListener('mouseleave', handleEnd, sig);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelectedPegs();
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.selectAll();
      } else if (e.key === 'Escape') {
        this.selectedPegIds.clear();
        this.notifySelectionChange();
      } else if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        this.showGrid = !this.showGrid;
        this.renderer.showGrid = this.showGrid;
        if (this.onGridChange) this.onGridChange(this.showGrid);
      } else if (e.key === 's' && !e.ctrlKey && !e.metaKey) {
        this.snapToGrid = !this.snapToGrid;
        if (this.onSnapChange) this.onSnapChange(this.snapToGrid);
      } else if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
        this.rotateSelectedPegs(Math.PI / 12);
      } else if (e.key === 'R') {
        this.rotateSelectedPegs(-Math.PI / 12);
      } else if (e.key === 'd' && !e.ctrlKey && !e.metaKey) {
        this.mode = this.mode === 'draw' ? 'place' : 'draw';
        if (this.onModeChange) this.onModeChange(this.mode);
      } else if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
        if (this.mode === 'draw' && this.drawShapeMode === 'circle') {
          this.drawShapeMode = 'free';
        } else {
          this.mode = 'draw';
          this.drawShapeMode = 'circle';
          if (this.onModeChange) this.onModeChange(this.mode);
        }
      } else if (e.key === 'w' && !e.ctrlKey && !e.metaKey) {
        if (this.mode === 'draw' && this.drawShapeMode === 'sine') {
          this.drawShapeMode = 'free';
        } else {
          this.mode = 'draw';
          this.drawShapeMode = 'sine';
          if (this.onModeChange) this.onModeChange(this.mode);
        }
      } else if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
        if (this.selectedPegIds.size > 0 && !this.animationMode) {
          if (this.enterAnimationMode() && this.onEnterAnimationMode) {
            this.onEnterAnimationMode();
          }
        }
      }
    }, sig);
  }

  getEventPosition(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  getPegAtPosition(x, y) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return null;
    
    for (let i = level.pegs.length - 1; i >= 0; i--) {
      const peg = level.pegs[i];
      
      if (peg.shape === 'brick') {
        const w = peg.width || this.getBrickWidth();
        const h = peg.height || this.getBrickHeight();
        
        const cos = Math.cos(-(peg.angle || 0));
        const sin = Math.sin(-(peg.angle || 0));
        const dx = x - peg.x;
        const dy = y - peg.y;
        const localX = dx * cos - dy * sin;
        const localY = dx * sin + dy * cos;
        
        if (Math.abs(localX) <= w/2 + 8 && Math.abs(localY) <= h/2 + 8) {
          return peg;
        }
      } else {
        const radius = PHYSICS_CONFIG.pegRadius + 8;
        if (Utils.distance(x, y, peg.x, peg.y) <= radius) {
          return peg;
        }
      }
    }
    return null;
  }

  // Get brick dimensions based on peg size
  getBrickWidth() {
    return PHYSICS_CONFIG.pegRadius * 4;
  }
  
  getBrickHeight() {
    return PHYSICS_CONFIG.pegRadius * 1.2;
  }

  getPegVisibilityBounds(pegLike, centerX = pegLike.x, centerY = pegLike.y, angle = pegLike.angle || 0, slices = pegLike.curveSlices) {
    let positionedSlices = slices;
    if (positionedSlices && positionedSlices.length && Number.isFinite(pegLike.x) && Number.isFinite(pegLike.y)) {
      const shiftX = centerX - pegLike.x;
      const shiftY = centerY - pegLike.y;
      if (Math.abs(shiftX) > 1e-6 || Math.abs(shiftY) > 1e-6) {
        positionedSlices = positionedSlices.map(s => ({
          x: s.x + shiftX,
          y: s.y + shiftY,
          nx: s.nx,
          ny: s.ny
        }));
      }
    }

    const extents = estimatePegExtents(pegLike, centerX, centerY, angle, positionedSlices);
    const marginX = extents.x * (1 - 2 * MIN_VISIBLE_RATIO);
    const marginY = extents.y * (1 - 2 * MIN_VISIBLE_RATIO);
    return {
      minX: -marginX,
      maxX: this.canvas.width + marginX,
      minY: 50 - marginY,
      maxY: this.canvas.height - 35 + marginY
    };
  }

  clampPegPositionToVisibilityBounds(pegLike, x, y, angle = pegLike.angle || 0, slices = pegLike.curveSlices) {
    const b = this.getPegVisibilityBounds(pegLike, x, y, angle, slices);
    return {
      x: Utils.clamp(x, b.minX, b.maxX),
      y: Utils.clamp(y, b.minY, b.maxY)
    };
  }

  isPegPositionAllowed(pegLike, x, y, angle = pegLike.angle || 0, slices = pegLike.curveSlices) {
    const b = this.getPegVisibilityBounds(pegLike, x, y, angle, slices);
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  }

  getSelectionCenter() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return null;
    
    let sumX = 0, sumY = 0, count = 0;
    
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        sumX += peg.x;
        sumY += peg.y;
        count++;
      }
    }
    
    if (count === 0) return null;
    return { x: sumX / count, y: sumY / count };
  }

  getSelectionBounds() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return null;
    
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        const r = peg.shape === 'brick' ? 
          Math.max(peg.width || 40, peg.height || 12) / 2 : 
          PHYSICS_CONFIG.pegRadius;
        
        minX = Math.min(minX, peg.x - r);
        minY = Math.min(minY, peg.y - r);
        maxX = Math.max(maxX, peg.x + r);
        maxY = Math.max(maxY, peg.y + r);
      }
    }
    
    return { minX, minY, maxX, maxY };
  }

  getRotationHandlePosition() {
    const bounds = this.getSelectionBounds();
    if (!bounds) return null;
    
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const handleY = bounds.minY - 25;
    
    return { x: centerX, y: handleY };
  }

  // Draw mode - collect points and update ghost preview
  // SHIFT = straight line snapped to nearest 10° from start point
  continueDraw(x, y, shiftKey = false) {
    if (this.drawPath.length === 0) return;

    if (this.drawShapeMode === 'circle') {
      this.continueDrawCircle(x, y);
      return;
    }
    if (this.drawShapeMode === 'sine') {
      this.continueDrawSine(x, y);
      return;
    }

    // Freehand drawing
    const start = this.drawPath[0];
    if (shiftKey) {
      const rawAngle = Math.atan2(y - start.y, x - start.x);
      const snap = Math.PI / 18; // 10°
      const snappedAngle = Math.round(rawAngle / snap) * snap;
      const dist = Math.hypot(x - start.x, y - start.y);
      const endX = start.x + Math.cos(snappedAngle) * dist;
      const endY = start.y + Math.sin(snappedAngle) * dist;
      this.drawPath = [start, { x: endX, y: endY }];
    } else {
      const last = this.drawPath[this.drawPath.length - 1];
      if (Math.hypot(x - last.x, y - last.y) >= 4) {
        this.drawPath.push({ x, y });
      }
    }

    this.ghostBricks = this.computeGhostBricks();
  }

  continueDrawCircle(x, y) {
    const cx = this.startX;
    const cy = this.startY;
    const radius = Math.hypot(x - cx, y - cy);
    if (radius < 15) {
      this.drawPath = [{ x: cx, y: cy }];
      this.ghostBricks = [];
      return;
    }

    // Generate visual path (circle outline)
    const numPoints = Math.max(48, Math.ceil(2 * Math.PI * radius / 2));
    this.drawPath = [];
    for (let i = 0; i <= numPoints; i++) {
      const theta = (i / numPoints) * 2 * Math.PI;
      this.drawPath.push({
        x: cx + Math.cos(theta) * radius,
        y: cy + Math.sin(theta) * radius
      });
    }

    const samples = this.generateCircleSamples(cx, cy, radius);
    this.ghostBricks = this.computeGhostBricksFromSamples(samples, true);
  }

  continueDrawSine(x, y) {
    const x0 = this.startX, y0 = this.startY;
    const length = Math.hypot(x - x0, y - y0);
    if (length < 20) {
      this.drawPath = [{ x: x0, y: y0 }];
      this.ghostBricks = [];
      return;
    }

    const samples = this.generateSineSamples(x0, y0, x, y);
    if (samples.length < 2) {
      this.ghostBricks = [];
      return;
    }

    // Generate visual path from samples
    this.drawPath = samples.map(s => ({ x: s.x, y: s.y }));
    this.ghostBricks = this.computeGhostBricksFromSamples(samples, false);
  }

  generateCircleSamples(cx, cy, radius) {
    const circumference = 2 * Math.PI * radius;
    const numPoints = Math.max(48, Math.ceil(circumference / 2));
    const samples = [];
    for (let i = 0; i <= numPoints; i++) {
      const theta = (i / numPoints) * 2 * Math.PI;
      samples.push({
        x: cx + Math.cos(theta) * radius,
        y: cy + Math.sin(theta) * radius,
        // Tangent is perpendicular to radius (90° ahead in CCW direction)
        angle: theta + Math.PI / 2
      });
    }
    return samples;
  }

  generateSineSamples(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length < 10) return [];

    const axisAngle = Math.atan2(dy, dx);
    const perpX = -Math.sin(axisAngle);
    const perpY = Math.cos(axisAngle);

    const amplitude = 40;
    const periods = Math.max(1, Math.round(length / 120));
    const numPoints = Math.max(80, Math.ceil(length / 1.5));

    const samples = [];
    for (let i = 0; i <= numPoints; i++) {
      const t = i / numPoints;
      const sineVal = Math.sin(2 * Math.PI * periods * t);
      const cosVal = Math.cos(2 * Math.PI * periods * t);

      const x = x0 + dx * t + perpX * amplitude * sineVal;
      const y = y0 + dy * t + perpY * amplitude * sineVal;

      // Analytical derivative for tangent angle
      const dxdt = dx + perpX * amplitude * 2 * Math.PI * periods * cosVal;
      const dydt = dy + perpY * amplitude * 2 * Math.PI * periods * cosVal;
      samples.push({ x, y, angle: Math.atan2(dydt, dxdt) });
    }
    return samples;
  }

  // Reduce raw point density while preserving shape
  subsamplePath(points, minDist = 6) {
    if (points.length < 2) return [...points];
    const result = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const last = result[result.length - 1];
      if (Math.hypot(points[i].x - last.x, points[i].y - last.y) >= minDist) {
        result.push(points[i]);
      }
    }
    const last = result[result.length - 1];
    const final = points[points.length - 1];
    if (last !== final) result.push(final);
    return result;
  }

  // Sample a Catmull-Rom spline through pts, returning {x, y, angle} every ~step px
  sampleCatmullRom(pts, step = 3) {
    if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y, angle: 0 }];
    // Phantom endpoints so the curve passes through first and last points
    const cp = [
      { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y },
      ...pts,
      { x: 2 * pts[pts.length - 1].x - pts[pts.length - 2].x, y: 2 * pts[pts.length - 1].y - pts[pts.length - 2].y }
    ];
    const result = [];
    for (let i = 1; i < cp.length - 2; i++) {
      const P0 = cp[i - 1], P1 = cp[i], P2 = cp[i + 1], P3 = cp[i + 2];
      const approxLen = Math.hypot(P2.x - P1.x, P2.y - P1.y);
      const numSteps = Math.max(4, Math.ceil(approxLen / step));
      // Skip first point of each segment after the first to avoid duplicates
      for (let j = (i === 1 ? 0 : 1); j <= numSteps; j++) {
        const t = j / numSteps;
        const t2 = t * t, t3 = t2 * t;
        const x = 0.5 * (
          (2 * P1.x) +
          (-P0.x + P2.x) * t +
          (2 * P0.x - 5 * P1.x + 4 * P2.x - P3.x) * t2 +
          (-P0.x + 3 * P1.x - 3 * P2.x + P3.x) * t3
        );
        const y = 0.5 * (
          (2 * P1.y) +
          (-P0.y + P2.y) * t +
          (2 * P0.y - 5 * P1.y + 4 * P2.y - P3.y) * t2 +
          (-P0.y + 3 * P1.y - 3 * P2.y + P3.y) * t3
        );
        // Tangent direction → brick rotation angle
        const tdx = 0.5 * (
          (-P0.x + P2.x) +
          2 * (2 * P0.x - 5 * P1.x + 4 * P2.x - P3.x) * t +
          3 * (-P0.x + 3 * P1.x - 3 * P2.x + P3.x) * t2
        );
        const tdy = 0.5 * (
          (-P0.y + P2.y) +
          2 * (2 * P0.y - 5 * P1.y + 4 * P2.y - P3.y) * t +
          3 * (-P0.y + 3 * P1.y - 3 * P2.y + P3.y) * t2
        );
        result.push({ x, y, angle: Math.atan2(tdy, tdx) });
      }
    }
    return result;
  }

  // Interpolate a point + angle at a specific arc length along pre-computed samples
  sampleAtArcLen(samples, cumLen, targetLen) {
    let si = 0;
    while (si < samples.length - 1 && cumLen[si + 1] < targetLen) si++;
    if (si >= samples.length - 1) return { ...samples[samples.length - 1] };
    const segLen = cumLen[si + 1] - cumLen[si];
    const t = segLen > 0 ? (targetLen - cumLen[si]) / segLen : 0;
    const s0 = samples[si], s1 = samples[si + 1];
    // Interpolate angle correctly across the -PI/PI boundary
    let aDiff = s1.angle - s0.angle;
    while (aDiff > Math.PI) aDiff -= Math.PI * 2;
    while (aDiff < -Math.PI) aDiff += Math.PI * 2;
    return {
      x: s0.x + (s1.x - s0.x) * t,
      y: s0.y + (s1.y - s0.y) * t,
      angle: s0.angle + aDiff * t
    };
  }

  // Place ghost bricks edge-to-edge along the freehand spline.
  computeGhostBricks() {
    if (this.drawPath.length < 2) return [];
    const pts = this.subsamplePath(this.drawPath, 6);
    if (pts.length < 2) return [];
    const samples = this.sampleCatmullRom(pts, 2);
    return this.computeGhostBricksFromSamples(samples, false);
  }

  // Shared brick-placement logic: given pre-computed {x, y, angle} samples,
  // build arc-length table and place bricks edge-to-edge.
  // closedLoop: adjusts spacing for perfect integer tiling (circles).
  computeGhostBricksFromSamples(samples, closedLoop = false) {
    if (samples.length < 2) return [];

    const isBrick = this.selectedShape === 'brick';
    let spacing = isBrick ? this.getBrickWidth() : PHYSICS_CONFIG.pegRadius * 2.2;

    // Build cumulative arc-length table
    const cumLen = [0];
    for (let i = 1; i < samples.length; i++) {
      const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
      cumLen.push(cumLen[i - 1] + d);
    }
    const totalLen = cumLen[cumLen.length - 1];
    if (totalLen < spacing * 0.4) return [];

    // For closed loops, adjust spacing so an integer number of bricks tiles perfectly
    if (closedLoop) {
      const numBricks = Math.max(1, Math.round(totalLen / spacing));
      spacing = totalLen / numBricks;
    }

    const ghosts = [];
    const NUM_SLICES = 5;
    let edgePos = 0;

    while (edgePos + spacing * 0.4 <= totalLen) {
      const edgeEnd = Math.min(edgePos + spacing, totalLen);
      const centerLen = (edgePos + edgeEnd) / 2;
      const centerPt = this.sampleAtArcLen(samples, cumLen, centerLen);

      if (isBrick) {
        const slices = [];
        for (let s = 0; s <= NUM_SLICES; s++) {
          const arcLen = edgePos + (edgeEnd - edgePos) * s / NUM_SLICES;
          const pt = this.sampleAtArcLen(samples, cumLen, Math.min(arcLen, totalLen));
          slices.push({ x: pt.x, y: pt.y, nx: -Math.sin(pt.angle), ny: Math.cos(pt.angle) });
        }
        ghosts.push({ x: centerPt.x, y: centerPt.y, angle: centerPt.angle, slices });
      } else {
        ghosts.push({ x: centerPt.x, y: centerPt.y, angle: centerPt.angle });
      }
      edgePos += spacing;
    }
    return ghosts;
  }

  // Commit ghost bricks to the level on draw release
  commitGhostBricks() {
    const level = this.levelManager.getCurrentLevel();
    const toCommit = this.ghostBricks;
    this.ghostBricks = [];
    this.drawPath = [];
    if (!level || toCommit.length === 0) return;
    this.saveUndoState();
    const isBrick = this.selectedShape === 'brick';
    const w = this.getBrickWidth();
    const h = this.getBrickHeight();
    for (const gb of toCommit) {
      const pegData = {
        x: gb.x,
        y: gb.y,
        type: this.selectedPegType,
        shape: this.selectedShape,
        angle: isBrick ? gb.angle : 0
      };
      if (isBrick) {
        pegData.width = w;
        pegData.height = h;
        if (gb.slices) pegData.curveSlices = gb.slices;
      }
      if (!this.isPegPositionAllowed(pegData, pegData.x, pegData.y, pegData.angle, pegData.curveSlices)) continue;
      this.levelManager.addPeg(pegData);
    }
    this.levelManager.save();
    const updated = this.levelManager.getCurrentLevel();
    if (updated && this.onPegCountChange) {
      this.onPegCountChange(updated.pegs.length);
    }
  }

  placePeg(x, y) {
    if (this.snapToGrid) {
      x = Utils.snapToGrid(x, this.gridSize);
      y = Utils.snapToGrid(y, this.gridSize);
    }
    
    const level = this.levelManager.getCurrentLevel();
    if (!level) return null;
    
    // Check minimum distance from other pegs
    const minDist = PHYSICS_CONFIG.pegRadius * 2;
    for (const peg of level.pegs) {
      if (Utils.distance(x, y, peg.x, peg.y) < minDist) {
        return null;
      }
    }
    
    const pegData = {
      x: x,
      y: y,
      type: this.selectedPegType,
      shape: this.selectedShape,
      angle: this.selectedShape === 'brick' ? this.currentRotation : 0
    };
    
    if (this.selectedShape === 'brick') {
      pegData.width = this.getBrickWidth();
      pegData.height = this.getBrickHeight();
    }
    if (!this.isPegPositionAllowed(pegData, pegData.x, pegData.y, pegData.angle, pegData.curveSlices)) return null;
    
    const peg = this.levelManager.addPeg(pegData);
    
    if (peg && this.onPegCountChange) {
      this.onPegCountChange(level.pegs.length);
    }
    
    return peg;
  }

  captureDragStartPositions() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) {
      this.dragStartPositions = null;
      this.dragAnchorId = null;
      return;
    }

    this.dragStartPositions = new Map();
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        const snap = { x: peg.x, y: peg.y };
        // Capture original curveSlices so they can be translated with the peg
        if (peg.curveSlices) snap.curveSlices = peg.curveSlices.map(s => ({ ...s }));
        this.dragStartPositions.set(pegId, snap);
      }
    }
    
    if (this.dragPegId && this.dragStartPositions.has(this.dragPegId)) {
      this.dragAnchorId = this.dragPegId;
    } else {
      this.dragAnchorId = this.dragStartPositions.keys().next().value || null;
    }
  }

  moveSelectedPegs(dx, dy) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    if (this.dragStartPositions && this.dragStartPositions.size > 0) {
      let deltaX = dx;
      let deltaY = dy;

      if (this.snapToGrid && this.dragAnchorId && this.dragStartPositions.has(this.dragAnchorId)) {
        const anchorStart = this.dragStartPositions.get(this.dragAnchorId);
        const snappedX = Utils.snapToGrid(anchorStart.x + dx, this.gridSize);
        const snappedY = Utils.snapToGrid(anchorStart.y + dy, this.gridSize);
        deltaX = snappedX - anchorStart.x;
        deltaY = snappedY - anchorStart.y;
      }

      for (const pegId of this.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        const start = this.dragStartPositions.get(pegId);
        if (peg && start) {
          const clamped = this.clampPegPositionToVisibilityBounds(
            peg,
            start.x + deltaX,
            start.y + deltaY,
            peg.angle || 0,
            peg.curveSlices
          );
          peg.x = clamped.x;
          peg.y = clamped.y;
          // Translate curveSlices by the same delta so the visual follows the peg
          if (start.curveSlices && peg.curveSlices) {
            const actualDx = peg.x - start.x;
            const actualDy = peg.y - start.y;
            for (let i = 0; i < peg.curveSlices.length; i++) {
              peg.curveSlices[i].x = start.curveSlices[i].x + actualDx;
              peg.curveSlices[i].y = start.curveSlices[i].y + actualDy;
            }
          }
        }
      }
    } else {
      for (const pegId of this.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        if (peg) {
          const oldX = peg.x, oldY = peg.y;
          const clamped = this.clampPegPositionToVisibilityBounds(
            peg,
            peg.x + dx,
            peg.y + dy,
            peg.angle || 0,
            peg.curveSlices
          );
          peg.x = clamped.x;
          peg.y = clamped.y;
          if (peg.curveSlices) {
            const movedX = peg.x - oldX, movedY = peg.y - oldY;
            for (const s of peg.curveSlices) { s.x += movedX; s.y += movedY; }
          }
        }
      }
    }
  }

  deleteSelectedPegs() {
    if (this.selectedPegIds.size === 0) return;
    
    this.saveUndoState();
    this.levelManager.removePegs(Array.from(this.selectedPegIds));
    this.selectedPegIds.clear();
    this.notifySelectionChange();
    
    const level = this.levelManager.getCurrentLevel();
    if (level && this.onPegCountChange) {
      this.onPegCountChange(level.pegs.length);
    }
  }

  selectPegsInBox(box) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    
    const minX = Math.min(box.startX, box.endX);
    const maxX = Math.max(box.startX, box.endX);
    const minY = Math.min(box.startY, box.endY);
    const maxY = Math.max(box.startY, box.endY);
    
    for (const peg of level.pegs) {
      if (peg.x >= minX && peg.x <= maxX && peg.y >= minY && peg.y <= maxY) {
        this.selectedPegIds.add(peg.id);
      }
    }
    
    this.notifySelectionChange();
  }

  selectAll() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    
    this.selectedPegIds.clear();
    for (const peg of level.pegs) {
      this.selectedPegIds.add(peg.id);
    }
    
    this.notifySelectionChange();
  }

  setSelectedPegsType(type) {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return;
    
    this.saveUndoState();
    
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        peg.type = type;
      }
    }
    
    this.levelManager.save();
  }

  setSelectedPegsShape(shape) {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return;
    
    this.saveUndoState();
    
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        peg.shape = shape;
        if (shape === 'brick') {
          peg.width = peg.width || this.getBrickWidth();
          peg.height = peg.height || this.getBrickHeight();
        }
      }
    }
    
    this.levelManager.save();
  }

  rotateSelectedPegs(angleDelta) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    if (this.selectedPegIds.size === 0) {
      this.currentRotation += angleDelta;
      return;
    }

    this.saveUndoState();
    const cos = Math.cos(angleDelta);
    const sin = Math.sin(angleDelta);

    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        peg.angle = (peg.angle || 0) + angleDelta;
        // Rotate curveSlices around peg center
        if (peg.curveSlices) {
          for (const s of peg.curveSlices) {
            const dx = s.x - peg.x, dy = s.y - peg.y;
            s.x = peg.x + dx * cos - dy * sin;
            s.y = peg.y + dx * sin + dy * cos;
            const nnx = s.nx * cos - s.ny * sin;
            const nny = s.nx * sin + s.ny * cos;
            s.nx = nnx;
            s.ny = nny;
          }
        }
      }
    }

    this.levelManager.save();
  }

  rotateSelectedPegsAbsolute(angleDelta) {
    const level = this.levelManager.getCurrentLevel();
    if (!level || !this.rotationCenter) return;

    const cx = this.rotationCenter.x;
    const cy = this.rotationCenter.y;
    const cos = Math.cos(angleDelta);
    const sin = Math.sin(angleDelta);

    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        const dx = peg.x - cx;
        const dy = peg.y - cy;
        peg.x = cx + dx * cos - dy * sin;
        peg.y = cy + dx * sin + dy * cos;
        peg.angle = (peg.angle || 0) + angleDelta;
        // Rotate curveSlices positions and normals around the same center
        if (peg.curveSlices) {
          for (const s of peg.curveSlices) {
            const sx = s.x - cx, sy = s.y - cy;
            s.x = cx + sx * cos - sy * sin;
            s.y = cy + sx * sin + sy * cos;
            const nnx = s.nx * cos - s.ny * sin;
            const nny = s.nx * sin + s.ny * cos;
            s.nx = nnx;
            s.ny = nny;
          }
        }
      }
    }
  }

  mirrorHorizontal() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return;

    this.saveUndoState();
    const center = this.getSelectionCenter();
    if (!center) return;

    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        peg.x = center.x - (peg.x - center.x);
        peg.angle = peg.angle ? -peg.angle : 0;
        if (peg.curveSlices) {
          for (const s of peg.curveSlices) {
            s.x = center.x - (s.x - center.x);
            s.nx = -s.nx;
          }
          peg.curveSlices.reverse();
        }
      }
    }

    this.levelManager.save();
  }

  mirrorVertical() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return;

    this.saveUndoState();
    const center = this.getSelectionCenter();
    if (!center) return;

    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        peg.y = center.y - (peg.y - center.y);
        peg.angle = peg.angle ? Math.PI - peg.angle : 0;
        if (peg.curveSlices) {
          for (const s of peg.curveSlices) {
            s.y = center.y - (s.y - center.y);
            s.ny = -s.ny;
          }
          peg.curveSlices.reverse();
        }
      }
    }

    this.levelManager.save();
  }

  duplicateSelectedPegs(offsetX = 20, offsetY = 20) {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return;
    
    this.saveUndoState();
    const newPegIds = new Set();
    
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        const newPeg = this.levelManager.addPeg({
          x: peg.x + offsetX,
          y: peg.y + offsetY,
          type: peg.type,
          shape: peg.shape,
          angle: peg.angle,
          width: peg.width,
          height: peg.height
        });
        if (newPeg) {
          newPegIds.add(newPeg.id);
        }
      }
    }
    
    this.selectedPegIds = newPegIds;
    this.notifySelectionChange();
    
    if (this.onPegCountChange) {
      this.onPegCountChange(level.pegs.length);
    }
  }

  // Duplicate in place (for alt+drag)
  duplicateSelectedPegsInPlace() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return;
    
    const newPegIds = new Set();
    
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        const newPeg = this.levelManager.addPeg({
          x: peg.x,
          y: peg.y,
          type: peg.type,
          shape: peg.shape,
          angle: peg.angle,
          width: peg.width,
          height: peg.height
        });
        if (newPeg) {
          newPegIds.add(newPeg.id);
        }
      }
    }
    
    // Select the new copies (we'll drag these)
    this.selectedPegIds = newPegIds;
    this.notifySelectionChange();
    
    if (this.onPegCountChange) {
      this.onPegCountChange(level.pegs.length);
    }
  }

  groupSelectedPegs() {
    if (this.selectedPegIds.size < 2) return null;
    
    const groupName = `Group ${Date.now() % 1000}`;
    return this.levelManager.createGroup(
      Array.from(this.selectedPegIds), 
      groupName, 
      'custom'
    );
  }

  clearAllPegs() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    
    this.saveUndoState();
    level.pegs = [];
    this.selectedPegIds.clear();
    this.levelManager.save();
    this.notifySelectionChange();
    
    if (this.onPegCountChange) {
      this.onPegCountChange(0);
    }
  }

  saveUndoState() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    
    this.undoStack.push(Utils.deepClone(level.pegs));
    if (this.undoStack.length > this.maxUndoSteps) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo() {
    if (this.undoStack.length === 0) return;
    
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    
    this.redoStack.push(Utils.deepClone(level.pegs));
    level.pegs = this.undoStack.pop();
    this.levelManager.save();
    
    this.selectedPegIds.clear();
    this.notifySelectionChange();
    
    if (this.onPegCountChange) {
      this.onPegCountChange(level.pegs.length);
    }
  }

  redo() {
    if (this.redoStack.length === 0) return;
    
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    
    this.undoStack.push(Utils.deepClone(level.pegs));
    level.pegs = this.redoStack.pop();
    this.levelManager.save();
    
    this.selectedPegIds.clear();
    this.notifySelectionChange();
    
    if (this.onPegCountChange) {
      this.onPegCountChange(level.pegs.length);
    }
  }

  notifySelectionChange() {
    if (this.onSelectionChange) {
      this.onSelectionChange(this.selectedPegIds.size);
    }
  }

  render() {
    const level = this.levelManager.getCurrentLevel();
    const wrapCopyPegIds = (this.animationPreview && this.animationPreviewAnimator)
      ? this.animationPreviewAnimator.getAnimatedPegIds()
      : null;

    // Tick animation preview if active
    if (this.animationPreview && this.animationPreviewAnimator && level) {
      this.animationPreviewAnimator.tick(level.pegs, 1 / 60, this.getAnimationWorldBounds());
    }

    const rotationHandle = (!this.animationMode && this.selectedPegIds.size > 0)
      ? this.getRotationHandlePosition() : null;

    this.renderer.renderGame({
      pegs: level ? level.pegs : [],
      hitPegIds: [],
      wrapCopyPegIds,
      selectedPegIds: this.selectedPegIds,
      ball: null,
      bucket: null,
      showLauncher: false,
      showGrid: this.showGrid,
      selectionBox: this.selectionBox,
      rotationHandle: rotationHandle,
      selectionBounds: (!this.animationMode && this.selectedPegIds.size > 0) ? this.getSelectionBounds() : null,
      isEditor: true,
      drawMode: this.mode === 'draw',
      drawShapeMode: this.drawShapeMode,
      drawCenter: (this.drawShapeMode !== 'free' && this.isInteracting && this.interactionType === 'draw')
        ? { x: this.startX, y: this.startY } : null,
      ghostBricks: this.ghostBricks,
      drawPath: this.drawPath,
      brickWidth: this.getBrickWidth(),
      brickHeight: this.getBrickHeight(),
      pegType: this.selectedPegType,
      pegShape: this.selectedShape,
      // Animation mode state
      animationMode: this.animationMode && !this.animationPreview,
      animationGhosts: (this.animationMode && !this.animationPreview) ? this.getAnimationGhosts() : null,
      animationCenter: (this.animationMode && !this.animationPreview) ? this.getAnimationCenter() : null,
      animationGhostCenter: (this.animationMode && !this.animationPreview) ? this.getAnimationGhostCenter() : null,
      animationMotion: (this.animationMode && !this.animationPreview) ? this.resolveAnimationMotion() : null,
      animationInverse: this.animationMode && !this.animationPreview ? this.animationInverse : false,
      animationGhostOffset: this.animationGhostOffset,
      groups: level ? level.groups : []
    });
  }

  start() {
    const loop = () => {
      this.render();
      this.animationId = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    // Remove all event listeners registered with the abort signal
    this.abortController.abort();
  }

  resize(width, height) {
    this.renderer.resize(width, height);
  }

  setSelectedPegType(type) {
    this.selectedPegType = type;
  }

  setSelectedShape(shape) {
    this.selectedShape = shape;
  }

  setMode(mode) {
    this.mode = mode;
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.renderer.showGrid = this.showGrid;
    if (this.onGridChange) this.onGridChange(this.showGrid);
    return this.showGrid;
  }

  toggleSnap() {
    this.snapToGrid = !this.snapToGrid;
    if (this.onSnapChange) this.onSnapChange(this.snapToGrid);
    return this.snapToGrid;
  }

  // ── Animation Mode ──

  getAnimationWorldBounds() {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  resolveAnimationMotion(useInverse = this.animationInverse) {
    if (!this.animationGhostOffset) return { dx: 0, dy: 0 };
    const bounds = this.getAnimationWorldBounds();
    const center = this.getAnimationCenter();
    return resolveWrappedMotion(
      this.animationGhostOffset.dx || 0,
      this.animationGhostOffset.dy || 0,
      bounds.width,
      bounds.height,
      useInverse,
      center ? center.x : 0,
      center ? center.y : 0
    );
  }

  getAnimationTargetPegs(level) {
    if (!level || !this.animationTarget) return [];
    if (this.animationTarget.type === 'group') {
      return level.pegs.filter(p => p.groupId === this.animationTarget.id);
    }
    const peg = level.pegs.find(p => p.id === this.animationTarget.id);
    return peg ? [peg] : [];
  }

  estimateAnimationTargetExtents(center, pegs) {
    if (!center || !pegs || pegs.length === 0) {
      return { x: PHYSICS_CONFIG.pegRadius, y: PHYSICS_CONFIG.pegRadius };
    }
    let maxX = PHYSICS_CONFIG.pegRadius;
    let maxY = PHYSICS_CONFIG.pegRadius;
    for (const peg of pegs) {
      const ex = estimatePegExtents(peg, peg.x, peg.y, peg.angle || 0, peg.curveSlices);
      maxX = Math.max(maxX, Math.abs(peg.x - center.x) + ex.x);
      maxY = Math.max(maxY, Math.abs(peg.y - center.y) + ex.y);
    }
    return { x: maxX, y: maxY };
  }

  enterAnimationMode() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return false;

    // Determine target: group if all selected share a groupId, else first selected peg
    const selectedPegs = [];
    let commonGroupId = undefined;
    for (const id of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === id);
      if (!peg) continue;
      selectedPegs.push(peg);
      if (commonGroupId === undefined) {
        commonGroupId = peg.groupId;
      } else if (commonGroupId !== peg.groupId) {
        commonGroupId = null;
      }
    }
    if (selectedPegs.length === 0) return false;

    if (commonGroupId) {
      this.animationTarget = { type: 'group', id: commonGroupId };
    } else if (selectedPegs.length > 1) {
      // Auto-group ungrouped pegs so they animate as a unit
      const pegIds = selectedPegs.map(p => p.id);
      const group = this.levelManager.createGroup(pegIds, 'Anim Group', 'custom');
      this.animationTarget = { type: 'group', id: group.id };
    } else {
      this.animationTarget = { type: 'peg', id: selectedPegs[0].id };
    }

    // Load existing animation data
    const existing = this.getTargetAnimation();
    this.animationGhostOffset = { dx: existing?.dx || 0, dy: existing?.dy || 0 };
    this.animationRotation = existing?.rotation || 0;
    this.animationDuration = existing?.duration || 2;
    this.animationEasing = existing?.easing || 'easeInOut';
    this.animationInverse = !!existing?.inverse;
    this.animationCycle = !!existing?.cycle;
    this.animationMode = true;
    this.animationPreview = false;
    this.animationPreviewAnimator = null;

    return true;
  }

  exitAnimationMode() {
    this.stopAnimationPreview();
    this.animationMode = false;
    this.animationTarget = null;
    this.animationGhostOffset = null;
    this.animationPreview = false;
    this.animationPreviewAnimator = null;
    this.animationInverse = false;
    this.animationCycle = false;
  }

  getTargetAnimation() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || !this.animationTarget) return null;

    if (this.animationTarget.type === 'group') {
      const group = level.groups.find(g => g.id === this.animationTarget.id);
      return group?.animation || null;
    } else {
      const peg = level.pegs.find(p => p.id === this.animationTarget.id);
      return peg?.animation || null;
    }
  }

  setTargetAnimation(animData) {
    if (!this.animationTarget) return;
    const normalizedAnim = {
      ...animData,
      wrap: animData?.wrap !== false,
      inverse: !!animData?.inverse,
      cycle: !!animData?.cycle
    };

    this.saveUndoState();
    if (this.animationTarget.type === 'group') {
      this.levelManager.updateGroup(this.animationTarget.id, { animation: normalizedAnim });
    } else {
      this.levelManager.updatePeg(this.animationTarget.id, { animation: normalizedAnim });
    }
  }

  clearTargetAnimation() {
    if (!this.animationTarget) return;
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    this.saveUndoState();
    if (this.animationTarget.type === 'group') {
      const group = level.groups.find(g => g.id === this.animationTarget.id);
      if (group) {
        delete group.animation;
        this.levelManager.save();
      }
    } else {
      const peg = level.pegs.find(p => p.id === this.animationTarget.id);
      if (peg) {
        delete peg.animation;
        this.levelManager.save();
      }
    }

    this.animationGhostOffset = { dx: 0, dy: 0 };
    this.animationRotation = 0;
    this.animationInverse = false;
  }

  getAnimationCenter() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || !this.animationTarget) return null;

    if (this.animationTarget.type === 'group') {
      let cx = 0, cy = 0, count = 0;
      for (const peg of level.pegs) {
        if (peg.groupId === this.animationTarget.id) {
          cx += peg.x; cy += peg.y; count++;
        }
      }
      return count > 0 ? { x: cx / count, y: cy / count } : null;
    } else {
      const peg = level.pegs.find(p => p.id === this.animationTarget.id);
      return peg ? { x: peg.x, y: peg.y } : null;
    }
  }

  getAnimationGhostCenter() {
    const center = this.getAnimationCenter();
    if (!center || !this.animationGhostOffset) return null;
    const bounds = this.getAnimationWorldBounds();
    const motion = this.resolveAnimationMotion();
    const traced = mirrorWrapTrace(
      center.x, center.y, motion.dx, motion.dy,
      bounds.width, bounds.height
    );
    return { x: traced.x, y: traced.y, mirrorX: traced.mirrorX, mirrorY: traced.mirrorY };
  }

  getAnimationGhosts() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || !this.animationTarget || !this.animationGhostOffset) return [];

    const center = this.getAnimationCenter();
    if (!center) return [];

    const bounds = this.getAnimationWorldBounds();
    const motion = this.resolveAnimationMotion();
    const rot = this.animationRotation;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const pegsToGhost = this.getAnimationTargetPegs(level);

    // Mirror-wrap: trace path with wall reflections (emerge from red dot)
    const traced = mirrorWrapTrace(
      center.x, center.y, motion.dx, motion.dy,
      bounds.width, bounds.height
    );

    return pegsToGhost.map(peg => {
      const ghost = { ...peg };
      const ghostAngle = (peg.angle || 0) + rot;

      if (this.animationTarget.type === 'group') {
        const px = peg.x - center.x;
        const py = peg.y - center.y;
        let rx = px * cosR - py * sinR;
        let ry = px * sinR + py * cosR;
        if (traced.mirrorX) rx = -rx;
        if (traced.mirrorY) ry = -ry;
        ghost.x = traced.x + rx;
        ghost.y = traced.y + ry;
      } else {
        ghost.x = traced.x;
        ghost.y = traced.y;
      }

      ghost.angle = ghostAngle;
      if (peg.curveSlices) {
        ghost.curveSlices = peg.curveSlices.map(s => {
          const sx = s.x - (this.animationTarget.type === 'group' ? center.x : peg.x);
          const sy = s.y - (this.animationTarget.type === 'group' ? center.y : peg.y);
          let rsx = sx * cosR - sy * sinR;
          let rsy = sx * sinR + sy * cosR;
          if (traced.mirrorX) rsx = -rsx;
          if (traced.mirrorY) rsy = -rsy;
          let rnx = s.nx * cosR - s.ny * sinR;
          let rny = s.nx * sinR + s.ny * cosR;
          if (traced.mirrorX) rnx = -rnx;
          if (traced.mirrorY) rny = -rny;
          return {
            x: (this.animationTarget.type === 'group' ? traced.x : ghost.x) + rsx,
            y: (this.animationTarget.type === 'group' ? traced.y : ghost.y) + rsy,
            nx: rnx, ny: rny
          };
        });
      }
      return ghost;
    });
  }

  startAnimationPreview() {
    if (this.animationPreview) return;
    this.animationPreview = true;
    this.animationPreviewAnimator = new PegAnimator();

    // Temporarily apply animation to compute preview
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    // Build temp animation data on pegs/groups
    const animData = {
      dx: this.animationGhostOffset?.dx || 0,
      dy: this.animationGhostOffset?.dy || 0,
      rotation: this.animationRotation,
      duration: this.animationDuration,
      easing: this.animationCycle ? 'linear' : this.animationEasing,
      inverse: this.animationInverse,
      cycle: this.animationCycle,
      wrap: true
    };

    // Temporarily assign animation
    if (this.animationTarget.type === 'group') {
      const group = level.groups.find(g => g.id === this.animationTarget.id);
      if (group) {
        this._previewOldAnim = group.animation;
        group.animation = animData;
      }
    } else {
      const peg = level.pegs.find(p => p.id === this.animationTarget.id);
      if (peg) {
        this._previewOldAnim = peg.animation;
        peg.animation = animData;
      }
    }

    this.animationPreviewAnimator.loadFromLevel(level.pegs, level.groups);

    // Restore original animation
    if (this.animationTarget.type === 'group') {
      const group = level.groups.find(g => g.id === this.animationTarget.id);
      if (group) {
        if (this._previewOldAnim) group.animation = this._previewOldAnim;
        else delete group.animation;
      }
    } else {
      const peg = level.pegs.find(p => p.id === this.animationTarget.id);
      if (peg) {
        if (this._previewOldAnim) peg.animation = this._previewOldAnim;
        else delete peg.animation;
      }
    }
    this._previewOldAnim = null;
  }

  stopAnimationPreview() {
    if (!this.animationPreview) return;
    const level = this.levelManager.getCurrentLevel();
    if (level && this.animationPreviewAnimator) {
      this.animationPreviewAnimator.reset(level.pegs);
    }
    this.animationPreview = false;
    this.animationPreviewAnimator = null;
  }
}
