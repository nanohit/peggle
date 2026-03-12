// Peggle Editor - Level editor logic

import { Renderer } from './renderer.js';
import { LevelManager } from './levels.js';
import { Utils } from './utils.js';
import { PHYSICS_CONFIG } from './physics.js';
import { normalizeFlipperConfig } from './flipper-defaults.js';
import { SurvivalRuntime } from './survival-runtime.js';
import { ensureLevelSurvival } from './survival-mode.js';
import {
  MULTIBALL_DEFAULT_SPAWN_COUNT,
  normalizeMultiballSpawnCount
} from './multiball-settings.js';
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
    this.drawShapeMode = 'free'; // 'free', 'circle', 'sine', 'bezier'
    this.bezierDraft = null;     // { start, end, h1, h2, bend }
    this.activeBezierGroupId = null;
    
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
    this.onFlipperSelectionChange = null;

    // Flipper editor state
    this.flipperSelected = false;
    this.flipperDragStartY = 0;
    this.flipperDragStartOffset = 0;

    // Survival vertical mode viewport runtime
    this.survivalRuntime = new SurvivalRuntime(canvas.height, { autoScroll: false });
    const level = this.levelManager.getCurrentLevel();
    if (level) {
      this.survivalRuntime.configure(ensureLevelSurvival(level, canvas.height));
    }

    this.setupInput();
  }

  setupInput() {
    const canvas = this.canvas;
    
    const handleStart = (e) => {
      const screenPos = this.getEventScreenPosition(e);
      const pos = this.toWorldPosition(screenPos);

      if (this.isMiddlePanEvent(e) && this.isSurvivalMode()) {
        e.preventDefault();
        this.isInteracting = true;
        this.interactionType = 'pan';
        this.startX = pos.x;
        this.startY = pos.y;
        this.lastX = pos.x;
        this.lastY = pos.y;
        this.startScreenX = screenPos.x;
        this.startScreenY = screenPos.y;
        this.lastScreenX = screenPos.x;
        this.lastScreenY = screenPos.y;
        this._panStartCameraY = this.getCameraY();
        this._panStartScreenY = screenPos.y;
        return;
      }

      e.preventDefault();

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
      this.startScreenX = screenPos.x;
      this.startScreenY = screenPos.y;
      this.lastScreenX = screenPos.x;
      this.lastScreenY = screenPos.y;
      this.hasMoved = false;
      this.isInteracting = true;
      this.isCopying = e.altKey;

      // Draw-bezier: keep current draft active until Enter/Escape.
      if (this.mode === 'draw' && this.drawShapeMode === 'bezier' && this.bezierDraft) {
        const bezierControl = this.getBezierControlAt(pos.x, pos.y);
        if (bezierControl) {
          this.interactionType = bezierControl;
          if (bezierControl === 'bezierBend') {
            this.beginBezierBendDrag(pos);
          } else if (bezierControl === 'bezierStart' || bezierControl === 'bezierEnd') {
            this.beginBezierAnchorDrag(bezierControl, pos);
          }
          return;
        }
        this.isInteracting = false;
        this.interactionType = null;
        return;
      }

      // Check if clicking on rotation/scale handle first
      if (this.selectedPegIds.size > 0) {
        const handle = this.getRotationHandlePosition();
        if (handle && Utils.distance(pos.x, pos.y, handle.x, handle.y) < 15) {
          // If only bumpers are selected, use handle for scaling instead of rotation
          if (this.isSelectionAllBumpers()) {
            this.interactionType = 'bumperScale';
            this.rotationCenter = this.getSelectionCenter();
            this._bumperScaleStartDist = Utils.distance(pos.x, pos.y, this.rotationCenter.x, this.rotationCenter.y);
            this._bumperScaleStartValues = this.getSelectedBumperScales();
            this.saveUndoState();
          } else {
            this.interactionType = 'rotate';
            this.rotationCenter = this.getSelectionCenter();
            this.rotationStartAngle = Utils.angleBetween(
              this.rotationCenter.x, this.rotationCenter.y, pos.x, pos.y
            );
            this.saveUndoState();
          }
          return;
        }
      }
      
      // Check if clicking on flippers
      if (this.isNearFlipper(pos)) {
        this.flipperSelected = true;
        this.selectedPegIds.clear();
        this.notifySelectionChange();
        this.interactionType = 'flipperDrag';
        const f = this.levelManager.getFlippers();
        this.flipperDragStartY = f.y;
        this.flipperDragStartOffset = f.xOffset;
        if (this.onFlipperSelectionChange) this.onFlipperSelectionChange(true);
        return;
      }

      // Check if clicking on existing peg
      const peg = this.getPegAtPosition(pos.x, pos.y);

      if (peg) {
        this.deselectFlippers();
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
        this.deselectFlippers();
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
          if (this.drawShapeMode === 'bezier') {
            this.clearBezierDraft(false);
          }
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
      
      const screenPos = this.getEventScreenPosition(e);
      const pos = this.toWorldPosition(screenPos);
      const dx = pos.x - this.lastX;
      const dy = pos.y - this.lastY;
      const totalDx = pos.x - this.startX;
      const totalDy = pos.y - this.startY;
      const panStartScreenY = this._panStartScreenY ?? this.startScreenY ?? screenPos.y;
      const totalScreenDy = screenPos.y - panStartScreenY;
      
      if (this.interactionType !== 'pan' && (Math.abs(totalDx) > 3 || Math.abs(totalDy) > 3)) {
        this.hasMoved = true;
      }
      
      switch (this.interactionType) {
        case 'pan':
          if (this._panStartCameraY != null) {
            this.survivalRuntime.setCameraY(this._panStartCameraY - totalScreenDy);
          }
          break;

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

        case 'bumperScale':
          if (this.rotationCenter && this._bumperScaleStartDist > 0) {
            const currentDist = Utils.distance(pos.x, pos.y, this.rotationCenter.x, this.rotationCenter.y);
            const scaleRatio = currentDist / this._bumperScaleStartDist;
            this.setSelectedBumperScales(this._bumperScaleStartValues, scaleRatio);
            if (this.onBumperPropertyChange) this.onBumperPropertyChange();
          }
          break;

        case 'flipperDrag': {
          const f = this.levelManager.getFlippers();
          if (f) {
            f.y = this.flipperDragStartY + totalDy;
            const minFlipperY = this.isSurvivalMode() ? 30 : this.canvas.height * 0.3;
            const maxFlipperY = this.isSurvivalMode() ? this.getWorldHeight() - 35 : this.canvas.height - 35;
            f.y = Math.max(minFlipperY, Math.min(maxFlipperY, f.y));
            // Horizontal drag adjusts spread
            f.xOffset = Math.max(10, Math.min(250, this.flipperDragStartOffset + totalDx));
            this.levelManager.save();
            if (this.onFlipperSelectionChange) this.onFlipperSelectionChange(true);
          }
          break;
        }

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
          // In bezier edit phase, drag should only move controls (not draw strokes).
          if (this.drawShapeMode === 'bezier' && this.bezierDraft) {
            break;
          }
          this.continueDraw(pos.x, pos.y, e.shiftKey);
          break;

        case 'bezierHandle1':
        case 'bezierHandle2':
          this.applyBezierHandleDrag(this.interactionType, pos, e.shiftKey);
          break;

        case 'bezierStart':
        case 'bezierEnd':
          this.applyBezierAnchorDrag(this.interactionType, pos, e.shiftKey);
          break;

        case 'bezierBend':
          this.applyBezierBendDrag(pos, e.shiftKey);
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
      this.lastScreenX = screenPos.x;
      this.lastScreenY = screenPos.y;
    };

    const handleEnd = (e) => {
      if (!this.isInteracting) return;
      
      const pos = this.lastX !== undefined ? { x: this.lastX, y: this.lastY } : this.getEventPosition(e);
      
      switch (this.interactionType) {
        case 'pan':
          break;

        case 'animDrag':
          this._animDragStart = null;
          break;

        case 'rotate':
          this.levelManager.save();
          break;

        case 'bumperScale':
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
          if (this.drawShapeMode === 'bezier') {
            if (!this.bezierDraft) {
              const start = this.drawPath[0];
              const end = { x: pos.x, y: pos.y };
              if (start && Utils.distance(start.x, start.y, end.x, end.y) >= 10) {
                this.createBezierDraft(start, end);
              } else {
                this.clearBezierDraft();
              }
            }
          } else {
            this.commitGhostBricks();
          }
          break;

        case 'bezierHandle1':
        case 'bezierHandle2':
          break;

        case 'bezierStart':
        case 'bezierEnd':
          this._bezierDragStart = null;
          break;

        case 'bezierBend':
          this._bezierDragStart = null;
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
      this._panStartCameraY = null;
      this._panStartScreenY = null;
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
    canvas.addEventListener('dblclick', (e) => {
      if (this.animationMode) return;
      e.preventDefault();
      const pos = this.getEventPosition(e);
      const peg = this.getPegAtPosition(pos.x, pos.y);
      if (!peg || !peg.bezierGroupId) return;
      this.beginEditBezierGroup(peg.bezierGroupId);
    }, sig);
    canvas.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    }, sig);
    canvas.addEventListener('wheel', (e) => {
      if (!this.isSurvivalMode()) return;
      e.preventDefault();
      this.survivalRuntime.scrollBy(e.deltaY);
    }, { passive: false, ...sig });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (this.flipperSelected) {
          this.deleteFlippers();
        } else {
          this.deleteSelectedPegs();
        }
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
        if (this.bezierDraft) {
          this.clearBezierDraft();
        } else {
          this.selectedPegIds.clear();
          this.notifySelectionChange();
        }
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
        const enteringDraw = this.mode !== 'draw';
        if (!enteringDraw) this.clearBezierDraft();
        this.mode = enteringDraw ? 'draw' : 'place';
        if (this.onModeChange) this.onModeChange(this.mode);
      } else if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
        if (this.mode === 'draw' && this.drawShapeMode === 'circle') {
          this.drawShapeMode = 'free';
          this.clearBezierDraft();
        } else {
          this.mode = 'draw';
          this.drawShapeMode = 'circle';
          this.clearBezierDraft();
          if (this.onModeChange) this.onModeChange(this.mode);
        }
      } else if (e.key === 'w' && !e.ctrlKey && !e.metaKey) {
        if (this.mode === 'draw' && this.drawShapeMode === 'sine') {
          this.drawShapeMode = 'free';
          this.clearBezierDraft();
        } else {
          this.mode = 'draw';
          this.drawShapeMode = 'sine';
          this.clearBezierDraft();
          if (this.onModeChange) this.onModeChange(this.mode);
        }
      } else if (e.key === 'b' && !e.ctrlKey && !e.metaKey) {
        if (this.mode === 'draw' && this.drawShapeMode === 'bezier') {
          this.drawShapeMode = 'free';
          this.clearBezierDraft();
        } else {
          this.mode = 'draw';
          this.drawShapeMode = 'bezier';
          this.selectedShape = 'brick';
          this.clearBezierDraft();
          if (this.onModeChange) this.onModeChange(this.mode);
        }
      } else if (e.key === 'Enter' && this.mode === 'draw' && this.drawShapeMode === 'bezier') {
        e.preventDefault();
        if (this.bezierDraft && this.ghostBricks.length > 0) {
          this.commitGhostBricks();
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

  getEventScreenPosition(e) {
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

  toWorldPosition(screenPos) {
    return {
      x: screenPos.x,
      y: screenPos.y + this.getCameraY()
    };
  }

  getEventPosition(e) {
    return this.toWorldPosition(this.getEventScreenPosition(e));
  }

  isMiddlePanEvent(e) {
    return !!e && !e.touches && e.button === 1;
  }

  isSurvivalMode() {
    return this.survivalRuntime.isEnabled();
  }

  getCameraY() {
    return this.survivalRuntime.getCameraY();
  }

  getWorldHeight() {
    return this.isSurvivalMode() ? this.survivalRuntime.getWorldHeight() : this.canvas.height;
  }

  setSurvivalSettings(settings) {
    const normalized = this.survivalRuntime.configure(settings);
    if (!normalized.enabled) {
      this.survivalRuntime.setCameraY(0);
    } else {
      this.survivalRuntime.setCameraY(this.survivalRuntime.getCameraY());
    }
    return normalized;
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
      } else if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
        const halfLen = PHYSICS_CONFIG.pegRadius * (peg.portalScale || 1);
        const halfThick = Math.max(4, PHYSICS_CONFIG.pegRadius * 0.45);
        const cos = Math.cos(-(peg.angle || 0));
        const sin = Math.sin(-(peg.angle || 0));
        const dx = x - peg.x;
        const dy = y - peg.y;
        const localX = dx * cos - dy * sin;
        const localY = dx * sin + dy * cos;
        if (Math.abs(localX) <= halfLen + 8 && Math.abs(localY) <= halfThick + 8) {
          return peg;
        }
      } else {
        const baseRadius = peg.type === 'bumper'
          ? PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1)
          : PHYSICS_CONFIG.pegRadius;
        if (Utils.distance(x, y, peg.x, peg.y) <= baseRadius + 8) {
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
    const minYBase = this.isSurvivalMode() ? 0 : 50;
    const maxYBase = this.isSurvivalMode() ? this.getWorldHeight() : (this.canvas.height - 35);
    return {
      minX: -marginX,
      maxX: this.canvas.width + marginX,
      minY: minYBase - marginY,
      maxY: maxYBase + marginY
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
        let extentX;
        let extentY;
        if (peg.shape === 'brick') {
          const r = Math.max(peg.width || 40, peg.height || 12) / 2;
          extentX = r;
          extentY = r;
        } else if (peg.type === 'bumper') {
          const r = PHYSICS_CONFIG.pegRadius * (peg.bumperScale || 1);
          extentX = r;
          extentY = r;
        } else if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
          const halfLen = PHYSICS_CONFIG.pegRadius * (peg.portalScale || 1);
          const halfThick = Math.max(2, PHYSICS_CONFIG.pegRadius * 0.25);
          const c = Math.abs(Math.cos(peg.angle || 0));
          const s = Math.abs(Math.sin(peg.angle || 0));
          extentX = c * halfLen + s * halfThick;
          extentY = s * halfLen + c * halfThick;
        } else {
          extentX = PHYSICS_CONFIG.pegRadius;
          extentY = PHYSICS_CONFIG.pegRadius;
        }

        minX = Math.min(minX, peg.x - extentX);
        minY = Math.min(minY, peg.y - extentY);
        maxX = Math.max(maxX, peg.x + extentX);
        maxY = Math.max(maxY, peg.y + extentY);
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

  clearBezierDraft(resetPreview = true) {
    this.bezierDraft = null;
    this.activeBezierGroupId = null;
    if (resetPreview) {
      this.drawPath = [];
      this.ghostBricks = [];
    }
    this._bezierDragStart = null;
  }

  createBezierDraft(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const d = Math.hypot(dx, dy);
    if (d < 10) return null;

    const ux = dx / d;
    const uy = dy / d;
    const handleLen = Math.max(20, d * 0.28);

    this.bezierDraft = {
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
      h1: { x: start.x + ux * handleLen, y: start.y + uy * handleLen },
      h2: { x: end.x - ux * handleLen, y: end.y - uy * handleLen },
      bend: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
    };
    this.activeBezierGroupId = null;

    this.updateBezierDraftPath();
    return this.bezierDraft;
  }

  ensureBezierCurveStore(level) {
    if (!level || typeof level !== 'object') return {};
    if (!level.bezierCurves || typeof level.bezierCurves !== 'object' || Array.isArray(level.bezierCurves)) {
      level.bezierCurves = {};
    }
    return level.bezierCurves;
  }

  estimateRigidTransformFromPairs(pairs) {
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    let srcCx = 0, srcCy = 0, dstCx = 0, dstCy = 0;
    for (const p of pairs) {
      srcCx += p.sx;
      srcCy += p.sy;
      dstCx += p.dx;
      dstCy += p.dy;
    }
    srcCx /= pairs.length;
    srcCy /= pairs.length;
    dstCx /= pairs.length;
    dstCy /= pairs.length;

    let sumDot = 0;
    let sumCross = 0;
    for (const p of pairs) {
      const ax = p.sx - srcCx;
      const ay = p.sy - srcCy;
      const bx = p.dx - dstCx;
      const by = p.dy - dstCy;
      sumDot += ax * bx + ay * by;
      sumCross += ax * by - ay * bx;
    }

    const angle = Math.atan2(sumCross, sumDot);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tx = dstCx - (srcCx * cos - srcCy * sin);
    const ty = dstCy - (srcCx * sin + srcCy * cos);
    return { angle, tx, ty };
  }

  getCircularMeanAngle(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    let sx = 0;
    let sy = 0;
    for (const a of values) {
      sx += Math.cos(a || 0);
      sy += Math.sin(a || 0);
    }
    if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return 0;
    return Math.atan2(sy, sx);
  }

  estimateBezierGroupTransform(groupPegs, data) {
    if (!Array.isArray(groupPegs) || groupPegs.length === 0 || !data) return null;

    // Preferred: exact point correspondences via bezierIndex/refPoints.
    const refMap = new Map();
    if (Array.isArray(data.refPoints)) {
      for (const rp of data.refPoints) {
        if (rp && Number.isFinite(rp.index) && Number.isFinite(rp.x) && Number.isFinite(rp.y)) {
          refMap.set(rp.index, rp);
        }
      }
    }

    const exactPairs = [];
    for (const peg of groupPegs) {
      if (!Number.isFinite(peg?.bezierIndex)) continue;
      const rp = refMap.get(peg.bezierIndex);
      if (!rp) continue;
      exactPairs.push({ sx: rp.x, sy: rp.y, dx: peg.x, dy: peg.y });
    }
    if (exactPairs.length >= 2) {
      return this.estimateRigidTransformFromPairs(exactPairs);
    }

    // Fallback for legacy groups: estimate from centroid + mean tangent angle.
    const draft = {
      start: data.start,
      end: data.end,
      h1: data.h1,
      h2: data.h2
    };
    const samples = this.sampleBezierDraft(draft, 96);
    const ghosts = this.computeGhostBricksFromSamples(samples, false, 'brick');
    if (!ghosts || ghosts.length === 0) return null;

    let srcCx = 0, srcCy = 0;
    for (const g of ghosts) {
      srcCx += g.x;
      srcCy += g.y;
    }
    srcCx /= ghosts.length;
    srcCy /= ghosts.length;

    let dstCx = 0, dstCy = 0;
    for (const p of groupPegs) {
      dstCx += p.x;
      dstCy += p.y;
    }
    dstCx /= groupPegs.length;
    dstCy /= groupPegs.length;

    const srcAngle = this.getCircularMeanAngle(ghosts.map(g => g.angle || 0));
    const dstAngle = this.getCircularMeanAngle(groupPegs.map(p => p.angle || 0));
    const angle = dstAngle - srcAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tx = dstCx - (srcCx * cos - srcCy * sin);
    const ty = dstCy - (srcCx * sin + srcCy * cos);
    return { angle, tx, ty };
  }

  applyRigidTransform(point, transform) {
    if (!point || !transform) return point ? { x: point.x, y: point.y } : null;
    const cos = Math.cos(transform.angle || 0);
    const sin = Math.sin(transform.angle || 0);
    return {
      x: point.x * cos - point.y * sin + (transform.tx || 0),
      y: point.x * sin + point.y * cos + (transform.ty || 0)
    };
  }

  beginEditBezierGroup(groupId) {
    const level = this.levelManager.getCurrentLevel();
    if (!level || !groupId) return false;

    const store = this.ensureBezierCurveStore(level);
    const data = store[groupId];
    if (!data || !data.start || !data.end || !data.h1 || !data.h2) return false;
    const groupPegs = level.pegs.filter(p => p.bezierGroupId === groupId);
    const transform = this.estimateBezierGroupTransform(groupPegs, data);

    const start = transform ? this.applyRigidTransform(data.start, transform) : { x: data.start.x, y: data.start.y };
    const end = transform ? this.applyRigidTransform(data.end, transform) : { x: data.end.x, y: data.end.y };
    const h1 = transform ? this.applyRigidTransform(data.h1, transform) : { x: data.h1.x, y: data.h1.y };
    const h2 = transform ? this.applyRigidTransform(data.h2, transform) : { x: data.h2.x, y: data.h2.y };

    this.mode = 'draw';
    this.drawShapeMode = 'bezier';
    this.activeBezierGroupId = groupId;
    this.bezierDraft = {
      start,
      end,
      h1,
      h2,
      bend: { x: 0, y: 0 }
    };
    if (groupPegs.length > 0) {
      this.selectedPegType = groupPegs[0].type || this.selectedPegType;
    } else if (data.pegType) {
      this.selectedPegType = data.pegType;
    }
    this.selectedShape = 'brick';
    this._bezierDragStart = null;
    this.updateBezierDraftPath();
    if (this.onModeChange) this.onModeChange(this.mode);
    return true;
  }

  getBezierControlAt(x, y) {
    if (!this.bezierDraft) return null;
    const hitRadius = 14;
    const d = this.bezierDraft;

    if (Utils.distance(x, y, d.start.x, d.start.y) <= hitRadius) return 'bezierStart';
    if (Utils.distance(x, y, d.end.x, d.end.y) <= hitRadius) return 'bezierEnd';
    if (Utils.distance(x, y, d.h1.x, d.h1.y) <= hitRadius) return 'bezierHandle1';
    if (Utils.distance(x, y, d.h2.x, d.h2.y) <= hitRadius) return 'bezierHandle2';
    if (Utils.distance(x, y, d.bend.x, d.bend.y) <= hitRadius) return 'bezierBend';
    return null;
  }

  snapVector45(dx, dy) {
    const mag = Math.hypot(dx, dy);
    if (mag < 0.001) return { dx, dy };
    const step = Math.PI / 4;
    const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
    return {
      dx: Math.cos(snapped) * mag,
      dy: Math.sin(snapped) * mag
    };
  }

  applyBezierHandleDrag(which, targetPos, shiftKey = false) {
    if (!this.bezierDraft) return;
    const d = this.bezierDraft;
    const anchor = which === 'bezierHandle1' ? d.start : d.end;
    let nx = targetPos.x;
    let ny = targetPos.y;

    if (shiftKey) {
      const snapped = this.snapVector45(nx - anchor.x, ny - anchor.y);
      nx = anchor.x + snapped.dx;
      ny = anchor.y + snapped.dy;
    }

    if (which === 'bezierHandle1') {
      d.h1.x = nx;
      d.h1.y = ny;
    } else {
      d.h2.x = nx;
      d.h2.y = ny;
    }
    this.updateBezierDraftPath();
  }

  beginBezierBendDrag(startPos) {
    if (!this.bezierDraft) return;
    this._bezierDragStart = {
      mouse: { x: startPos.x, y: startPos.y },
      h1: { ...this.bezierDraft.h1 },
      h2: { ...this.bezierDraft.h2 }
    };
  }

  beginBezierAnchorDrag(which, startPos) {
    if (!this.bezierDraft) return;
    this._bezierDragStart = {
      which,
      mouse: { x: startPos.x, y: startPos.y },
      start: { ...this.bezierDraft.start },
      end: { ...this.bezierDraft.end },
      h1: { ...this.bezierDraft.h1 },
      h2: { ...this.bezierDraft.h2 }
    };
  }

  applyBezierAnchorDrag(which, pos, shiftKey = false) {
    if (!this.bezierDraft || !this._bezierDragStart) return;
    const s = this._bezierDragStart;
    const draft = this.bezierDraft;

    let dx = pos.x - s.mouse.x;
    let dy = pos.y - s.mouse.y;

    if (which === 'bezierStart') {
      let nextX = s.start.x + dx;
      let nextY = s.start.y + dy;
      if (shiftKey) {
        const snapped = this.snapVector45(nextX - s.end.x, nextY - s.end.y);
        nextX = s.end.x + snapped.dx;
        nextY = s.end.y + snapped.dy;
      }
      const moveX = nextX - s.start.x;
      const moveY = nextY - s.start.y;
      draft.start.x = nextX;
      draft.start.y = nextY;
      draft.h1.x = s.h1.x + moveX;
      draft.h1.y = s.h1.y + moveY;
    } else {
      let nextX = s.end.x + dx;
      let nextY = s.end.y + dy;
      if (shiftKey) {
        const snapped = this.snapVector45(nextX - s.start.x, nextY - s.start.y);
        nextX = s.start.x + snapped.dx;
        nextY = s.start.y + snapped.dy;
      }
      const moveX = nextX - s.end.x;
      const moveY = nextY - s.end.y;
      draft.end.x = nextX;
      draft.end.y = nextY;
      draft.h2.x = s.h2.x + moveX;
      draft.h2.y = s.h2.y + moveY;
    }

    this.updateBezierDraftPath();
  }

  applyBezierBendDrag(pos, shiftKey = false) {
    if (!this.bezierDraft || !this._bezierDragStart) return;
    let dx = pos.x - this._bezierDragStart.mouse.x;
    let dy = pos.y - this._bezierDragStart.mouse.y;
    if (shiftKey) {
      const snapped = this.snapVector45(dx, dy);
      dx = snapped.dx;
      dy = snapped.dy;
    }
    this.bezierDraft.h1.x = this._bezierDragStart.h1.x + dx;
    this.bezierDraft.h1.y = this._bezierDragStart.h1.y + dy;
    this.bezierDraft.h2.x = this._bezierDragStart.h2.x + dx;
    this.bezierDraft.h2.y = this._bezierDragStart.h2.y + dy;
    this.updateBezierDraftPath();
  }

  getBezierPointAndTangent(t, p0, p1, p2, p3) {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    const x = (uuu * p0.x)
      + (3 * uu * t * p1.x)
      + (3 * u * tt * p2.x)
      + (ttt * p3.x);

    const y = (uuu * p0.y)
      + (3 * uu * t * p1.y)
      + (3 * u * tt * p2.y)
      + (ttt * p3.y);

    const dx = 3 * uu * (p1.x - p0.x)
      + 6 * u * t * (p2.x - p1.x)
      + 3 * tt * (p3.x - p2.x);
    const dy = 3 * uu * (p1.y - p0.y)
      + 6 * u * t * (p2.y - p1.y)
      + 3 * tt * (p3.y - p2.y);

    return {
      x,
      y,
      angle: Math.atan2(dy, dx)
    };
  }

  sampleBezierDraft(draft = this.bezierDraft, minPoints = 96) {
    if (!draft) return [];
    const p0 = draft.start;
    const p1 = draft.h1;
    const p2 = draft.h2;
    const p3 = draft.end;

    const approxLen = Utils.distance(p0.x, p0.y, p1.x, p1.y)
      + Utils.distance(p1.x, p1.y, p2.x, p2.y)
      + Utils.distance(p2.x, p2.y, p3.x, p3.y);
    const points = Math.max(minPoints, Math.ceil(approxLen / 2));
    const samples = [];

    let prevAngle = 0;
    for (let i = 0; i <= points; i++) {
      const t = i / points;
      const pt = this.getBezierPointAndTangent(t, p0, p1, p2, p3);
      if (!Number.isFinite(pt.angle)) pt.angle = prevAngle;
      prevAngle = pt.angle;
      samples.push(pt);
    }
    return samples;
  }

  updateBezierDraftPath() {
    if (!this.bezierDraft) {
      this.drawPath = [];
      this.ghostBricks = [];
      return;
    }

    const samples = this.sampleBezierDraft(this.bezierDraft);
    this.drawPath = samples.map(s => ({ x: s.x, y: s.y }));
    this.ghostBricks = this.computeGhostBricksFromSamples(samples, false, 'brick');

    const mid = this.getBezierPointAndTangent(
      0.5,
      this.bezierDraft.start,
      this.bezierDraft.h1,
      this.bezierDraft.h2,
      this.bezierDraft.end
    );
    this.bezierDraft.bend = { x: mid.x, y: mid.y };
  }

  // Draw mode - collect points and update ghost preview
  // SHIFT = straight line snapped to nearest 10° from start point
  continueDraw(x, y, shiftKey = false) {
    if (this.drawShapeMode === 'bezier') {
      if (this.bezierDraft) {
        this.updateBezierDraftPath();
        return;
      }
      if (this.drawPath.length === 0) return;

      const start = this.drawPath[0];
      let endX = x;
      let endY = y;
      if (shiftKey) {
        const snapped = this.snapVector45(endX - start.x, endY - start.y);
        endX = start.x + snapped.dx;
        endY = start.y + snapped.dy;
      }

      this.drawPath = [start, { x: endX, y: endY }];

      const dx = endX - start.x;
      const dy = endY - start.y;
      const length = Math.hypot(dx, dy);
      if (length < 10) {
        this.ghostBricks = [];
        return;
      }

      const steps = Math.max(24, Math.ceil(length / 2));
      const angle = Math.atan2(dy, dx);
      const samples = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        samples.push({
          x: start.x + dx * t,
          y: start.y + dy * t,
          angle
        });
      }
      this.ghostBricks = this.computeGhostBricksFromSamples(samples, false, 'brick');
      return;
    }

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
  computeGhostBricksFromSamples(samples, closedLoop = false, forceShape = null) {
    if (samples.length < 2) return [];

    const effectiveShape = forceShape || this.selectedShape;
    const isBrick = effectiveShape === 'brick';
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
    const draftSnapshot = this.bezierDraft
      ? {
          start: { ...this.bezierDraft.start },
          end: { ...this.bezierDraft.end },
          h1: { ...this.bezierDraft.h1 },
          h2: { ...this.bezierDraft.h2 }
        }
      : null;
    const previousBezierGroupId = this.activeBezierGroupId;
    const isBezierCommit = this.drawShapeMode === 'bezier' && !!draftSnapshot;
    const bezierGroupId = isBezierCommit ? (previousBezierGroupId || Utils.generateId()) : null;

    this.ghostBricks = [];
    this.drawPath = [];
    this.bezierDraft = null;
    this.activeBezierGroupId = null;
    this._bezierDragStart = null;
    if (!level || toCommit.length === 0) return;
    this.saveUndoState();

    if (isBezierCommit && previousBezierGroupId) {
      level.pegs = level.pegs.filter(p => p.bezierGroupId !== previousBezierGroupId);
    }

    if (isBezierCommit && draftSnapshot && bezierGroupId) {
      const store = this.ensureBezierCurveStore(level);
      const bezierShape = 'brick';
      store[bezierGroupId] = {
        start: draftSnapshot.start,
        end: draftSnapshot.end,
        h1: draftSnapshot.h1,
        h2: draftSnapshot.h2,
        pegType: this.selectedPegType,
        pegShape: bezierShape,
        refPoints: toCommit.map((gb, index) => ({
          index,
          x: gb.x,
          y: gb.y
        }))
      };
    }

    const commitShape = isBezierCommit ? 'brick' : this.selectedShape;
    const isBrick = commitShape === 'brick';
    const w = this.getBrickWidth();
    const h = this.getBrickHeight();
    for (let i = 0; i < toCommit.length; i++) {
      const gb = toCommit[i];
      const pegData = {
        x: gb.x,
        y: gb.y,
        type: this.selectedPegType,
        shape: commitShape,
        angle: isBrick ? gb.angle : 0
      };
      if (isBezierCommit && bezierGroupId) {
        pegData.bezierGroupId = bezierGroupId;
        pegData.bezierIndex = i;
      }
      if (isBrick) {
        pegData.width = w;
        pegData.height = h;
        if (gb.slices) pegData.curveSlices = gb.slices;
      }
      if (!this.isPegPositionAllowed(pegData, pegData.x, pegData.y, pegData.angle, pegData.curveSlices)) continue;
      const newPeg = this.levelManager.addPeg(pegData);
    }

    // Cleanup legacy artifacts from early bezier versions that committed circles
    // along the same path without bezierGroupId metadata.
    if (isBezierCommit && toCommit.length > 0) {
      const near = PHYSICS_CONFIG.pegRadius * 0.9;
      const legacyIds = [];
      for (const peg of level.pegs) {
        if (peg.bezierGroupId || peg.groupId) continue;
        if (peg.shape !== 'circle') continue;
        if (peg.type !== this.selectedPegType) continue;
        for (const gb of toCommit) {
          if (Utils.distance(peg.x, peg.y, gb.x, gb.y) <= near) {
            legacyIds.push(peg.id);
            break;
          }
        }
      }
      if (legacyIds.length >= 3) {
        const idSet = new Set(legacyIds);
        level.pegs = level.pegs.filter(p => !idSet.has(p.id));
      }
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
    
    const forceCircle = this.selectedPegType === 'bumper'
      || this.selectedPegType === 'portalBlue'
      || this.selectedPegType === 'portalOrange';
    const shape = forceCircle ? 'circle' : this.selectedShape;

    const pegData = {
      x: x,
      y: y,
      type: this.selectedPegType,
      shape: shape,
      angle: shape === 'brick' || this.selectedPegType === 'portalBlue' || this.selectedPegType === 'portalOrange'
        ? this.currentRotation
        : 0
    };

    if (shape === 'brick') {
      pegData.width = this.getBrickWidth();
      pegData.height = this.getBrickHeight();
    }

    if (this.selectedPegType === 'bumper') {
      pegData.bumperBounce = 2.0;
      pegData.bumperScale = 1.0;
    }
    if (this.selectedPegType === 'portalBlue' || this.selectedPegType === 'portalOrange') {
      pegData.portalScale = 1.0;
      pegData.portalOneWay = false;
      pegData.portalOneWayFlip = false;
    }
    if (this.selectedPegType === 'multi') {
      pegData.multiballSpawnCount = MULTIBALL_DEFAULT_SPAWN_COUNT;
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
        if (type === 'bumper') {
          peg.shape = 'circle';
          if (peg.bumperBounce == null) peg.bumperBounce = 2.0;
          if (peg.bumperScale == null) peg.bumperScale = 1.0;
          delete peg.portalScale;
          delete peg.portalOneWay;
          delete peg.portalOneWayFlip;
          delete peg.multiballSpawnCount;
        } else if (type === 'portalBlue' || type === 'portalOrange') {
          peg.shape = 'circle';
          if (peg.portalScale == null) peg.portalScale = 1.0;
          if (peg.portalOneWay == null) peg.portalOneWay = false;
          if (peg.portalOneWayFlip == null) peg.portalOneWayFlip = false;
          delete peg.bumperBounce;
          delete peg.bumperScale;
          delete peg.bumperDisappear;
          delete peg.bumperOrange;
          delete peg._bumperHitScale;
          delete peg.multiballSpawnCount;
        } else if (type === 'multi') {
          peg.multiballSpawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
          delete peg.bumperBounce;
          delete peg.bumperScale;
          delete peg.bumperDisappear;
          delete peg.bumperOrange;
          delete peg._bumperHitScale;
          delete peg.portalScale;
          delete peg.portalOneWay;
          delete peg.portalOneWayFlip;
        } else {
          // Clean up bumper properties when changing away
          delete peg.bumperBounce;
          delete peg.bumperScale;
          delete peg.bumperDisappear;
          delete peg.bumperOrange;
          delete peg._bumperHitScale;
          delete peg.portalScale;
          delete peg.portalOneWay;
          delete peg.portalOneWayFlip;
          delete peg.multiballSpawnCount;
        }
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
        const forceCircle = peg.type === 'bumper'
          || peg.type === 'portalBlue'
          || peg.type === 'portalOrange';
        peg.shape = forceCircle ? 'circle' : shape;
        if (peg.shape === 'brick') {
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
        const pegData = {
          x: peg.x + offsetX,
          y: peg.y + offsetY,
          type: peg.type,
          shape: peg.shape,
          angle: peg.angle,
          width: peg.width,
          height: peg.height
        };
        if (peg.type === 'bumper') {
          pegData.bumperBounce = peg.bumperBounce;
          pegData.bumperScale = peg.bumperScale;
          pegData.bumperDisappear = peg.bumperDisappear;
          pegData.bumperOrange = peg.bumperOrange;
        }
        if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
          pegData.portalScale = peg.portalScale;
          pegData.portalOneWay = !!peg.portalOneWay;
          pegData.portalOneWayFlip = !!peg.portalOneWayFlip;
        }
        if (peg.type === 'multi') {
          pegData.multiballSpawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
        }
        const newPeg = this.levelManager.addPeg(pegData);
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
        const pegData = {
          x: peg.x,
          y: peg.y,
          type: peg.type,
          shape: peg.shape,
          angle: peg.angle,
          width: peg.width,
          height: peg.height
        };
        if (peg.type === 'bumper') {
          pegData.bumperBounce = peg.bumperBounce;
          pegData.bumperScale = peg.bumperScale;
          pegData.bumperDisappear = peg.bumperDisappear;
          pegData.bumperOrange = peg.bumperOrange;
        }
        if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
          pegData.portalScale = peg.portalScale;
          pegData.portalOneWay = !!peg.portalOneWay;
          pegData.portalOneWayFlip = !!peg.portalOneWayFlip;
        }
        if (peg.type === 'multi') {
          pegData.multiballSpawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
        }
        const newPeg = this.levelManager.addPeg(pegData);
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
    const survivalOn = this.isSurvivalMode();
    const renderPegs = (level && this.mode === 'draw' && this.drawShapeMode === 'bezier' && this.bezierDraft && this.activeBezierGroupId)
      ? level.pegs.filter(p => p.bezierGroupId !== this.activeBezierGroupId)
      : (level ? level.pegs : []);
    const wrapCopyPegIds = (this.animationPreview && this.animationPreviewAnimator)
      ? this.animationPreviewAnimator.getAnimatedPegIds()
      : null;

    // Tick animation preview if active
    if (this.animationPreview && this.animationPreviewAnimator && level) {
      this.animationPreviewAnimator.tick(level.pegs, 1 / 60, this.getAnimationWorldBounds());
    }

    const hasSelection = !this.animationMode && this.selectedPegIds.size > 0;
    const rotationHandle = hasSelection ? this.getRotationHandlePosition() : null;
    const isBumperSelection = hasSelection && this.isSelectionAllBumpers();

    this.renderer.renderGame({
      pegs: renderPegs,
      hitPegIds: [],
      wrapCopyPegIds,
      selectedPegIds: this.selectedPegIds,
      ball: null,
      bucket: null,
      cameraY: this.getCameraY(),
      showLauncher: false,
      showGrid: this.showGrid,
      selectionBox: this.selectionBox,
      rotationHandle: rotationHandle,
      isBumperSelection: isBumperSelection,
      selectionBounds: hasSelection ? this.getSelectionBounds() : null,
      isEditor: true,
      drawMode: this.mode === 'draw',
      drawShapeMode: this.drawShapeMode,
      drawBezier: this.bezierDraft,
      drawCenter: (this.drawShapeMode !== 'free' && this.isInteracting && this.interactionType === 'draw')
        ? { x: this.startX, y: this.startY } : null,
      ghostBricks: this.ghostBricks,
      drawPath: this.drawPath,
      brickWidth: this.getBrickWidth(),
      brickHeight: this.getBrickHeight(),
      pegType: this.selectedPegType,
      pegShape: (this.mode === 'draw' && this.drawShapeMode === 'bezier') ? 'brick' : this.selectedShape,
      // Animation mode state
      animationMode: this.animationMode && !this.animationPreview,
      animationGhosts: (this.animationMode && !this.animationPreview) ? this.getAnimationGhosts() : null,
      animationCenter: (this.animationMode && !this.animationPreview) ? this.getAnimationCenter() : null,
      animationGhostCenter: (this.animationMode && !this.animationPreview) ? this.getAnimationGhostCenter() : null,
      animationMotion: (this.animationMode && !this.animationPreview) ? this.resolveAnimationMotion() : null,
      animationInverse: this.animationMode && !this.animationPreview ? this.animationInverse : false,
      animationCircularPath: this.animationMode && !this.animationPreview ? this.animationCircularPath : false,
      animationCircularFull: this.animationMode && !this.animationPreview ? this.animationCircularFull : false,
      animationGhostOffset: this.animationGhostOffset,
      groups: level ? level.groups : [],
      // Flippers
      flippers: level ? level.flippers : null,
      flipperSelected: this.flipperSelected,
      survivalLoseLineY: survivalOn ? this.survivalRuntime.getLoseLineY() : null,
      verticalProgress: survivalOn ? this.survivalRuntime.getTrackerState() : null
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
    this.survivalRuntime.resize(height);
    const level = this.levelManager.getCurrentLevel();
    if (level) {
      this.survivalRuntime.configure(ensureLevelSurvival(level, height));
    }
  }

  setSelectedPegType(type) {
    this.selectedPegType = type;
  }

  setSelectedShape(shape) {
    this.selectedShape = shape;
  }

  setMode(mode) {
    if (this.mode === 'draw' && mode !== 'draw') {
      this.clearBezierDraft();
    }
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

  // ── Bumper Helpers ──

  isSelectionAllBumpers() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return false;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (!peg || peg.type !== 'bumper') return false;
    }
    return true;
  }

  isSelectionAllPortals() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return false;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (!peg || (peg.type !== 'portalBlue' && peg.type !== 'portalOrange')) return false;
    }
    return true;
  }

  isSelectionAllMultiballs() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return false;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (!peg || peg.type !== 'multi') return false;
    }
    return true;
  }

  getSelectedBumperScales() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return new Map();
    const scales = new Map();
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && peg.type === 'bumper') {
        scales.set(pegId, peg.bumperScale || 1.0);
      }
    }
    return scales;
  }

  setSelectedBumperScales(startScales, ratio) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    for (const [pegId, startScale] of startScales) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        peg.bumperScale = Utils.clamp(startScale * ratio, 0.5, 7.0);
      }
    }
  }

  setSelectedBumperBounce(bounce) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && peg.type === 'bumper') {
        peg.bumperBounce = bounce;
      }
    }
    this.levelManager.save();
  }

  getSelectedBumperProperties() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return null;
    // Return properties of first selected bumper
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && peg.type === 'bumper') {
        return {
          bounce: peg.bumperBounce ?? 2.0,
          scale: peg.bumperScale ?? 1.0,
          disappear: !!peg.bumperDisappear,
          orange: !!peg.bumperOrange
        };
      }
    }
    return null;
  }

  setSelectedPortalScale(scale) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    const clamped = Utils.clamp(scale, 0.5, 5.0);
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange')) {
        peg.portalScale = clamped;
      }
    }
    this.levelManager.save();
  }

  setSelectedPortalOneWay(oneWay) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    const enabled = !!oneWay;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange')) {
        peg.portalOneWay = enabled;
      }
    }
    this.levelManager.save();
  }

  setSelectedPortalOneWayFlip(oneWayFlip) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    const enabled = !!oneWayFlip;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange')) {
        peg.portalOneWayFlip = enabled;
      }
    }
    this.levelManager.save();
  }

  getSelectedPortalProperties() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return null;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && (peg.type === 'portalBlue' || peg.type === 'portalOrange')) {
        return {
          scale: peg.portalScale ?? 1.0,
          oneWay: !!peg.portalOneWay,
          oneWayFlip: !!peg.portalOneWayFlip
        };
      }
    }
    return null;
  }

  setSelectedMultiballSpawnCount(count) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    const normalized = normalizeMultiballSpawnCount(count);
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && peg.type === 'multi') {
        peg.multiballSpawnCount = normalized;
      }
    }
    this.levelManager.save();
  }

  getSelectedMultiballProperties() {
    const level = this.levelManager.getCurrentLevel();
    if (!level || this.selectedPegIds.size === 0) return null;
    for (const pegId of this.selectedPegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg && peg.type === 'multi') {
        return {
          spawnCount: normalizeMultiballSpawnCount(peg.multiballSpawnCount)
        };
      }
    }
    return null;
  }

  // Callback for bumper panel sync
  onBumperPropertyChange = null;

  // ── Flipper Helpers ──

  isNearFlipper(pos) {
    const f = normalizeFlipperConfig(this.levelManager.getFlippers(), {
      canvasHeight: this.canvas.height,
      cameraY: this.getCameraY(),
      bounce: PHYSICS_CONFIG.bounce
    });
    if (!f || !f.enabled) return false;
    const cx = this.canvas.width / 2;
    const sc = Number.isFinite(f.scale) ? f.scale : 1.8;
    const len = (Number.isFinite(f.length) ? f.length : 60) * sc;

    for (const side of [-1, 1]) {
      const px = cx + side * f.xOffset;
      const restRad = (Number.isFinite(f.restAngle) ? f.restAngle : 23) * Math.PI / 180;
      const angle = (side === -1) ? restRad : (Math.PI - restRad);
      const tipX = px + Math.cos(angle) * len;
      const tipY = f.y + Math.sin(angle) * len;
      const midX = (px + tipX) / 2;
      const midY = (f.y + tipY) / 2;

      if (Utils.distance(pos.x, pos.y, px, f.y) < 18) return true;
      if (Utils.distance(pos.x, pos.y, tipX, tipY) < 18) return true;
      if (Utils.distance(pos.x, pos.y, midX, midY) < 18) return true;
    }
    return false;
  }

  deselectFlippers() {
    if (this.flipperSelected) {
      this.flipperSelected = false;
      if (this.onFlipperSelectionChange) this.onFlipperSelectionChange(false);
    }
  }

  deleteFlippers() {
    this.levelManager.setFlippers(null);
    this.flipperSelected = false;
    if (this.onFlipperSelectionChange) this.onFlipperSelectionChange(false);
    if (this.onFlippersDeleted) this.onFlippersDeleted();
  }

  // ── Animation Mode ──

  getAnimationWorldBounds() {
    return { width: this.canvas.width, height: this.getWorldHeight() };
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
    this.animationHitTrigger = !!existing?.hitTrigger;
    this.animationHitMode = existing?.hitMode || 'cycle';
    this.animationHitSteps = existing?.hitSteps || 1;
    this.animationCircularPath = !!existing?.circularPath;
    this.animationCircularFull = !!existing?.circularFull;
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
    this.animationHitTrigger = false;
    this.animationHitMode = 'cycle';
    this.animationHitSteps = 1;
    this.animationCircularPath = false;
    this.animationCircularFull = false;
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
      cycle: !!animData?.cycle,
      hitTrigger: !!animData?.hitTrigger,
      hitMode: animData?.hitMode || 'cycle',
      hitSteps: Math.max(1, Math.round(animData?.hitSteps || 1)),
      circularPath: !!animData?.circularPath,
      circularFull: !!animData?.circularFull,
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
    this.animationCircularPath = false;
    this.animationCircularFull = false;
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
      wrap: true,
      circularPath: this.animationCircularPath,
      circularFull: this.animationCircularFull,
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
