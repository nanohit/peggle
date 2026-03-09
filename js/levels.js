// Peggle Levels - Level management and storage

import { Utils } from './utils.js';
import { normalizeFlipperConfig } from './flipper-defaults.js';
import { ensureLevelSurvival, normalizeSurvivalSettings } from './survival-mode.js';
import { normalizeYoyoSettings } from './yoyo-thread.js';
import { normalizeMultiballSpawnCount } from './multiball-settings.js';
import { normalizeVisuals } from './visual-config.js';

const STORAGE_KEY = 'peggle_levels';
const TRAINING_KEY = 'peggle_training_data';

export class LevelManager {
  constructor() {
    this.levels = [];
    this.trainingLevels = [];
    this.currentLevelIndex = -1;
    this.load();
  }

  // Create a new empty level
  createLevel(name = 'Untitled Level') {
    const level = {
      version: 1,
      id: Utils.generateId(),
      name: name,
      difficulty: 1,
      tags: [],
      pegs: [],
      groups: [],
      bezierCurves: {},
      flippers: null,
      yoyo: normalizeYoyoSettings(null),
      survival: ensureLevelSurvival({}, 600),
      visuals: normalizeVisuals(null),
      metadata: {
        created: new Date().toISOString().split('T')[0],
        modified: new Date().toISOString(),
        playCount: 0,
        avgCompletionRate: null,
        authorNotes: ''
      }
    };
    
    this.levels.push(level);
    this.currentLevelIndex = this.levels.length - 1;
    this.save();
    
    return level;
  }

  // Get current level
  getCurrentLevel() {
    if (this.currentLevelIndex >= 0 && this.currentLevelIndex < this.levels.length) {
      return this.levels[this.currentLevelIndex];
    }
    return null;
  }

  // Set current level by index
  setCurrentLevel(index) {
    if (index >= 0 && index < this.levels.length) {
      this.currentLevelIndex = index;
      return this.levels[index];
    }
    return null;
  }

  // Set current level by ID
  setCurrentLevelById(id) {
    const index = this.levels.findIndex(l => l.id === id);
    return this.setCurrentLevel(index);
  }

  // Update current level
  updateCurrentLevel(updates) {
    const level = this.getCurrentLevel();
    if (!level) return null;
    
    Object.assign(level, updates);
    if (Object.prototype.hasOwnProperty.call(updates || {}, 'survival')) {
      level.survival = normalizeSurvivalSettings(level.survival, 600);
    } else {
      ensureLevelSurvival(level, 600);
    }
    level.yoyo = normalizeYoyoSettings(level.yoyo);
    level.metadata.modified = new Date().toISOString();
    this.save();
    
    return level;
  }

  // Update level pegs
  updatePegs(pegs) {
    const level = this.getCurrentLevel();
    if (!level) return;
    
    level.pegs = pegs;
    level.metadata.modified = new Date().toISOString();
    this.save();
  }

  // Add a peg to current level
  addPeg(peg) {
    const level = this.getCurrentLevel();
    if (!level) return null;
    
    const newPeg = {
      id: Utils.generateId(),
      type: peg.type || 'blue',
      x: peg.x,
      y: peg.y,
      angle: peg.angle || 0,
      shape: peg.shape || 'circle',
      groupId: peg.groupId || null,
      bezierGroupId: peg.bezierGroupId || null,
      bezierIndex: Number.isFinite(peg.bezierIndex) ? peg.bezierIndex : null
    };
    
    // Add brick dimensions if it's a brick shape
    if (peg.shape === 'brick') {
      newPeg.width = peg.width || 40;
      newPeg.height = peg.height || 12;
      if (peg.curveSlices) newPeg.curveSlices = peg.curveSlices;
    }

    // Preserve animation data
    if (peg.animation) newPeg.animation = peg.animation;

    // Bumper properties
    if (peg.type === 'bumper') {
      newPeg.bumperBounce = peg.bumperBounce ?? 2.0;
      newPeg.bumperScale = peg.bumperScale ?? 1.0;
      newPeg.bumperDisappear = !!peg.bumperDisappear;
      newPeg.bumperOrange = !!peg.bumperOrange;
      newPeg.shape = 'circle'; // bumpers are always circles
    }

    // Portal properties
    if (peg.type === 'portalBlue' || peg.type === 'portalOrange') {
      newPeg.portalScale = peg.portalScale ?? 1.0;
      newPeg.portalOneWay = !!peg.portalOneWay;
      newPeg.portalOneWayFlip = !!peg.portalOneWayFlip;
      newPeg.shape = 'circle'; // kept for backward compatibility; rendered/triggered as lines
    }

    if (peg.type === 'multi') {
      newPeg.multiballSpawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
    }

    level.pegs.push(newPeg);
    level.metadata.modified = new Date().toISOString();
    this.save();
    
    return newPeg;
  }

