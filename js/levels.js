// Peggle Levels - Level management and storage

import { Utils } from './utils.js';
import { PHYSICS_CONFIG, DEFAULT_PEG_RADIUS } from './physics.js';
import { normalizeFlipperConfig } from './flipper-defaults.js';
import {
  ensureLevelSurvival,
  normalizeSurvivalGamblePegProperties,
  normalizeSurvivalSettings
} from './survival-mode.js';
import { ensureLevelPvp, normalizePvpSettings } from './pvp-mode.js';
import { normalizeYoyoSettings } from './yoyo-thread.js';
import { normalizeMultiballSpawnCount } from './multiball-settings.js';
import { normalizeVisuals } from './visual-config.js';
import { normalizeDialogueConfig } from './dialogue-config.js';
import { normalizeLevelCharacterAssignment } from './character-config.js';
import { normalizeLevelHitPegClearSettings } from './hit-peg-clear-settings.js';
import { isPortalType, normalizePortalPegProperties } from './portal-defaults.js';
import { ensureLevelBilliard, isBilliardPegType } from './billiard-mode.js';
import { isBombMagnetType, normalizeMagnetPegProperties } from './magnet-defaults.js';
import { normalizePegType } from './peg-types.js';
import {
  ensureLevelDestruction,
  normalizeDestructionPegProperties
} from './destruction-mode.js';

const STORAGE_KEY = 'peggle_levels';
const TRAINING_KEY = 'peggle_training_data';
const STORAGE_OVERFLOW_KEY = 'peggle_levels_local_overflow';
const STORAGE_QUOTA_RETRY_MS = 30000;

function isStorageQuotaError(error) {
  return error && (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error.code === 22 ||
    error.code === 1014
  );
}

function writeSmallStorageFlag(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch { /* best effort */ }
}

