// Peggle Main - App initialization and UI management

import { Game } from './game.js';
import { Editor } from './editor.js';
import { LevelManager } from './levels.js';
import { PHYSICS_CONFIG } from './physics.js';

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
        document.querySelectorAll('.peg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (this.editor) {
          this.editor.setSelectedPegType(btn.dataset.type);
          // Also change type of selected pegs
          if (this.editor.selectedPegIds.size > 0) {
            this.editor.setSelectedPegsType(btn.dataset.type);
          }
        }
      });
    });

    // Shape buttons
    document.querySelectorAll('.shape-btn').forEach(btn => {
      btn.addEventListener('click', () => {
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
      if (this.editor) this.editor.deleteSelectedPegs();
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

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      
      if (e.key === 'p') {
        this.togglePlayMode();
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
    if (this.game) {
      this.game.stop();
      this.game = null;
    }

    this.mode = 'editor';
    this.editor = new Editor(this.canvas, this.levelManager);
    
    // Resize to current dimensions
    this.resizeCanvas();
    
    this.editor.onPegCountChange = (count) => {
      document.getElementById('pegCount').textContent = `Pegs: ${count}`;
    };

    this.editor.onSelectionChange = (count) => {
      document.getElementById('selectionCount').textContent = count > 0 ? `Selected: ${count}` : '';
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

    // Sync tool button states
    document.getElementById('gridBtn').classList.toggle('active', this.editor.showGrid);
    document.getElementById('magnetBtn').classList.toggle('active', this.editor.snapToGrid);
    
    // Show current peg count
    const level = this.levelManager.getCurrentLevel();
    if (level) {
      document.getElementById('pegCount').textContent = `Pegs: ${level.pegs.length}`;
    }
  }

  startGame() {
    if (this.editor) {
      // Close animation panel if open
      this.closeAnimationPanel();
      this.editor.stop();
      this.editor = null;
    }

    const level = this.levelManager.getCurrentLevel();
    if (!level || level.pegs.length === 0) {
      alert('Add some pegs first!');
      this.startEditor();
      return;
    }

    // Check for at least one orange peg
    const orangePegs = level.pegs.filter(p => p.type === 'orange');
    if (orangePegs.length === 0) {
      alert('Add at least one orange peg to play!');
      this.startEditor();
      return;
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
    
    const isInTraining = this.levelManager.isInTraining(level.id);
    document.getElementById('addToTrainingBtn').textContent = isInTraining ? 'Remove from Training' : 'Add to Training';
  }

  newLevel() {
    const name = `Level ${this.levelManager.getLevelCount() + 1}`;
    this.levelManager.createLevel(name);
    this.updateLevelTitle();
    
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