  // Remove peg by ID
  removePeg(pegId) {
    const level = this.getCurrentLevel();
    if (!level) return false;
    
    const index = level.pegs.findIndex(p => p.id === pegId);
    if (index !== -1) {
      level.pegs.splice(index, 1);
      level.metadata.modified = new Date().toISOString();
      this.save();
      return true;
    }
    return false;
  }

  // Remove multiple pegs
  removePegs(pegIds) {
    const level = this.getCurrentLevel();
    if (!level) return;
    
    const idSet = new Set(pegIds);
    level.pegs = level.pegs.filter(p => !idSet.has(p.id));
    level.metadata.modified = new Date().toISOString();
    this.save();
  }

  // Update peg position
  updatePeg(pegId, updates) {
    const level = this.getCurrentLevel();
    if (!level) return null;
    
    const peg = level.pegs.find(p => p.id === pegId);
    if (peg) {
      Object.assign(peg, updates);
      level.metadata.modified = new Date().toISOString();
      this.save();
      return peg;
    }
    return null;
  }

  // Delete level
  deleteLevel(id) {
    const index = this.levels.findIndex(l => l.id === id);
    if (index !== -1) {
      this.levels.splice(index, 1);
      if (this.currentLevelIndex >= this.levels.length) {
        this.currentLevelIndex = this.levels.length - 1;
      }
      this.save();
      return true;
    }
    return false;
  }

  // Duplicate level
  duplicateLevel(id) {
    const level = this.levels.find(l => l.id === id);
    if (!level) return null;
    
    const duplicate = Utils.deepClone(level);
    duplicate.id = Utils.generateId();
    duplicate.name = `${level.name} (Copy)`;
    duplicate.metadata.created = new Date().toISOString().split('T')[0];
    duplicate.metadata.modified = new Date().toISOString();
    
    this.levels.push(duplicate);
    this.save();
    
    return duplicate;
  }

  // Create a group from selected pegs
  createGroup(pegIds, name = 'Group', pattern = 'custom') {
    const level = this.getCurrentLevel();
    if (!level || pegIds.length === 0) return null;
    
    const groupId = Utils.generateId();
    const group = {
      id: groupId,
      name: name,
      pattern: pattern
    };
    
    level.groups.push(group);
    
    // Assign group to pegs
    for (const pegId of pegIds) {
      const peg = level.pegs.find(p => p.id === pegId);
      if (peg) {
        peg.groupId = groupId;
      }
    }
    
    level.metadata.modified = new Date().toISOString();
    this.save();
    
    return group;
  }

  // Delete a group
  deleteGroup(groupId) {
    const level = this.getCurrentLevel();
    if (!level) return false;
    
    const index = level.groups.findIndex(g => g.id === groupId);
    if (index !== -1) {
      level.groups.splice(index, 1);
      
      // Remove group reference from pegs
      for (const peg of level.pegs) {
        if (peg.groupId === groupId) {
          peg.groupId = null;
        }
      }
      
      level.metadata.modified = new Date().toISOString();
      this.save();
      return true;
    }
    return false;
  }

  // Update a group by ID
  updateGroup(groupId, updates) {
    const level = this.getCurrentLevel();
    if (!level) return null;

    const group = level.groups.find(g => g.id === groupId);
    if (group) {
      Object.assign(group, updates);
      level.metadata.modified = new Date().toISOString();
      this.save();
      return group;
    }
    return null;
  }

  // Set flippers data on current level
  setFlippers(flippersData) {
    const level = this.getCurrentLevel();
    if (!level) return;
    level.flippers = normalizeFlipperConfig(flippersData, { canvasHeight: 600 }) || null;
    level.metadata.modified = new Date().toISOString();
    this.save();
  }

  // Get flippers for current level
  getFlippers() {
    const level = this.getCurrentLevel();
    return level ? level.flippers : null;
  }

  // Add level to training data
  addToTraining(levelId) {
    if (this.trainingLevels.includes(levelId)) return false;
    
    this.trainingLevels.push(levelId);
    this.saveTrainingData();
    return true;
  }

  // Remove level from training data
  removeFromTraining(levelId) {
    const index = this.trainingLevels.indexOf(levelId);
    if (index !== -1) {
      this.trainingLevels.splice(index, 1);
      this.saveTrainingData();
      return true;
    }
    return false;
  }