export function normalizeLevelData(level) {
  if (!level || typeof level !== 'object') return null;

  if (!Array.isArray(level.pegs)) level.pegs = [];
  level.pegs = level.pegs.filter(peg => peg && typeof peg === 'object' && !Array.isArray(peg));
  if (!Array.isArray(level.groups)) level.groups = [];
  level.groups = level.groups.filter(group => group && typeof group === 'object' && !Array.isArray(group));
  const validGroupIds = new Set();
  for (const group of level.groups) {
    const groupId = group.id;
    const invalidId = (typeof groupId !== 'string' && typeof groupId !== 'number') || groupId === '';
    if (invalidId || validGroupIds.has(groupId)) {
      group.id = Utils.generateId();
    }
    validGroupIds.add(group.id);
  }
  if (!level.bezierCurves || typeof level.bezierCurves !== 'object' || Array.isArray(level.bezierCurves)) {
    level.bezierCurves = {};
  }
  if (!Object.prototype.hasOwnProperty.call(level, 'flippers')) {
    level.flippers = null;
  } else {
    level.flippers = normalizeFlipperConfig(level.flippers, { canvasHeight: 600 }) || null;
  }
  level.yoyo = normalizeYoyoSettings(level.yoyo);
  if (typeof level.aimLength !== 'number') level.aimLength = 300;
  level.aimLength = Math.max(0, Math.min(300, Math.round(level.aimLength)));
  // Per-level peg/ball/brick size. Absent ⇒ default; keep it absent on legacy
  // levels so they stay byte-identical. A present value is clamped to a sane range.
  if (Number.isFinite(level.pegRadius)) {
    level.pegRadius = Math.max(3, Math.min(24, level.pegRadius));
  } else {
    delete level.pegRadius;
  }
  normalizeLevelHitPegClearSettings(level);
  const survival = ensureLevelSurvival(level, 600);
  const pvp = ensureLevelPvp(level);
  const billiard = ensureLevelBilliard(level);
  const destruction = ensureLevelDestruction(level);
  if (destruction.enabled) {
    survival.enabled = false;
    pvp.enabled = false;
    billiard.enabled = false;
  } else if (billiard.enabled) {
    survival.enabled = false;
    pvp.enabled = false;
  } else if (pvp.enabled && survival.enabled) {
    survival.enabled = false;
  }
  for (const peg of level.pegs) {
    peg.type = normalizePegType(peg.type);
    if (peg && peg.groupId != null && !validGroupIds.has(peg.groupId)) {
      peg.groupId = null;
    }
    if (peg && peg.type === 'multi') {
      peg.multiballSpawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
    }
    if (peg && peg.type === 'gamble') {
      Object.assign(peg, normalizeSurvivalGamblePegProperties(peg, survival.gamblePeg));
      delete peg.gambleBalls;
      delete peg.gambleBallsAward;
      delete peg.gambleKnockbackStrength;
      delete peg.gambleKnockbackSmooth;
      delete peg.knockbackEnabled;
      delete peg.luckBonus;
      delete peg.slotLuckBonus;
      delete peg.knockbackDistance;
      delete peg.knockbackStrength;
      delete peg.knockbackSmooth;
      delete peg.knockbackSmoothMs;
    }
    if (peg && isPortalType(peg.type)) {
      normalizePortalPegProperties(peg, { upgradeLegacyDefault: true });
    }
    if (peg && isBombMagnetType(peg.type)) {
      normalizeMagnetPegProperties(peg);
    }
    if (peg && isBilliardPegType(peg.type)) {
      peg.shape = 'circle';
      delete peg.width;
      delete peg.height;
      delete peg.curveSlices;
      delete peg.brickBaseRadius;
    }
    if (peg && peg.shape === 'brick') {
      if (Number.isFinite(peg.brickBaseRadius)) {
        peg.brickBaseRadius = Math.max(3, Math.min(24, peg.brickBaseRadius));
      } else {
        delete peg.brickBaseRadius;
      }
    } else if (peg) {
      delete peg.brickBaseRadius;
    }
    normalizeDestructionPegProperties(peg);
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

  level.visuals = normalizeVisuals(level.visuals);
  level.character = normalizeLevelCharacterAssignment(level.character);
  level.dialogue = normalizeDialogueConfig(level.dialogue);
  return level;
}

export function cloneLevelSnapshot(level) {
  return normalizeLevelData(Utils.deepClone(level));
}

export class LevelManager {
  constructor() {
    this.levels = [];
    this.trainingLevels = [];
    this.currentLevelIndex = -1;
    this.localStorageOverflowed = false;
    this._localSaveQuotaBlockedUntil = 0;
    this._localSaveQuotaBlockedSize = 0;
    this._localSaveQuotaWarned = false;
    this.load();
  }

  // Create a new empty level
  createLevel(name = 'Untitled Level') {
    const hitPegClear = normalizeLevelHitPegClearSettings({});
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
      hitPegTimedClearEnabled: hitPegClear.enabled,
      hitPegClearDelayMs: hitPegClear.delayMs,
      survival: ensureLevelSurvival({}, 600),
      pvp: normalizePvpSettings(null),
      billiard: ensureLevelBilliard({}),
      destruction: ensureLevelDestruction({}),
      visuals: normalizeVisuals(null),
      character: normalizeLevelCharacterAssignment(null),
      dialogue: normalizeDialogueConfig(null),
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
    if (Object.prototype.hasOwnProperty.call(updates || {}, 'pvp')) {
      level.pvp = normalizePvpSettings(level.pvp);
    } else {
      ensureLevelPvp(level);
    }
    ensureLevelBilliard(level);
    ensureLevelDestruction(level);
    if (level.destruction.enabled) {
      level.survival.enabled = false;
      level.pvp.enabled = false;
      level.billiard.enabled = false;
    } else if (level.billiard.enabled) {
      level.survival.enabled = false;
      level.pvp.enabled = false;
    } else if (level.pvp.enabled && level.survival.enabled) {
      level.survival.enabled = false;
    }
    level.yoyo = normalizeYoyoSettings(level.yoyo);
    normalizeLevelHitPegClearSettings(level);
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
      type: normalizePegType(peg.type),
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
      // Record the pegRadius this brick was authored at so per-level scaling can
      // size it relative to its own baseline (no double-scale, fully reversible).
      // Absent ⇒ treated as DEFAULT_PEG_RADIUS, so legacy bricks are unchanged.
      newPeg.brickBaseRadius = Number.isFinite(peg.brickBaseRadius)
        ? peg.brickBaseRadius
        : (Number.isFinite(PHYSICS_CONFIG.pegRadius) ? PHYSICS_CONFIG.pegRadius : DEFAULT_PEG_RADIUS);
      if (Array.isArray(peg.curveSlices)) {
        newPeg.curveSlices = peg.curveSlices.map(slice => ({ ...slice }));
      }
    }
    if (typeof peg.color === 'string' && peg.color) {
      newPeg.color = peg.color;
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
      delete newPeg.width;
      delete newPeg.height;
      delete newPeg.curveSlices;
      delete newPeg.brickBaseRadius;
    }

    // Portal properties
    if (isPortalType(peg.type)) {
      newPeg.portalScale = peg.portalScale;
      normalizePortalPegProperties(newPeg);
    }

    if (peg.type === 'multi') {
      newPeg.multiballSpawnCount = normalizeMultiballSpawnCount(peg.multiballSpawnCount);
    }
    if (peg.type === 'gamble') {
      Object.assign(newPeg, normalizeSurvivalGamblePegProperties(peg));
    }
    if (isBombMagnetType(peg.type)) {
      Object.assign(newPeg, {
        magnetRadius: peg.magnetRadius,
        magnetStrength: peg.magnetStrength,
        magnetMode: peg.magnetMode,
        magnetExplosionPower: peg.magnetExplosionPower,
        magnetBlast: peg.magnetBlast === true,
        magnetHittable: peg.magnetHittable !== false,
        magnetKnockout: peg.magnetKnockout === true,
        magnetVanishAfterBlast: peg.magnetVanishAfterBlast === true
      });
      normalizeMagnetPegProperties(newPeg);
    }
    if (Object.prototype.hasOwnProperty.call(peg, 'destructionStatic')) {
      newPeg.destructionStatic = peg.destructionStatic;
    }
    if (Object.prototype.hasOwnProperty.call(peg, 'destructionPhysicsOnHit')) {
      newPeg.destructionPhysicsOnHit = peg.destructionPhysicsOnHit;
    }
    if (Object.prototype.hasOwnProperty.call(peg, 'destructionPhysicsOnHitBallOnly')) {
      newPeg.destructionPhysicsOnHitBallOnly = peg.destructionPhysicsOnHitBallOnly;
    }
    if (newPeg.type === 'blue') {
      if (!Object.prototype.hasOwnProperty.call(newPeg, 'destructionPhysicsOnHit')) {
        newPeg.destructionPhysicsOnHit = true;
      }
      if (!Object.prototype.hasOwnProperty.call(newPeg, 'destructionPhysicsOnHitBallOnly')) {
        newPeg.destructionPhysicsOnHitBallOnly = true;
      }
    }
    normalizeDestructionPegProperties(newPeg);
    if (isBilliardPegType(peg.type)) {
      newPeg.shape = 'circle';
      delete newPeg.width;
      delete newPeg.height;
      delete newPeg.curveSlices;
      delete newPeg.brickBaseRadius;
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
      const groupIdMap = new Map();
      level.pegs = level.pegs.filter(peg => peg && typeof peg === 'object' && !Array.isArray(peg));
      level.pegs.forEach(peg => {
        peg.id = Utils.generateId();
      });
      if (Array.isArray(level.groups)) {
        level.groups.forEach(group => {
          if (!group || typeof group !== 'object' || Array.isArray(group)) return;
          const prevId = group?.id;
          const nextId = Utils.generateId();
          if (prevId != null && !groupIdMap.has(prevId)) {
            groupIdMap.set(prevId, nextId);
          }
          group.id = nextId;
        });
      }
      level.pegs.forEach(peg => {
        if (peg.groupId != null) {
          peg.groupId = groupIdMap.get(peg.groupId) || null;
        }
      });
      
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

  _getLocalStorageEvictionCandidates() {
    const candidates = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key === STORAGE_KEY || key === TRAINING_KEY || key === STORAGE_OVERFLOW_KEY) continue;
        const isCampaignCache = key.startsWith('campaign:') || key.startsWith('campaign_ts:');
        const isBakedCache = key.startsWith('baked:');
        if (!isCampaignCache && !isBakedCache) continue;
        const value = localStorage.getItem(key) || '';
        candidates.push({
          key,
          bytes: key.length + value.length,
          priority: isCampaignCache ? 0 : 1
        });
      }
    } catch {
      return [];
    }
    return candidates.sort((a, b) => (a.priority - b.priority) || (b.bytes - a.bytes));
  }

  _markLocalStorageOverflow(size, error) {
    this.localStorageOverflowed = true;
    this._localSaveQuotaBlockedUntil = Date.now() + STORAGE_QUOTA_RETRY_MS;
    this._localSaveQuotaBlockedSize = Number.isFinite(size) ? size : 0;
    writeSmallStorageFlag(STORAGE_OVERFLOW_KEY, {
      size: this._localSaveQuotaBlockedSize,
      at: new Date().toISOString()
    });
    if (!this._localSaveQuotaWarned) {
      this._localSaveQuotaWarned = true;
      console.warn(
        '[storage] Local level cache is too large for localStorage; remote save remains active.',
        '| size:',
        this._localSaveQuotaBlockedSize,
        '| reason:',
        error?.name || error?.message || 'storage quota'
      );
    }
  }

  _trySaveLevelsJson(json) {
    localStorage.setItem(STORAGE_KEY, json);
    this.localStorageOverflowed = false;
    this._localSaveQuotaBlockedUntil = 0;
    this._localSaveQuotaBlockedSize = 0;
    this._localSaveQuotaWarned = false;
    try { localStorage.removeItem(STORAGE_OVERFLOW_KEY); } catch { /* best effort */ }
    return true;
  }

  // Save to localStorage as a best-effort editor cache. Remote save is handled
  // by PeggleApp; quota failures here must never spam console or block editing.
  save() {
    if (typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function') return false;
    const now = Date.now();
    if (this._localSaveQuotaBlockedUntil > now) return false;
    let json = '';
    try {
      json = JSON.stringify(this.levels);
      this._trySaveLevelsJson(json);
      return true;
    } catch (e) {
      if (!isStorageQuotaError(e)) {
        console.warn('[storage] Failed to save local level cache:', e);
        return false;
      }
      for (const candidate of this._getLocalStorageEvictionCandidates()) {
        try {
          localStorage.removeItem(candidate.key);
          this._trySaveLevelsJson(json);
          console.warn('[storage] Freed local cache for levels by evicting:', candidate.key);
          return true;
        } catch (retryError) {
          if (!isStorageQuotaError(retryError)) {
            console.warn('[storage] Failed while freeing local level cache:', retryError);
            return false;
          }
        }
      }
      this._markLocalStorageOverflow(json.length, e);
      return false;
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
      this.localStorageOverflowed = !!localStorage.getItem(STORAGE_OVERFLOW_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.levels = Array.isArray(parsed)
          ? parsed.map(level => this.normalizeLevel(level)).filter(Boolean)
          : [];

        // Log visual persistence check
        for (const lvl of this.levels) {
          const fc = lvl.visuals?.frameColor;
          const isDefault = fc === '#0a0a14';
          console.log(`[visuals] Loaded "${lvl.name}" | frameColor: ${fc}${isDefault ? ' (default)' : ' (custom)'}`);
        }
        const hasVisDef = !!localStorage.getItem('peggle_visualDefaults');
        console.log(`[visuals] Saved visual defaults: ${hasVisDef ? 'yes' : 'no'}`);

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
    return normalizeLevelData(level);
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
