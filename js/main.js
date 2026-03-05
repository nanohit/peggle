// Peggle Main - App initialization and UI management

import { Game } from './game.js';
import { Editor } from './editor.js';
import { LevelManager } from './levels.js';
import { PHYSICS_CONFIG } from './physics.js';
import { FLIPPER_DEFAULTS, createDefaultFlipperConfig, normalizeFlipperConfig } from './flipper-defaults.js';
import { ensureLevelSurvival, normalizeSurvivalSettings } from './survival-mode.js';
import { GambleSystem } from './gamble-system.js';
import { normalizeYoyoSettings } from './yoyo-thread.js';

// Fixed aspect ratio: 3:4.5 (width:height)
const ASPECT_RATIO = 3 / 4.5;
const MAX_WIDTH = 400;

class PeggleApp {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    
    this.levelManager = new LevelManager();
    this.game = null;
    this.editor = null;
    this.gambleSystem = null;
    
    this.mode = 'editor'; // 'editor' or 'play'
    
    this.setupCanvas();
    this.setupUI();
    this.initMode();
  }

  setupCanvas() {
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  resizeCanvas() {
    const container = document.getElementById('canvasContainer');
    const containerRect = container.getBoundingClientRect();
    
    // Calculate canvas size maintaining aspect ratio
    let width = Math.min(containerRect.width, MAX_WIDTH);
    let height = width / ASPECT_RATIO;
    
    // If height exceeds container, scale down
    if (height > containerRect.height) {
      height = containerRect.height;
      width = height * ASPECT_RATIO;
    }
    
    // Set canvas size
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    
    if (this.game) this.game.resize(width, height);
    if (this.editor) this.editor.resize(width, height);

    const level = this.levelManager.getCurrentLevel();
    if (level) {
      const prev = level.survival ? { ...level.survival } : null;
      const normalized = ensureLevelSurvival(level, height);
      if (
        !prev ||
        prev.enabled !== normalized.enabled ||
        prev.worldHeight !== normalized.worldHeight ||
        prev.scrollSpeed !== normalized.scrollSpeed ||
        prev.loseLineY !== normalized.loseLineY
      ) {
        this.levelManager.save();
      }
      if (this.editor) {
        this.editor.setSurvivalSettings(normalized);
      }
      this.updateLevelSettings();
    }
  }

  setupUI() {
    // Menu button
    document.getElementById('menuBtn').addEventListener('click', () => {
      this.toggleMenu();
    });

    // Play button
    document.getElementById('playBtn').addEventListener('click', () => {
      this.togglePlayMode();
    });

    // Peg type buttons
    document.querySelectorAll('.peg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const selectedType = btn.dataset.type;
        document.querySelectorAll('.peg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.editor) {
          this.editor.setSelectedPegType(selectedType);
          const forceCircleShape = this._isCircleOnlyType(selectedType);
          if (forceCircleShape) {
            this.editor.setSelectedShape('circle');
            this._setActiveShapeButton('circle');
          }
          // Also change type of selected pegs
          if (this.editor.selectedPegIds.size > 0) {
            this.editor.setSelectedPegsType(selectedType);
            this.syncSelectionPanels();
          }
        }
      });
    });

    // Shape buttons
    document.querySelectorAll('.shape-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this.editor && this._isCircleOnlyType(this.editor.selectedPegType)) {
          this.editor.setSelectedShape('circle');
          this._setActiveShapeButton('circle');
          return;
        }
        document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.editor) {
          this.editor.setSelectedShape(btn.dataset.shape);
          if (this.editor.selectedPegIds.size > 0) {
            this.editor.setSelectedPegsShape(btn.dataset.shape);
          }
        }
      });
    });

    // Tool buttons
    document.getElementById('gridBtn').addEventListener('click', () => {
      if (this.editor) {
        const gridOn = this.editor.toggleGrid();
        document.getElementById('gridBtn').classList.toggle('active', gridOn);
      }
    });

    document.getElementById('magnetBtn').addEventListener('click', () => {
      if (this.editor) {
        const snapOn = this.editor.toggleSnap();
        document.getElementById('magnetBtn').classList.toggle('active', snapOn);
      }
    });

    document.getElementById('selectBtn').addEventListener('click', () => {
      if (this.editor) {
        const isSelect = this.editor.mode !== 'select';
        this.editor.setMode(isSelect ? 'select' : 'place');
        document.getElementById('selectBtn').classList.toggle('active', isSelect);
        document.getElementById('drawBtn').classList.remove('active');
      }
    });

    document.getElementById('drawBtn').addEventListener('click', () => {
      if (this.editor) {
        const isDraw = this.editor.mode !== 'draw';
        this.editor.setMode(isDraw ? 'draw' : 'place');
        document.getElementById('drawBtn').classList.toggle('active', isDraw);
        document.getElementById('selectBtn').classList.remove('active');
        // Auto-select brick shape for draw mode
        if (isDraw) {
          this.editor.setSelectedShape('brick');
          document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
          document.querySelector('.shape-btn[data-shape="brick"]').classList.add('active');
        }
      }
    });

    // Undo/Redo buttons
    document.getElementById('undoBtn').addEventListener('click', () => {
      if (this.editor) this.editor.undo();
    });

    document.getElementById('redoBtn').addEventListener('click', () => {
      if (this.editor) this.editor.redo();
    });

    // More tools button
    document.getElementById('moreBtn').addEventListener('click', () => {
      document.getElementById('actionsOverlay').classList.toggle('visible');
    });

    // Quick actions
    document.getElementById('mirrorHBtn').addEventListener('click', () => {
      if (this.editor) this.editor.mirrorHorizontal();
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('mirrorVBtn').addEventListener('click', () => {
      if (this.editor) this.editor.mirrorVertical();
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('duplicateBtn').addEventListener('click', () => {
      if (this.editor) this.editor.duplicateSelectedPegs();
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('deleteSelBtn').addEventListener('click', () => {
      if (this.editor) {
        if (this.editor.flipperSelected) {
          this.editor.deleteFlippers();
        } else {
          this.editor.deleteSelectedPegs();
        }
      }
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('groupBtn').addEventListener('click', () => {
      if (this.editor) {
        const group = this.editor.groupSelectedPegs();
        if (group) {
          alert(`Created group: ${group.name}`);
        } else {
          alert('Select at least 2 pegs to group');
        }
      }
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('rotateBtn').addEventListener('click', () => {
      if (this.editor) this.editor.rotateSelectedPegs(Math.PI / 12);
      document.getElementById('actionsOverlay').classList.remove('visible');
    });

    document.getElementById('animateBtn').addEventListener('click', () => {
      if (this.editor) {
        if (this.editor.selectedPegIds.size === 0) {
          alert('Select pegs to animate');
        } else {
          if (this.editor.enterAnimationMode()) {
            this.showAnimationPanel();
          }
        }
      }
    });

    // Flipper toggle button
    document.getElementById('flipperBtn').addEventListener('click', () => {
      if (!this.editor) return;
      const level = this.levelManager.getCurrentLevel();
      if (!level) return;

      if (level.flippers && level.flippers.enabled) {
        level.flippers.enabled = false;
        this.closeFlipperPanel();
      } else {
        const cameraY = this.editor?.getCameraY?.() || 0;
        const normalized = normalizeFlipperConfig(level.flippers, {
          canvasHeight: this.canvas.height,
          cameraY,
          bounce: PHYSICS_CONFIG.bounce
        });
        level.flippers = normalized || createDefaultFlipperConfig({
          canvasHeight: this.canvas.height,
          cameraY,
          bounce: PHYSICS_CONFIG.bounce,
          enabled: true
        });
        level.flippers.enabled = true;
        this.showFlipperPanel();
      }
      document.getElementById('flipperBtn').classList.toggle('active', level.flippers && level.flippers.enabled);
      this.levelManager.save();
    });

    // Close actions panel when clicking outside
    document.addEventListener('click', (e) => {
      const actionsOverlay = document.getElementById('actionsOverlay');
      const moreBtn = document.getElementById('moreBtn');
      if (!actionsOverlay.contains(e.target) && e.target !== moreBtn) {
        actionsOverlay.classList.remove('visible');
      }
    });

    // Menu actions
    document.getElementById('newLevelBtn').addEventListener('click', () => {
      this.newLevel();
      this.closeMenu();
    });

    document.getElementById('levelListBtn').addEventListener('click', () => {
      this.showLevelList();
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      if (confirm('Clear all pegs?')) {
        if (this.editor) this.editor.clearAllPegs();
        this.closeMenu();
      }
    });

    document.getElementById('exportBtn').addEventListener('click', () => {
      this.exportLevel();
      this.closeMenu();
    });

    document.getElementById('importBtn').addEventListener('click', () => {
      this.importLevel();
    });

    document.getElementById('exportTrainingBtn').addEventListener('click', () => {
      this.exportTrainingData();
      this.closeMenu();
    });

    // Physics settings button
    document.getElementById('physicsBtn').addEventListener('click', () => {
      this.showPhysicsSettings();
    });

    // Level settings
    document.getElementById('levelName').addEventListener('change', (e) => {
      this.levelManager.updateCurrentLevel({ name: e.target.value });
      this.updateLevelTitle();
    });

    document.getElementById('levelDifficulty').addEventListener('change', (e) => {
      this.levelManager.updateCurrentLevel({ difficulty: parseInt(e.target.value) });
    });

    const yoyoToggle = document.getElementById('yoyoThreadToggle');
    if (yoyoToggle) {
      yoyoToggle.addEventListener('change', (e) => {
        this.updateLevelYoyoSettings({ enabled: e.target.checked });
      });
    }

    document.getElementById('addToTrainingBtn').addEventListener('click', () => {
      const level = this.levelManager.getCurrentLevel();
      if (level) {
        const isInTraining = this.levelManager.isInTraining(level.id);
        if (isInTraining) {
          this.levelManager.removeFromTraining(level.id);
          document.getElementById('addToTrainingBtn').textContent = 'Add to Training';
        } else {
          this.levelManager.addToTraining(level.id);
          document.getElementById('addToTrainingBtn').textContent = 'Remove from Training';
        }
      }
    });

    // Close menu when clicking outside
    document.getElementById('menuOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'menuOverlay') {
        this.closeMenu();
      }
    });

    // Close level list
    document.getElementById('closeLevelList').addEventListener('click', () => {
      this.closeLevelList();
    });

    // Close physics panel
    document.getElementById('closePhysicsPanel').addEventListener('click', () => {
      this.closePhysicsSettings();
    });

    // Physics sliders
    this.setupPhysicsSliders();

    // Animation panel
    this.setupAnimationPanel();

    // Bumper panel
    this.setupBumperPanel();

    // Portal panel
    this.setupPortalPanel();

    // Flipper panel
    this.setupFlipperPanel();

    // Survival mode panel
    this.setupSurvivalPanel();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      if (e.key === 'p') {
        this.togglePlayMode();
      } else if (e.key === 'f' && this.mode === 'editor') {
        document.getElementById('flipperBtn').click();
      }
    });
  }

  setupPhysicsSliders() {
    // Gravity
    const gravitySlider = document.getElementById('gravitySlider');
    gravitySlider.value = PHYSICS_CONFIG.gravity * 100;
    gravitySlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.gravity = parseFloat(e.target.value) / 100;
      document.getElementById('gravityValue').textContent = PHYSICS_CONFIG.gravity.toFixed(2);
    });

    // Bounce
    const bounceSlider = document.getElementById('bounceSlider');
    bounceSlider.value = PHYSICS_CONFIG.bounce * 100;
    bounceSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.bounce = parseFloat(e.target.value) / 100;
      document.getElementById('bounceValue').textContent = PHYSICS_CONFIG.bounce.toFixed(2);
    });

    // Speed
    const speedSlider = document.getElementById('speedSlider');
    speedSlider.value = PHYSICS_CONFIG.timeScale * 100;
    speedSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.timeScale = parseFloat(e.target.value) / 100;
      document.getElementById('speedValue').textContent = PHYSICS_CONFIG.timeScale.toFixed(2);
    });

    // Peg size
    const sizeSlider = document.getElementById('sizeSlider');
    sizeSlider.value = PHYSICS_CONFIG.pegRadius;
    sizeSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.pegRadius = parseInt(e.target.value);
      document.getElementById('sizeValue').textContent = PHYSICS_CONFIG.pegRadius;
    });

    // Launch power
    const powerSlider = document.getElementById('powerSlider');
    powerSlider.value = PHYSICS_CONFIG.launchPower;
    powerSlider.addEventListener('input', (e) => {
      PHYSICS_CONFIG.launchPower = parseFloat(e.target.value);
      document.getElementById('powerValue').textContent = PHYSICS_CONFIG.launchPower.toFixed(1);
    });

    // Full trajectory toggle
    const trajectoryToggle = document.getElementById('trajectoryToggle');
    trajectoryToggle.addEventListener('change', (e) => {
      if (this.game) {
        this.game.setShowFullTrajectory(e.target.checked);
      }
    });
  }

  showPhysicsSettings() {
    // Update slider values to current settings
    document.getElementById('gravitySlider').value = PHYSICS_CONFIG.gravity * 100;
    document.getElementById('gravityValue').textContent = PHYSICS_CONFIG.gravity.toFixed(2);
    
    document.getElementById('bounceSlider').value = PHYSICS_CONFIG.bounce * 100;
    document.getElementById('bounceValue').textContent = PHYSICS_CONFIG.bounce.toFixed(2);
    
    document.getElementById('speedSlider').value = PHYSICS_CONFIG.timeScale * 100;
    document.getElementById('speedValue').textContent = PHYSICS_CONFIG.timeScale.toFixed(2);
    
    document.getElementById('sizeSlider').value = PHYSICS_CONFIG.pegRadius;
    document.getElementById('sizeValue').textContent = PHYSICS_CONFIG.pegRadius;
    
    document.getElementById('powerSlider').value = PHYSICS_CONFIG.launchPower;
    document.getElementById('powerValue').textContent = PHYSICS_CONFIG.launchPower.toFixed(1);
    
    document.getElementById('physicsOverlay').classList.add('visible');
    this.closeMenu();
  }

  closePhysicsSettings() {
    document.getElementById('physicsOverlay').classList.remove('visible');
  }

  setupAnimationPanel() {
    document.getElementById('closeAnimPanel').addEventListener('click', () => {
      this.closeAnimationPanel();
    });

    // Sliders + number inputs update editor ghost offset (bidirectional sync)
    const dxSlider = document.getElementById('animDxSlider');
    const dySlider = document.getElementById('animDySlider');
    const rotSlider = document.getElementById('animRotSlider');
    const durSlider = document.getElementById('animDurationSlider');
    const dxInput = document.getElementById('animDxInput');
    const dyInput = document.getElementById('animDyInput');
    const rotInput = document.getElementById('animRotInput');
    const durInput = document.getElementById('animDurationInput');
    const inverseBtn = document.getElementById('animInverseBtn');

    // Shift-snap helper: snap value to nearest step when shift is held
    const snapVal = (val, step, e) => (e && e.shiftKey) ? Math.round(val / step) * step : val;

    // Track shift key state for slider snapping + number input step changes
    let shiftHeld = false;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = true;
        dxInput.step = 5; dyInput.step = 5; rotInput.step = 5; durInput.step = 0.5;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = false;
        dxInput.step = 1; dyInput.step = 1; rotInput.step = 1; durInput.step = 0.1;
      }
    });

    dxSlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let v = parseInt(dxSlider.value);
      if (shiftHeld) { v = Math.round(v / 5) * 5; dxSlider.value = v; }
      this.editor.animationGhostOffset.dx = v;
      dxInput.value = v;
    });
    dxInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseInt(dxInput.value) || 0;
      this.editor.animationGhostOffset.dx = v;
      dxSlider.value = Math.max(-800, Math.min(800, v));
    });

    dySlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let v = parseInt(dySlider.value);
      if (shiftHeld) { v = Math.round(v / 5) * 5; dySlider.value = v; }
      this.editor.animationGhostOffset.dy = v;
      dyInput.value = v;
    });
    dyInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseInt(dyInput.value) || 0;
      this.editor.animationGhostOffset.dy = v;
      dySlider.value = Math.max(-800, Math.min(800, v));
    });

    rotSlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let v = parseInt(rotSlider.value);
      if (shiftHeld) { v = Math.round(v / 5) * 5; rotSlider.value = v; }
      this.editor.animationRotation = v * Math.PI / 180;
      rotInput.value = v;
    });
    rotInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseInt(rotInput.value) || 0;
      this.editor.animationRotation = v * Math.PI / 180;
      rotSlider.value = Math.max(-360, Math.min(360, v));
    });

    durSlider.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      let raw = parseInt(durSlider.value);
      if (shiftHeld) { raw = Math.round(raw / 5) * 5; durSlider.value = raw; }
      const v = raw / 10;
      this.editor.animationDuration = v;
      durInput.value = v.toFixed(1);
    });
    durInput.addEventListener('input', () => {
      if (!this.editor || !this.editor.animationMode) return;
      const v = parseFloat(durInput.value) || 0.5;
      this.editor.animationDuration = v;
      durSlider.value = Math.max(5, Math.min(80, Math.round(v * 10)));
    });

    document.getElementById('animEasingToggle').addEventListener('change', (e) => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationEasing = e.target.checked ? 'easeInOut' : 'linear';
    });

    inverseBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationInverse = !this.editor.animationInverse;
      this._syncAnimationInverseButton();
    });

    // Cycle button
    const cycleBtn = document.getElementById('animCycleBtn');
    cycleBtn.addEventListener('click', () => {
      if (!this.editor || !this.editor.animationMode) return;
      this.editor.animationCycle = !this.editor.animationCycle;
      // Cycle forces linear easing
      if (this.editor.animationCycle) {
        this.editor.animationEasing = 'linear';
        document.getElementById('animEasingToggle').checked = false;
        document.getElementById('animEasingToggle').disabled = true;
      } else {
        document.getElementById('animEasingToggle').disabled = false;
      }
      this._syncAnimationCycleButton();
    });

    // Preview button
    document.getElementById('animPreviewBtn').addEventListener('click', () => {
      if (!this.editor) return;
      if (this.editor.animationPreview) {
        this.editor.stopAnimationPreview();
        document.getElementById('animPreviewBtn').textContent = 'Preview';
      } else {
        this.editor.startAnimationPreview();
        document.getElementById('animPreviewBtn').textContent = 'Stop';
      }
    });

    // Clear button
    document.getElementById('animClearBtn').addEventListener('click', () => {
      if (!this.editor) return;
      this.editor.stopAnimationPreview();
      document.getElementById('animPreviewBtn').textContent = 'Preview';
      this.editor.clearTargetAnimation();
      this._syncAnimationSliders();
    });

    // Apply button
    document.getElementById('animApplyBtn').addEventListener('click', () => {
      if (!this.editor) return;
      this.editor.stopAnimationPreview();
      document.getElementById('animPreviewBtn').textContent = 'Preview';

      const dx = Math.round(this.editor.animationGhostOffset?.dx || 0);
      const dy = Math.round(this.editor.animationGhostOffset?.dy || 0);
      const rot = this.editor.animationRotation || 0;
      const dur = this.editor.animationDuration || 2;
      const cycle = !!this.editor.animationCycle;
      const easing = cycle ? 'linear' : (document.getElementById('animEasingToggle').checked ? 'easeInOut' : 'linear');
      const inverse = !!this.editor.animationInverse;

      if (dx === 0 && dy === 0 && rot === 0) {
        this.editor.clearTargetAnimation();
      } else {
        this.editor.setTargetAnimation({ dx, dy, rotation: rot, duration: dur, easing, inverse, cycle, wrap: true });
      }
      this.closeAnimationPanel();
    });
  }

  setupBumperPanel() {
    const bounceSlider = document.getElementById('bumperBounceSlider');
    const bounceInput = document.getElementById('bumperBounceInput');
    const scaleSlider = document.getElementById('bumperScaleSlider');
    const scaleInput = document.getElementById('bumperScaleInput');

    document.getElementById('closeBumperPanel').addEventListener('click', () => {
      this.closeBumperPanel();
    });

    bounceSlider.addEventListener('input', () => {
      if (!this.editor) return;
      const v = parseInt(bounceSlider.value) / 10;
      bounceInput.value = v.toFixed(1);
      this.editor.setSelectedBumperBounce(v);
    });
    bounceInput.addEventListener('input', () => {
      if (!this.editor) return;
      const v = parseFloat(bounceInput.value) || 0.5;
      bounceSlider.value = Math.max(5, Math.min(70, Math.round(v * 10)));
      this.editor.setSelectedBumperBounce(v);
    });

    const setScale = (v) => {
      if (!this.editor) return;
      const clamped = Math.max(0.5, Math.min(7.0, v));
      const level = this.editor.levelManager.getCurrentLevel();
      if (!level) return;
      for (const pegId of this.editor.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        if (peg && peg.type === 'bumper') {
          peg.bumperScale = clamped;
        }
      }
      this.editor.levelManager.save();
    };

    scaleSlider.addEventListener('input', () => {
      const v = parseInt(scaleSlider.value) / 10;
      scaleInput.value = v.toFixed(1);
      setScale(v);
    });
    scaleInput.addEventListener('input', () => {
      const v = parseFloat(scaleInput.value) || 1.0;
      scaleSlider.value = Math.max(5, Math.min(70, Math.round(v * 10)));
      setScale(v);
    });

    // Disappear on hit toggle
    const disappearToggle = document.getElementById('bumperDisappearToggle');
    disappearToggle.addEventListener('change', () => {
      if (!this.editor) return;
      const level = this.editor.levelManager.getCurrentLevel();
      if (!level) return;
      for (const pegId of this.editor.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        if (peg && peg.type === 'bumper') {
          peg.bumperDisappear = disappearToggle.checked;
          // Uncheck orange if disappear is checked (mutually exclusive)
          if (disappearToggle.checked && peg.bumperOrange) {
            peg.bumperOrange = false;
          }
        }
      }
      if (disappearToggle.checked) {
        document.getElementById('bumperOrangeToggle').checked = false;
      }
      this.editor.levelManager.save();
    });

    // Count as orange toggle
    const orangeToggle = document.getElementById('bumperOrangeToggle');
    orangeToggle.addEventListener('change', () => {
      if (!this.editor) return;
      const level = this.editor.levelManager.getCurrentLevel();
      if (!level) return;
      for (const pegId of this.editor.selectedPegIds) {
        const peg = level.pegs.find(p => p.id === pegId);
        if (peg && peg.type === 'bumper') {
          peg.bumperOrange = orangeToggle.checked;
          // Orange implies disappear behavior, but uncheck disappear toggle
          if (orangeToggle.checked && peg.bumperDisappear) {
            peg.bumperDisappear = false;
          }
        }
      }
      if (orangeToggle.checked) {
        document.getElementById('bumperDisappearToggle').checked = false;
      }
      this.editor.levelManager.save();
    });
  }

  setupPortalPanel() {
    const scaleSlider = document.getElementById('portalScaleSlider');
    const scaleInput = document.getElementById('portalScaleInput');
    const oneWayToggle = document.getElementById('portalOneWayToggle');
    const oneWayFlipToggle = document.getElementById('portalOneWayFlipToggle');

    document.getElementById('closePortalPanel').addEventListener('click', () => {
      this.closePortalPanel();
    });

    const setScale = (rawValue) => {
      if (!this.editor) return;
      const v = Math.max(0.5, Math.min(5.0, rawValue));
      this.editor.setSelectedPortalScale(v);
    };

    scaleSlider.addEventListener('input', () => {
      const v = parseInt(scaleSlider.value) / 10;
      scaleInput.value = v.toFixed(1);
      setScale(v);
    });

    scaleInput.addEventListener('input', () => {
      const v = parseFloat(scaleInput.value) || 1.0;
      scaleSlider.value = Math.max(5, Math.min(50, Math.round(v * 10)));
      setScale(v);
    });

    oneWayToggle.addEventListener('change', () => {
      if (!this.editor) return;
      this.editor.setSelectedPortalOneWay(oneWayToggle.checked);
      oneWayFlipToggle.disabled = !oneWayToggle.checked;
    });

    oneWayFlipToggle.addEventListener('change', () => {
      if (!this.editor) return;
      this.editor.setSelectedPortalOneWayFlip(oneWayFlipToggle.checked);
    });
  }

  showBumperPanel() {
    const props = this.editor ? this.editor.getSelectedBumperProperties() : null;
    if (!props) return;

    document.getElementById('bumperBounceSlider').value = Math.round(props.bounce * 10);
    document.getElementById('bumperBounceInput').value = props.bounce.toFixed(1);
    document.getElementById('bumperScaleSlider').value = Math.round(props.scale * 10);
    document.getElementById('bumperScaleInput').value = props.scale.toFixed(1);
    document.getElementById('bumperDisappearToggle').checked = !!props.disappear;
    document.getElementById('bumperOrangeToggle').checked = !!props.orange;
    document.getElementById('bumperPanel').classList.add('visible');
  }

  closeBumperPanel() {
    document.getElementById('bumperPanel').classList.remove('visible');
  }

  showPortalPanel() {
    const props = this.editor ? this.editor.getSelectedPortalProperties() : null;
    if (!props) return;

    document.getElementById('portalScaleSlider').value = Math.round(props.scale * 10);
    document.getElementById('portalScaleInput').value = props.scale.toFixed(1);
    document.getElementById('portalOneWayToggle').checked = !!props.oneWay;
    document.getElementById('portalOneWayFlipToggle').checked = !!props.oneWayFlip;
    document.getElementById('portalOneWayFlipToggle').disabled = !props.oneWay;
    document.getElementById('portalPanel').classList.add('visible');
  }

  closePortalPanel() {
    document.getElementById('portalPanel').classList.remove('visible');
  }

  setupFlipperPanel() {
    document.getElementById('closeFlipperPanel').addEventListener('click', () => {
      this.closeFlipperPanel();
    });

    const bindFlipperSlider = (sliderId, inputId, prop, min, max) => {
      const slider = document.getElementById(sliderId);
      const input = document.getElementById(inputId);

      slider.addEventListener('input', () => {
        const v = parseInt(slider.value);
        input.value = v;
        this._setFlipperProp(prop, v);
      });
      input.addEventListener('input', () => {
        const v = Math.max(min, Math.min(max, parseInt(input.value) || min));
        slider.value = v;
        this._setFlipperProp(prop, v);
      });
    };

    bindFlipperSlider('flipperLengthSlider', 'flipperLengthInput', 'length', 20, 150);
    bindFlipperSlider('flipperOffsetSlider', 'flipperOffsetInput', 'xOffset', 10, 250);
    bindFlipperSlider('flipperRestSlider', 'flipperRestInput', 'restAngle', 5, 60);
    bindFlipperSlider('flipperFlipSlider', 'flipperFlipInput', 'flipAngle', 0, 70);

    // Bounce slider (0.3 - 5.0, stored as float)
    const fBounceSlider = document.getElementById('flipperBounceSlider');
    const fBounceInput = document.getElementById('flipperBounceInput');
    fBounceSlider.addEventListener('input', () => {
      const v = parseFloat(fBounceSlider.value);
      fBounceInput.value = v.toFixed(2);
      this._setFlipperProp('bounce', v);
    });
    fBounceInput.addEventListener('input', () => {
      const v = Math.max(0.3, Math.min(5.0, parseFloat(fBounceInput.value) || PHYSICS_CONFIG.bounce));
      fBounceSlider.value = v.toFixed(2);
      this._setFlipperProp('bounce', v);
    });

    bindFlipperSlider('flipperWidthSlider', 'flipperWidthInput', 'width', 4, 40);

    // Scale slider (0.5 - 3.0, stored as float)
    const fScaleSlider = document.getElementById('flipperScaleSlider');
    const fScaleInput = document.getElementById('flipperScaleInput');
    fScaleSlider.addEventListener('input', () => {
      const v = parseInt(fScaleSlider.value) / 10;
      fScaleInput.value = v.toFixed(1);
      this._setFlipperProp('scale', v);
    });
    fScaleInput.addEventListener('input', () => {
      const v = Math.max(0.5, Math.min(3.0, parseFloat(fScaleInput.value) || 1.0));
      fScaleSlider.value = Math.round(v * 10);
      this._setFlipperProp('scale', v);
    });
  }

  setupSurvivalPanel() {
    const panel = document.getElementById('survivalPanel');
    const toggle = document.getElementById('survivalModeToggle');
    const worldHeightSlider = document.getElementById('survivalHeightSlider');
    const worldHeightInput = document.getElementById('survivalHeightInput');
    const speedSlider = document.getElementById('survivalSpeedSlider');
    const speedInput = document.getElementById('survivalSpeedInput');
    const loseLineSlider = document.getElementById('survivalLoseLineSlider');
    const loseLineInput = document.getElementById('survivalLoseLineInput');

    if (
      !panel || !toggle ||
      !worldHeightSlider || !worldHeightInput ||
      !speedSlider || !speedInput ||
      !loseLineSlider || !loseLineInput
    ) return;

    let shiftHeld = false;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        shiftHeld = false;
      }
    });

    const snap5 = (value) => shiftHeld ? Math.round(value / 5) * 5 : value;

    toggle.addEventListener('change', () => {
      this.updateLevelSurvivalSettings({ enabled: toggle.checked });
      this._setSurvivalSettingsVisible(toggle.checked);
    });

    const applyWorldHeight = (rawValue) => {
      const minHeight = this.canvas.height;
      const parsed = Math.round(parseFloat(rawValue) || minHeight);
      const value = Math.max(minHeight, parsed);
      worldHeightSlider.value = value;
      worldHeightInput.value = value;
      this.updateLevelSurvivalSettings({ worldHeight: value });
    };

    worldHeightSlider.addEventListener('input', () => {
      let value = parseInt(worldHeightSlider.value, 10) || this.canvas.height;
      value = snap5(value);
      worldHeightSlider.value = value;
      worldHeightInput.value = value;
    });
    worldHeightSlider.addEventListener('change', () => applyWorldHeight(worldHeightSlider.value));
    worldHeightInput.addEventListener('change', () => applyWorldHeight(worldHeightInput.value));

    const applySpeed = (rawValue) => {
      let parsed = parseFloat(rawValue) || 20;
      parsed = snap5(parsed);
      const value = Math.max(2, Math.min(400, parsed));
      speedSlider.value = value;
      speedInput.value = value.toFixed(1);
      this.updateLevelSurvivalSettings({ scrollSpeed: value });
    };

    speedSlider.addEventListener('input', () => {
      let value = parseInt(speedSlider.value, 10) || 20;
      value = snap5(value);
      speedSlider.value = value;
      speedInput.value = value.toFixed(1);
    });
    speedSlider.addEventListener('change', () => applySpeed(speedSlider.value));
    speedInput.addEventListener('change', () => applySpeed(speedInput.value));

    const applyLoseLine = (rawValue) => {
      const maxLine = Math.max(8, this.canvas.height - 8);
      let parsed = Math.round(parseFloat(rawValue) || 8);
      parsed = snap5(parsed);
      const value = Math.max(8, Math.min(maxLine, parsed));
      loseLineSlider.value = value;
      loseLineInput.value = value;
      this.updateLevelSurvivalSettings({ loseLineY: value });
    };

    loseLineSlider.addEventListener('input', () => {
      let value = parseInt(loseLineSlider.value, 10) || 8;
      value = snap5(value);
      loseLineSlider.value = value;
      loseLineInput.value = value;
    });
    loseLineSlider.addEventListener('change', () => applyLoseLine(loseLineSlider.value));
    loseLineInput.addEventListener('change', () => applyLoseLine(loseLineInput.value));
  }

  _setSurvivalSettingsVisible(visible) {
    const container = document.getElementById('survivalControls');
    if (!container) return;
    container.classList.toggle('hidden', !visible);
  }

  setSurvivalPanelVisible(visible) {
    const panel = document.getElementById('survivalPanel');
    if (!panel) return;
    panel.classList.toggle('visible', !!visible);
  }

  updateLevelSurvivalSettings(partialSettings) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const current = ensureLevelSurvival(level, this.canvas.height);
    level.survival = normalizeSurvivalSettings(
      { ...current, ...partialSettings },
      this.canvas.height
    );
    this.levelManager.save();
    this.applySurvivalSettingsToEditor();
    this.updateLevelSettings();
  }

  updateLevelYoyoSettings(partialSettings) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const next = normalizeYoyoSettings({ ...(level.yoyo || {}), ...(partialSettings || {}) });
    this.levelManager.updateCurrentLevel({ yoyo: next });
    this.updateLevelSettings();
  }

  applySurvivalSettingsToEditor() {
    if (!this.editor) return;
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    this.editor.setSurvivalSettings(ensureLevelSurvival(level, this.canvas.height));
  }

  _setFlipperProp(prop, value) {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;
    const cameraY = this.editor?.getCameraY?.() || 0;
    const base = normalizeFlipperConfig(level.flippers, {
      canvasHeight: this.canvas.height,
      cameraY,
      bounce: PHYSICS_CONFIG.bounce
    }) || createDefaultFlipperConfig({
      canvasHeight: this.canvas.height,
      cameraY,
      bounce: PHYSICS_CONFIG.bounce,
      enabled: true
    });
    level.flippers = { ...base, [prop]: value, enabled: true };
    this.levelManager.save();
  }

  showFlipperPanel() {
    const cameraY = this.editor?.getCameraY?.() || 0;
    const f = normalizeFlipperConfig(this.levelManager.getFlippers(), {
      canvasHeight: this.canvas.height,
      cameraY,
      bounce: PHYSICS_CONFIG.bounce
    });
    if (!f) return;

    document.getElementById('flipperLengthSlider').value = f.length ?? FLIPPER_DEFAULTS.length;
    document.getElementById('flipperLengthInput').value = f.length ?? FLIPPER_DEFAULTS.length;
    document.getElementById('flipperOffsetSlider').value = f.xOffset ?? FLIPPER_DEFAULTS.xOffset;
    document.getElementById('flipperOffsetInput').value = f.xOffset ?? FLIPPER_DEFAULTS.xOffset;
    document.getElementById('flipperRestSlider').value = f.restAngle ?? FLIPPER_DEFAULTS.restAngle;
    document.getElementById('flipperRestInput').value = f.restAngle ?? FLIPPER_DEFAULTS.restAngle;
    document.getElementById('flipperFlipSlider').value = f.flipAngle ?? FLIPPER_DEFAULTS.flipAngle;
    document.getElementById('flipperFlipInput').value = f.flipAngle ?? FLIPPER_DEFAULTS.flipAngle;
    document.getElementById('flipperWidthSlider').value = f.width ?? FLIPPER_DEFAULTS.width;
    document.getElementById('flipperWidthInput').value = f.width ?? FLIPPER_DEFAULTS.width;
    const bounce = f.bounce ?? PHYSICS_CONFIG.bounce;
    document.getElementById('flipperBounceSlider').value = bounce.toFixed(2);
    document.getElementById('flipperBounceInput').value = bounce.toFixed(2);
    const scale = f.scale ?? FLIPPER_DEFAULTS.scale;
    document.getElementById('flipperScaleSlider').value = Math.round(scale * 10);
    document.getElementById('flipperScaleInput').value = scale.toFixed(1);
    document.getElementById('flipperPanel').classList.add('visible');
  }

  closeFlipperPanel() {
    document.getElementById('flipperPanel').classList.remove('visible');
  }

  _isPortalType(type) {
    return type === 'portalBlue' || type === 'portalOrange';
  }

  _isCircleOnlyType(type) {
    return type === 'bumper' || this._isPortalType(type);
  }

  _setActiveShapeButton(shape) {
    document.querySelectorAll('.shape-btn').forEach(b => b.classList.remove('active'));
    const target = document.querySelector(`.shape-btn[data-shape="${shape}"]`);
    if (target) target.classList.add('active');
  }

  syncSelectionPanels() {
    if (!this.editor) return;
    const count = this.editor.selectedPegIds.size;

    if (count > 0 && this.editor.isSelectionAllBumpers()) {
      this.showBumperPanel();
    } else {
      this.closeBumperPanel();
    }

    if (count > 0 && this.editor.isSelectionAllPortals()) {
      this.showPortalPanel();
    } else {
      this.closePortalPanel();
    }
  }

  showAnimationPanel() {
    this._syncAnimationSliders();
    document.getElementById('animPanel').classList.add('visible');

    // Wire canvas drag → slider + input sync
    if (this.editor) {
      this.editor.onAnimationOffsetChange = (offset) => {
        const dx = Math.round(offset.dx);
        const dy = Math.round(offset.dy);
        document.getElementById('animDxSlider').value = dx;
        document.getElementById('animDxInput').value = dx;
        document.getElementById('animDySlider').value = dy;
        document.getElementById('animDyInput').value = dy;
      };
    }
  }

  closeAnimationPanel() {
    if (this.editor) {
      this.editor.stopAnimationPreview();
      this.editor.exitAnimationMode();
      this.editor.onAnimationOffsetChange = null;
    }
    document.getElementById('animPreviewBtn').textContent = 'Preview';
    document.getElementById('animPanel').classList.remove('visible');
  }

  _syncAnimationSliders() {
    if (!this.editor) return;
    const off = this.editor.animationGhostOffset || { dx: 0, dy: 0 };
    const rot = Math.round(this.editor.animationRotation * 180 / Math.PI);
    const dur = this.editor.animationDuration;
    const easing = this.editor.animationEasing;

    document.getElementById('animDxSlider').value = Math.round(off.dx);
    document.getElementById('animDxInput').value = Math.round(off.dx);
    document.getElementById('animDySlider').value = Math.round(off.dy);
    document.getElementById('animDyInput').value = Math.round(off.dy);
    document.getElementById('animRotSlider').value = rot;
    document.getElementById('animRotInput').value = rot;
    document.getElementById('animDurationSlider').value = Math.round(dur * 10);
    document.getElementById('animDurationInput').value = dur.toFixed(1);
    document.getElementById('animEasingToggle').checked = easing === 'easeInOut';
    this._syncAnimationInverseButton();
    this._syncAnimationCycleButton();
  }

  _syncAnimationInverseButton() {
    const inverseBtn = document.getElementById('animInverseBtn');
    if (!inverseBtn) return;
    const inverseOn = !!(this.editor && this.editor.animationInverse);
    inverseBtn.classList.toggle('active', inverseOn);
    inverseBtn.textContent = inverseOn ? 'Inverse: ON' : 'Inverse: OFF';
  }

  _syncAnimationCycleButton() {
    const cycleBtn = document.getElementById('animCycleBtn');
    if (!cycleBtn) return;
    const cycleOn = !!(this.editor && this.editor.animationCycle);
    cycleBtn.classList.toggle('active', cycleOn);
    cycleBtn.textContent = cycleOn ? 'Cycle: ON' : 'Cycle: OFF';
    // Disable easing when cycle is on
    const easingToggle = document.getElementById('animEasingToggle');
    if (easingToggle) {
      easingToggle.disabled = cycleOn;
      if (cycleOn) easingToggle.checked = false;
    }
  }

  initMode() {
    // Ensure we have at least one level
    if (this.levelManager.getLevelCount() === 0) {
      this.levelManager.createLevel('Level 1');
    }

    // Start in editor mode
    this.startEditor();
    this.updateLevelTitle();
    this.updateLevelSettings();
  }

  startEditor() {
    this.teardownGambleSystem();

    if (this.game) {
      this.game.stop();
      this.game = null;
    }

    this.mode = 'editor';
    this.editor = new Editor(this.canvas, this.levelManager);
    
    // Resize to current dimensions
    this.resizeCanvas();
    const currentLevel = this.levelManager.getCurrentLevel();
    if (currentLevel) {
      this.editor.setSurvivalSettings(ensureLevelSurvival(currentLevel, this.canvas.height));
    }
    
    this.editor.onPegCountChange = (count) => {
      document.getElementById('pegCount').textContent = `Pegs: ${count}`;
    };

    this.editor.onSelectionChange = (count) => {
      document.getElementById('selectionCount').textContent = count > 0 ? `Selected: ${count}` : '';
      this.syncSelectionPanels();
    };

    this.editor.onFlipperSelectionChange = (selected) => {
      if (selected) {
        this.showFlipperPanel();
      } else {
        this.closeFlipperPanel();
      }
    };

    this.editor.onFlippersDeleted = () => {
      this.closeFlipperPanel();
      document.getElementById('flipperBtn').classList.remove('active');
    };

    this.editor.onBumperPropertyChange = () => {
      // Sync bumper panel sliders when properties change via drag
      const props = this.editor.getSelectedBumperProperties();
      if (props) {
        document.getElementById('bumperScaleSlider').value = Math.round(props.scale * 10);
        document.getElementById('bumperScaleInput').value = props.scale.toFixed(1);
      }
    };

    this.editor.onModeChange = (mode) => {
      document.getElementById('selectBtn').classList.toggle('active', mode === 'select');
      document.getElementById('drawBtn').classList.toggle('active', mode === 'draw');
    };

    this.editor.onGridChange = (gridOn) => {
      document.getElementById('gridBtn').classList.toggle('active', gridOn);
    };

    this.editor.onSnapChange = (snapOn) => {
      document.getElementById('magnetBtn').classList.toggle('active', snapOn);
    };

    this.editor.onEnterAnimationMode = () => {
      this.showAnimationPanel();
    };

    this.editor.start();

    // Update UI
    document.getElementById('playBtn').innerHTML = '▶';
    document.getElementById('playBtn').title = 'Play Level';
    document.querySelector('.toolbar').style.display = 'flex';
    this.setSurvivalPanelVisible(true);

    // Sync tool button states
    document.getElementById('gridBtn').classList.toggle('active', this.editor.showGrid);
    document.getElementById('magnetBtn').classList.toggle('active', this.editor.snapToGrid);

    // Sync flipper button state
    const flipperData = this.levelManager.getFlippers();
    document.getElementById('flipperBtn').classList.toggle('active', !!(flipperData && flipperData.enabled));
    
    // Show current peg count
    if (currentLevel) {
      document.getElementById('pegCount').textContent = `Pegs: ${currentLevel.pegs.length}`;
    }

    // Keep side-panel settings in sync when switching/returning to editor.
    this.updateLevelSettings();
  }

  startGame() {
    this.teardownGambleSystem();

    if (this.editor) {
      // Close panels if open
      this.closeAnimationPanel();
      this.closeBumperPanel();
      this.closePortalPanel();
      this.closeFlipperPanel();
      this.editor.stop();
      this.editor = null;
    }

    const level = this.levelManager.getCurrentLevel();
    if (!level || level.pegs.length === 0) {
      alert('Add some pegs first!');
      this.startEditor();
      return;
    }

    const survival = ensureLevelSurvival(level, this.canvas.height);
    if (!survival.enabled) {
      // Check for at least one orange peg in classic mode
      const orangePegs = level.pegs.filter(p => p.type === 'orange' || (p.type === 'bumper' && p.bumperOrange));
      if (orangePegs.length === 0) {
        alert('Add at least one orange peg to play!');
        this.startEditor();
        return;
      }
    }

    this.mode = 'play';
    this.game = new Game(this.canvas);
    
    // Apply trajectory setting
    const trajectoryToggle = document.getElementById('trajectoryToggle');
    this.game.setShowFullTrajectory(trajectoryToggle.checked);
    
    // Resize to current dimensions
    this.resizeCanvas();
    
    this.game.loadLevel(level);
    
    this.game.onGameEnd = (result, score) => {
      setTimeout(() => {
        // Update play count
        level.metadata.playCount = (level.metadata.playCount || 0) + 1;
        this.levelManager.save();
        
        // Allow restart
        this.canvas.addEventListener('click', this.handleGameRestart, { once: true });
        this.canvas.addEventListener('touchstart', this.handleGameRestart, { once: true });
      }, 1000);
    };

    this.game.start();

    // Update UI
    document.getElementById('playBtn').innerHTML = '✏️';
    document.getElementById('playBtn').title = 'Back to Editor';
    document.querySelector('.toolbar').style.display = 'none';
    this.setSurvivalPanelVisible(false);
    this.mountGambleSystem();
  }

  mountGambleSystem() {
    if (!this.game) return;
    const statusBar = document.querySelector('.status-bar');
    const pegCountEl = document.getElementById('pegCount');
    const selectionCountEl = document.getElementById('selectionCount');
    if (!statusBar || !pegCountEl || !selectionCountEl) return;

    this.gambleSystem = new GambleSystem({
      game: this.game,
      levelManager: this.levelManager,
      statusBar,
      pegCountEl,
      selectionCountEl
    });
    this.gambleSystem.mount();
  }

  teardownGambleSystem() {
    if (!this.gambleSystem) return;
    this.gambleSystem.dispose();
    this.gambleSystem = null;
  }

  handleGameRestart = () => {
    if (this.game && this.game.handleRestart()) {
      this.startEditor();
    }
  };

  togglePlayMode() {
    if (this.mode === 'editor') {
      this.startGame();
    } else {
      this.startEditor();
    }
  }

  toggleMenu() {
    const overlay = document.getElementById('menuOverlay');
    overlay.classList.toggle('visible');
    
    if (overlay.classList.contains('visible')) {
      this.updateLevelSettings();
    }
  }

  closeMenu() {
    document.getElementById('menuOverlay').classList.remove('visible');
  }

  updateLevelTitle() {
    const level = this.levelManager.getCurrentLevel();
    document.getElementById('levelTitle').textContent = level ? level.name : 'No Level';
  }

  updateLevelSettings() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    document.getElementById('levelName').value = level.name;
    document.getElementById('levelDifficulty').value = level.difficulty || 1;
    const yoyoSettings = normalizeYoyoSettings(level.yoyo);
    const yoyoToggle = document.getElementById('yoyoThreadToggle');
    if (yoyoToggle) {
      yoyoToggle.checked = !!yoyoSettings.enabled;
    }

    const survival = ensureLevelSurvival(level, this.canvas.height);
    const minHeight = Math.round(this.canvas.height);
    document.getElementById('survivalModeToggle').checked = !!survival.enabled;
    const heightSlider = document.getElementById('survivalHeightSlider');
    const heightInput = document.getElementById('survivalHeightInput');
    heightSlider.min = String(minHeight);
    heightInput.min = String(minHeight);
    document.getElementById('survivalHeightSlider').value = Math.round(survival.worldHeight);
    heightInput.value = Math.round(survival.worldHeight);
    document.getElementById('survivalSpeedSlider').value = Math.round(survival.scrollSpeed);
    document.getElementById('survivalSpeedInput').value = Number(survival.scrollSpeed).toFixed(1);
    const loseLineSlider = document.getElementById('survivalLoseLineSlider');
    const loseLineInput = document.getElementById('survivalLoseLineInput');
    loseLineSlider.max = Math.max(8, Math.round(this.canvas.height - 8));
    loseLineSlider.value = Math.round(survival.loseLineY);
    loseLineInput.max = Math.max(8, Math.round(this.canvas.height - 8));
    loseLineInput.value = Math.round(survival.loseLineY);
    this._setSurvivalSettingsVisible(!!survival.enabled);
    
    const isInTraining = this.levelManager.isInTraining(level.id);
    document.getElementById('addToTrainingBtn').textContent = isInTraining ? 'Remove from Training' : 'Add to Training';
  }

  newLevel() {
    const name = `Level ${this.levelManager.getLevelCount() + 1}`;
    this.levelManager.createLevel(name);
    this.updateLevelTitle();
    this.updateLevelSettings();
    this.applySurvivalSettingsToEditor();
    
    if (this.mode === 'editor' && this.editor) {
      this.editor.selectedPegIds.clear();
    }
  }

  showLevelList() {
    const levels = this.levelManager.getAllLevels();
    const list = document.getElementById('levelItems');
    list.innerHTML = '';

    levels.forEach((level, index) => {
      const item = document.createElement('div');
      item.className = 'level-item';
      if (index === this.levelManager.currentLevelIndex) {
        item.classList.add('active');
      }

      const isTraining = this.levelManager.isInTraining(level.id);
      
      item.innerHTML = `
        <div class="level-item-info">
          <span class="level-item-name">${level.name}</span>
          <span class="level-item-meta">
            ${level.pegs.length} pegs · Difficulty ${level.difficulty || 1}
            ${isTraining ? ' · 📊' : ''}
          </span>
        </div>
        <div class="level-item-actions">
          <button class="level-action-btn duplicate-btn" title="Duplicate">📋</button>
          <button class="level-action-btn delete-btn" title="Delete">🗑️</button>
        </div>
      `;

      item.querySelector('.level-item-info').addEventListener('click', () => {
        this.levelManager.setCurrentLevel(index);
        this.updateLevelTitle();
        if (this.mode === 'editor') {
          this.startEditor();
        }
        this.closeLevelList();
        this.closeMenu();
      });

      item.querySelector('.duplicate-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.levelManager.duplicateLevel(level.id);
        this.showLevelList();
      });

      item.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (levels.length === 1) {
          alert('Cannot delete the last level');
          return;
        }
        if (confirm(`Delete "${level.name}"?`)) {
          this.levelManager.deleteLevel(level.id);
          this.updateLevelTitle();
          if (this.mode === 'editor') {
            this.startEditor();
          }
          this.showLevelList();
        }
      });

      list.appendChild(item);
    });

    document.getElementById('levelListOverlay').classList.add('visible');
  }

  closeLevelList() {
    document.getElementById('levelListOverlay').classList.remove('visible');
  }

  exportLevel() {
    const level = this.levelManager.getCurrentLevel();
    if (!level) return;

    const json = this.levelManager.exportLevel(level.id);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${level.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
  }

  importLevel() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const level = this.levelManager.importLevel(event.target.result);
        if (level) {
          this.levelManager.setCurrentLevelById(level.id);
          this.updateLevelTitle();
          if (this.mode === 'editor') {
            this.startEditor();
          }
          this.closeMenu();
        } else {
          alert('Failed to import level');
        }
      };
      reader.readAsText(file);
    };
    
    input.click();
  }

  exportTrainingData() {
    const data = this.levelManager.exportTrainingData();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `peggle_training_data_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.peggleApp = new PeggleApp();
});