  // Check if level is in training data
  isInTraining(levelId) {
    return this.trainingLevels.includes(levelId);
  }

  // Get all training levels
  getTrainingLevels() {
    return this.levels.filter(l => this.trainingLevels.includes(l.id));
  }

  // Export training data as JSON
  exportTrainingData() {
    const trainingData = this.getTrainingLevels();
    return JSON.stringify(trainingData, null, 2);
  }

  // Export single level
  exportLevel(id) {
    const level = this.levels.find(l => l.id === id);
    if (level) {
      this.normalizeLevel(level);
      return JSON.stringify(level, null, 2);
    }
    return null;
  }

  // Import level from JSON
  importLevel(jsonString) {
    try {
      const level = JSON.parse(jsonString);
      
      // Validate basic structure
      if (!level.pegs || !Array.isArray(level.pegs)) {
        throw new Error('Invalid level format');
      }
      
      // Generate new IDs
      level.id = Utils.generateId();
      level.pegs.forEach(peg => {
        peg.id = Utils.generateId();
      });
      if (level.groups) {
        level.groups.forEach(group => {
          group.id = Utils.generateId();
        });
      }
      
      level.metadata = level.metadata || {};
      level.metadata.created = new Date().toISOString().split('T')[0];
      level.metadata.modified = new Date().toISOString();
      this.normalizeLevel(level);
      
      this.levels.push(level);
      this.save();
      
      return level;
    } catch (e) {
      console.error('Failed to import level:', e);
      return null;
    }
  }

  // Save to localStorage
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.levels));
    } catch (e) {
      console.error('Failed to save levels:', e);
    }
  }

  // Save training data
  saveTrainingData() {
    try {
      localStorage.setItem(TRAINING_KEY, JSON.stringify(this.trainingLevels));
    } catch (e) {
      console.error('Failed to save training data:', e);
    }
  }

  // Load from localStorage
  load() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.levels = Array.isArray(parsed)
          ? parsed.map(level => this.normalizeLevel(level)).filter(Boolean)
          : [];
        // Persist normalized schema (including survival defaults) for legacy levels.
        this.save();
        if (this.levels.length > 0) {
          this.currentLevelIndex = 0;
        }
      }
      
      const trainingData = localStorage.getItem(TRAINING_KEY);
      if (trainingData) {
        this.trainingLevels = JSON.parse(trainingData);
      }
    } catch (e) {
      console.error('Failed to load levels:', e);
      this.levels = [];
      this.trainingLevels = [];
    }
  }

  normalizeLevel(level) {
    if (!level || typeof level !== 'object') return null;

    if (!Array.isArray(level.pegs)) level.pegs = [];
    if (!Array.isArray(level.groups)) level.groups = [];
    if (!level.bezierCurves || typeof level.bezierCurves !== 'object' || Array.isArray(level.bezierCurves)) {
      level.bezierCurves = {};
    }
    if (!Object.prototype.hasOwnProperty.call(level, 'flippers')) {
      level.flippers = null;
    } else {
      level.flippers = normalizeFlipperConfig(level.flippers, { canvasHeight: 600 }) || null;
    }
    level.yoyo = normalizeYoyoSettings(level.yoyo);
    for (const peg of level.pegs) {
      if (peg && peg.type === 'multi') {
        peg.multiballSpawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
      }
    }

    level.metadata = level.metadata || {};
    if (!level.metadata.created) {
      level.metadata.created = new Date().toISOString().split('T')[0];
    }
    if (!level.metadata.modified) {
      level.metadata.modified = new Date().toISOString();
    }
    if (level.metadata.playCount == null) {
      level.metadata.playCount = 0;
    }
    if (!Object.prototype.hasOwnProperty.call(level.metadata, 'avgCompletionRate')) {
      level.metadata.avgCompletionRate = null;
    }
    if (!Object.prototype.hasOwnProperty.call(level.metadata, 'authorNotes')) {
      level.metadata.authorNotes = '';
    }

    ensureLevelSurvival(level, 600);
    level.visuals = normalizeVisuals(level.visuals);
    return level;
  }

  // Get all levels
  getAllLevels() {
    return this.levels;
  }

  // Get level count
  getLevelCount() {
    return this.levels.length;
  }

  // Clear all levels (careful!)
  clearAll() {
    this.levels = [];
    this.trainingLevels = [];
    this.currentLevelIndex = -1;
    this.save();
    this.saveTrainingData();
  }
}
