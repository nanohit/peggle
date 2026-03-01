// Peggle Renderer - Canvas rendering for game and editor

import { PHYSICS_CONFIG, getBallRadius } from './physics.js';

// Color palette
const COLORS = {
  background: '#1a1a2e',
  backgroundGradientTop: '#16213e',
  backgroundGradientBottom: '#1a1a2e',
  
  // Peg colors
  orange: '#ff6b35',
  orangeHit: '#ffb347',
  orangeGlow: 'rgba(255, 107, 53, 0.5)',
  
  blue: '#4ecdc4',
  blueHit: '#7ee8e2',
  blueGlow: 'rgba(78, 205, 196, 0.4)',
  
  green: '#95d5b2',
  greenHit: '#b7e4c7',
  greenGlow: 'rgba(149, 213, 178, 0.4)',
  
  purple: '#c77dff',
  purpleHit: '#e0aaff',
  purpleGlow: 'rgba(199, 125, 255, 0.4)',

  // Multiball
  multi: '#ff4d9d',
  multiHit: '#ff7ab8',
  multiGlow: 'rgba(255, 77, 157, 0.5)',
  
  // Obstacle
  obstacle: '#6b7280',
  obstacleGlow: 'rgba(107, 114, 128, 0.3)',

  // Bumper
  bumper: '#e0e0e0',
  bumperHit: '#ffffff',
  bumperGlow: 'rgba(224, 224, 224, 0.5)',
  bumperRing: '#a0a0a0',
  
  // Ball
  ball: '#f8f9fa',
  ballGlow: 'rgba(248, 249, 250, 0.6)',
  
  // UI
  launcher: '#adb5bd',
  launcherAim: 'rgba(255, 255, 255, 0.4)',
  trajectoryLine: 'rgba(255, 255, 255, 0.3)',
  trajectoryDot: 'rgba(255, 255, 255, 0.5)',
  bucket: '#6c757d',
  bucketInner: '#495057',
  
  // Flippers
  flipper: '#c0c0c0',
  flipperPivot: '#555555',

  // Grid
  gridLine: 'rgba(255, 255, 255, 0.08)',
  gridLineStrong: 'rgba(255, 255, 255, 0.15)',
  
  // Selection
  selection: '#ffd60a',
  selectionFill: 'rgba(255, 214, 10, 0.15)',
  
  // Text
  text: '#f8f9fa',
  textDim: '#adb5bd',
  
  // Walls
  wall: 'rgba(255, 255, 255, 0.1)'
};

const PEG_COLORS = {
  orange: { main: COLORS.orange, hit: COLORS.orangeHit, glow: COLORS.orangeGlow },
  blue: { main: COLORS.blue, hit: COLORS.blueHit, glow: COLORS.blueGlow },
  green: { main: COLORS.green, hit: COLORS.greenHit, glow: COLORS.greenGlow },
  purple: { main: COLORS.purple, hit: COLORS.purpleHit, glow: COLORS.purpleGlow },
  multi: { main: COLORS.multi, hit: COLORS.multiHit, glow: COLORS.multiGlow },
  obstacle: { main: COLORS.obstacle, hit: COLORS.obstacle, glow: COLORS.obstacleGlow },
  bumper: { main: COLORS.bumper, hit: COLORS.bumperHit, glow: COLORS.bumperGlow }
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    
    // Editor state
    this.showGrid = false;
    this.gridSize = 20;
    this.selectedPegIds = new Set();
    
    // Aim state
    this.aimAngle = Math.PI / 2;
    this.showAim = false;
    this.launchX = 0;
    this.launchY = 40;

  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.launchX = width / 2;
  }

  clear() {
    const ctx = this.ctx;
    
    // Draw gradient background
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, COLORS.backgroundGradientTop);
    gradient.addColorStop(1, COLORS.backgroundGradientBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
    
    // Draw wall indicators
    ctx.strokeStyle = COLORS.wall;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, this.width - 2, this.height - 2);
  }

  drawGrid() {
    if (!this.showGrid) return;
    
    const ctx = this.ctx;
    ctx.lineWidth = 1;

    // Vertical lines
    for (let x = 0; x <= this.width; x += this.gridSize) {
      ctx.strokeStyle = x % (this.gridSize * 5) === 0 ? COLORS.gridLineStrong : COLORS.gridLine;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, this.height);
      ctx.stroke();
    }

    // Horizontal lines
    for (let y = 0; y <= this.height; y += this.gridSize) {
      ctx.strokeStyle = y % (this.gridSize * 5) === 0 ? COLORS.gridLineStrong : COLORS.gridLine;
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(this.width, y + 0.5);
      ctx.stroke();
    }
  }

  // Trace a closed curved-ribbon path defined by slice boundary points.
  // Each slice has {x, y, nx, ny} (position on curve + surface normal).
  // topH/botH = offsets along the normal for the two edges of the ribbon.
  drawCurvedBrickPath(ctx, slices, topH, botH) {
    ctx.beginPath();
    // Top edge left→right
    ctx.moveTo(slices[0].x + slices[0].nx * topH, slices[0].y + slices[0].ny * topH);
    for (let i = 1; i < slices.length; i++) {
      ctx.lineTo(slices[i].x + slices[i].nx * topH, slices[i].y + slices[i].ny * topH);
    }
    // Bottom edge right→left
    for (let i = slices.length - 1; i >= 0; i--) {
      ctx.lineTo(slices[i].x + slices[i].nx * botH, slices[i].y + slices[i].ny * botH);
    }
    ctx.closePath();
  }

  drawPeg(peg, isHit = false, isSelected = false) {
    const ctx = this.ctx;
    const colors = PEG_COLORS[peg.type] || PEG_COLORS.blue;
    const radius = PHYSICS_CONFIG.pegRadius;

    // ── Bumper: metallic circle with ring ──
    if (peg.type === 'bumper') {
      const scale = peg.bumperScale || 1;
      const hitScale = peg._bumperHitScale || 1;
      const r = radius * scale * hitScale;

      // Determine color based on bumper mode
      let ringColor = COLORS.bumperRing;
      let bodyColorOuter = '#909090';
      let bodyColorMid = '#d0d0d0';
      let glowColor = COLORS.bumperGlow;
      if (peg.bumperDisappear) {
        // Blue tint (like normal pegs)
        ringColor = '#3a9e97';
        bodyColorOuter = '#2a7a74';
        bodyColorMid = '#4ecdc4';
        glowColor = COLORS.blueGlow;
      }
      if (peg.bumperOrange) {
        // Orange tint (must-hit)
        ringColor = '#cc5528';
        bodyColorOuter = '#a0401a';
        bodyColorMid = '#ff6b35';
        glowColor = COLORS.orangeGlow;
      }

      ctx.save();
      ctx.translate(peg.x, peg.y);

      // Thick outer ring (stroked inward to fill the edge)
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = ringColor;
      ctx.fill();

      // Inner body fill (smaller circle inside the ring)
      const innerR = r * 0.7;
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, innerR);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, bodyColorMid);
      grad.addColorStop(1, bodyColorOuter);
      ctx.beginPath();
      ctx.arc(0, 0, innerR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Specular glare (centered)
      ctx.beginPath();
      ctx.arc(0, 0, innerR * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.fill();

      // Hit glow for disappearing bumpers (drawn under the pulse)
      if (isHit && (peg.bumperDisappear || peg.bumperOrange)) {
        ctx.globalAlpha = 0.5;
        const hitColor = peg.bumperOrange ? COLORS.orangeHit : COLORS.blueHit;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = hitColor;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Hit flash pulse (always on top)
      if (peg._bumperHitScale && peg._bumperHitScale > 1.01) {
        const pulseAlpha = Math.min(1, (peg._bumperHitScale - 1) * 5);
        ctx.globalAlpha = pulseAlpha;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 30;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      // Selection indicator
      if (isSelected) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, r + 7, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
      return;
    }

    // ── Curved brick: render as a warped ribbon in world space ──
    if (peg.shape === 'brick' && peg.curveSlices && peg.curveSlices.length >= 2) {
      const halfH = (peg.height || PHYSICS_CONFIG.pegRadius * 1.2) / 2;
      const sl = peg.curveSlices;
      ctx.save();

      // Glow
      if (!isHit) { ctx.shadowColor = colors.glow; ctx.shadowBlur = 12; }

      // Main fill
      this.drawCurvedBrickPath(ctx, sl, halfH, -halfH);
      ctx.fillStyle = isHit ? colors.hit : colors.main;
      ctx.fill();

      // Subtle edge outline
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Inner highlight (thin strip along top)
      this.drawCurvedBrickPath(ctx, sl, halfH, halfH * 0.3);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.fill();

      // Selection ring
      if (isSelected) {
        this.drawCurvedBrickPath(ctx, sl, halfH + 4, -halfH - 4);
        ctx.strokeStyle = COLORS.selection;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Hit glow overlay
      if (isHit && peg.type !== 'obstacle') {
        ctx.globalAlpha = 0.6;
        ctx.shadowColor = colors.hit;
        ctx.shadowBlur = 20;
        this.drawCurvedBrickPath(ctx, sl, halfH, -halfH);
        ctx.fillStyle = colors.hit;
        ctx.fill();
      }

      ctx.restore();
      return;
    }

    // ── Flat brick / circle: existing local-space rendering ──
    ctx.save();
    ctx.translate(peg.x, peg.y);
    ctx.rotate(peg.angle || 0);

    // Glow effect
    if (!isHit) {
      ctx.shadowColor = colors.glow;
      ctx.shadowBlur = 12;
    }

    if (peg.shape === 'brick') {
      const w = peg.width || PHYSICS_CONFIG.pegRadius * 4;
      const h = peg.height || PHYSICS_CONFIG.pegRadius * 1.2;

      ctx.beginPath();
      ctx.roundRect(-w/2, -h/2, w, h, 2);
      ctx.fillStyle = isHit ? colors.hit : colors.main;
      ctx.fill();

      // Inner highlight
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.beginPath();
      ctx.roundRect(-w/2 + 2, -h/2 + 1, w - 4, h/3, 1);
      ctx.fill();
    } else {
      // Draw circle peg
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = isHit ? colors.hit : colors.main;
      ctx.fill();

      // Inner highlight
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(-radius * 0.25, -radius * 0.25, radius * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fill();
    }

    // Selection indicator
    if (isSelected) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;

      if (peg.shape === 'brick') {
        const w = peg.width || PHYSICS_CONFIG.brickWidth;
        const h = peg.height || PHYSICS_CONFIG.brickHeight;
        ctx.strokeRect(-w/2 - 4, -h/2 - 4, w + 8, h + 8);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Hit state - brighter glow
    if (isHit && peg.type !== 'obstacle') {
      ctx.globalAlpha = 0.6;
      ctx.shadowColor = colors.hit;
      ctx.shadowBlur = 20;

      if (peg.shape === 'brick') {
        const w = peg.width || PHYSICS_CONFIG.brickWidth;
        const h = peg.height || PHYSICS_CONFIG.brickHeight;
        ctx.beginPath();
        ctx.roundRect(-w/2, -h/2, w, h, 3);
        ctx.fillStyle = colors.hit;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = colors.hit;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  getWrapCopyOffsets(peg) {
    // Proximity-based: show copies when the peg is near any screen edge
    // so that wrapping looks smooth instead of jumping.
    const buffer = PHYSICS_CONFIG.pegRadius * 2;
    const copies = [];
    const nearL = peg.x < buffer;
    const nearR = peg.x > this.width - buffer;
    const nearT = peg.y < buffer;
    const nearB = peg.y > this.height - buffer;

    if (nearR) copies.push({ x: -this.width, y: 0 });
    if (nearL) copies.push({ x:  this.width, y: 0 });
    if (nearB) copies.push({ x: 0, y: -this.height });
    if (nearT) copies.push({ x: 0, y:  this.height });

    // Corner copies
    if (nearR && nearB) copies.push({ x: -this.width, y: -this.height });
    if (nearR && nearT) copies.push({ x: -this.width, y:  this.height });
    if (nearL && nearB) copies.push({ x:  this.width, y: -this.height });
    if (nearL && nearT) copies.push({ x:  this.width, y:  this.height });

    return copies;
  }

  drawPegWithOffset(peg, offsetX, offsetY, isHit = false, isSelected = false, alpha = 1) {
    if (alpha <= 0.001) return;
    if (Math.abs(offsetX) < 0.001 && Math.abs(offsetY) < 0.001 && alpha >= 0.999) {
      this.drawPeg(peg, isHit, isSelected);
      return;
    }

    this.ctx.save();
    this.ctx.globalAlpha *= alpha;
    const shifted = { ...peg, x: peg.x + offsetX, y: peg.y + offsetY };
    if (peg.curveSlices) {
      shifted.curveSlices = peg.curveSlices.map(s => ({
        ...s,
        x: s.x + offsetX,
        y: s.y + offsetY
      }));
    }
    this.drawPeg(shifted, isHit, isSelected);
    this.ctx.restore();
  }

  drawPegs(pegs, hitPegIds = [], selectedIds = new Set(), wrapCopyPegIds = null) {
    const hitSet = new Set(hitPegIds);
    const wrapSet = wrapCopyPegIds instanceof Set ? wrapCopyPegIds : null;
    
    for (const peg of pegs) {
      const isHit = hitSet.has(peg.id);
      const isSelected = selectedIds.has(peg.id);

      // When wrapping through walls, hide the main peg (which teleports)
      // and draw only the raw-position copies (which move continuously).
      if (!peg._wrapHideMain) {
        this.drawPeg(peg, isHit, isSelected);
      }

      if (peg._wrapCopies) {
        for (const copy of peg._wrapCopies) {
          this.drawPegWithOffset(peg, copy.x - peg.x, copy.y - peg.y, isHit, isSelected, 1);
        }
      }
    }
  }

  drawBall(ball) {
    if (!ball) return;

    const ctx = this.ctx;

    // Ball glow
    ctx.shadowColor = COLORS.ballGlow;
    ctx.shadowBlur = 15;

    // Ball body
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.ball;
    ctx.fill();

    // Highlight
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(ball.x - ball.radius * 0.25, ball.y - ball.radius * 0.25, ball.radius * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fill();
  }

  drawLauncher(x, y, angle, showAim = true) {
    const ctx = this.ctx;
    
    // Launcher base
    ctx.fillStyle = COLORS.launcher;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.fill();

    // Ball preview in launcher
    ctx.fillStyle = COLORS.ball;
    ctx.beginPath();
    ctx.arc(x, y, getBallRadius(), 0, Math.PI * 2);
    ctx.fill();

    // Direction indicator
    if (showAim) {
      const indicatorLen = 25;
      ctx.strokeStyle = COLORS.launcherAim;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * indicatorLen, y + Math.sin(angle) * indicatorLen);
      ctx.stroke();
    }
  }

  drawTrajectory(trajectory, fullPath = false) {
    if (!trajectory || !trajectory.points || trajectory.points.length < 2) return;
    
    const ctx = this.ctx;
    const points = trajectory.points;
    
    if (fullPath) {
      // Draw full trajectory path
      ctx.strokeStyle = COLORS.trajectoryLine;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Draw dots at intervals
      ctx.fillStyle = COLORS.trajectoryDot;
      for (let i = 0; i < points.length; i += 10) {
        ctx.beginPath();
        ctx.arc(points[i].x, points[i].y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      
      // Mark hit points
      ctx.fillStyle = COLORS.orange;
      for (const hit of trajectory.hits) {
        ctx.beginPath();
        ctx.arc(hit.x, hit.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Draw trajectory to first hit only (dotted line)
      ctx.strokeStyle = COLORS.trajectoryLine;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Draw end point
      if (points.length > 1) {
        const endPoint = points[points.length - 1];
        ctx.fillStyle = COLORS.trajectoryDot;
        ctx.beginPath();
        ctx.arc(endPoint.x, endPoint.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawBalls(balls) {
    if (!balls || balls.length === 0) return;
    for (const ball of balls) {
      this.drawBall(ball);
    }
  }

  drawBucket(bucket) {
    const ctx = this.ctx;
    const { x, y, width, height } = bucket;

    // Bucket body
    ctx.fillStyle = COLORS.bucket;
    ctx.beginPath();
    ctx.moveTo(x - width / 2, y - height / 2);
    ctx.lineTo(x - width / 2 + 8, y + height / 2);
    ctx.lineTo(x + width / 2 - 8, y + height / 2);
    ctx.lineTo(x + width / 2, y - height / 2);
    ctx.closePath();
    ctx.fill();

    // Inner
    ctx.fillStyle = COLORS.bucketInner;
    ctx.beginPath();
    ctx.moveTo(x - width / 2 + 4, y - height / 2 + 4);
    ctx.lineTo(x - width / 2 + 10, y + height / 2 - 2);
    ctx.lineTo(x + width / 2 - 10, y + height / 2 - 2);
    ctx.lineTo(x + width / 2 - 4, y - height / 2 + 4);
    ctx.closePath();
    ctx.fill();
  }

  drawFlippers(flippers, canvasWidth, selected) {
    if (!flippers || !flippers.enabled) return;
    const ctx = this.ctx;
    const centerX = canvasWidth / 2;
    const t = flippers._flipperT || 0;
    const restRad = (flippers.restAngle || 25) * Math.PI / 180;
    const flipRad = (flippers.flipAngle || 30) * Math.PI / 180;

    const sc = flippers.scale || 1;
    const len = (flippers.length || 40) * sc;
    const w = (flippers.width || 8) * sc;

    // Left flipper: rest points down-right, flip points up-right
    const leftPivotX = centerX - flippers.xOffset;
    const leftAngle = restRad - t * (restRad + flipRad);
    this.drawSingleFlipper(leftPivotX, flippers.y, leftAngle, len, w, t, selected);

    // Right flipper: mirrored
    const rightPivotX = centerX + flippers.xOffset;
    const rightAngle = Math.PI - leftAngle;
    this.drawSingleFlipper(rightPivotX, flippers.y, rightAngle, len, w, t, selected);
  }

  drawSingleFlipper(pivotX, pivotY, angle, length, width, t, selected) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle);

    const r = width / 2;

    // Rounded bar shape: pivot end (semicircle) → straight → tip (semicircle)
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, true);  // pivot semicircle (left side)
    ctx.lineTo(length - r, r);
    ctx.arc(length - r, 0, r, Math.PI / 2, -Math.PI / 2, true); // tip semicircle
    ctx.lineTo(0, -r);
    ctx.closePath();

    // Metallic gradient
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, t > 0.5 ? '#f0f0f0' : '#d0d0d0');
    grad.addColorStop(0.5, t > 0.5 ? '#e0e0e0' : '#b0b0b0');
    grad.addColorStop(1, t > 0.5 ? '#c0c0c0' : '#909090');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Selection highlight
    if (selected) {
      ctx.strokeStyle = COLORS.selection;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Pivot dot
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.flipperPivot;
    ctx.fill();

    ctx.restore();
  }

  drawScore(score, ballsLeft, orangePegsLeft, totalOrangePegs) {
    const ctx = this.ctx;
    
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${score.toLocaleString()}`, 10, 20);

    ctx.textAlign = 'right';
    ctx.fillText(`⚪ ${ballsLeft}`, this.width - 10, 20);

    // Orange pegs counter
    ctx.fillStyle = COLORS.orange;
    ctx.textAlign = 'center';
    const pegsText = `🟠 ${totalOrangePegs - orangePegsLeft}/${totalOrangePegs}`;
    ctx.fillText(pegsText, this.width / 2, 20);
  }

  drawMessage(text, subtext = '') {
    const ctx = this.ctx;
    
    // Overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, this.width, this.height);

    // Main text
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 28px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, this.width / 2, this.height / 2 - 15);

    // Subtext
    if (subtext) {
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '14px -apple-system, sans-serif';
      ctx.fillText(subtext, this.width / 2, this.height / 2 + 15);
    }
  }

  // Faint line showing the raw drawn path
  drawSplinePath(rawPoints) {
    if (!rawPoints || rawPoints.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(rawPoints[0].x, rawPoints[0].y);
    for (let i = 1; i < rawPoints.length; i++) {
      ctx.lineTo(rawPoints[i].x, rawPoints[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // Semi-transparent preview of where bricks/circles will be placed
  drawGhostBricks(ghostBricks, brickW, brickH, pegType, pegShape) {
    if (!ghostBricks || ghostBricks.length === 0) return;
    const ctx = this.ctx;
    const colors = PEG_COLORS[pegType] || PEG_COLORS.blue;
    const radius = PHYSICS_CONFIG.pegRadius;
    const halfH = brickH / 2;
    ctx.save();
    ctx.globalAlpha = 0.6;
    for (const gb of ghostBricks) {
      if (pegShape === 'brick' && gb.slices && gb.slices.length >= 2) {
        // Curved ghost brick — warped ribbon
        this.drawCurvedBrickPath(ctx, gb.slices, halfH, -halfH);
        ctx.fillStyle = colors.main;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 0.5;
        ctx.stroke();
        // Top highlight
        this.drawCurvedBrickPath(ctx, gb.slices, halfH, halfH * 0.3);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.fill();
      } else if (pegShape === 'brick') {
        // Flat ghost brick fallback
        ctx.save();
        ctx.translate(gb.x, gb.y);
        ctx.rotate(gb.angle || 0);
        ctx.beginPath();
        ctx.roundRect(-brickW / 2, -brickH / 2, brickW, brickH, 2);
        ctx.fillStyle = colors.main;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      } else {
        // Circle ghost
        ctx.save();
        ctx.translate(gb.x, gb.y);
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = colors.main;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawWrappedMotionLine(start, motion) {
    if (!start || !motion) return;
    const eps = 1e-6;
    const W = this.width, H = this.height;
    let cx = start.x, cy = start.y;
    let vx = motion.dx || 0, vy = motion.dy || 0;
    let guard = 0;

    const hitAlpha = (px, py, dvx, dvy) => {
      let a = Infinity;
      if (Math.abs(dvx) > eps) {
        const t = (dvx > 0 ? W - px : -px) / dvx;
        if (t > eps) a = Math.min(a, t);
      }
      if (Math.abs(dvy) > eps) {
        const t = (dvy > 0 ? H - py : -py) / dvy;
        if (t > eps) a = Math.min(a, t);
      }
      return a;
    };

    while ((Math.abs(vx) > eps || Math.abs(vy) > eps) && guard < 10) {
      guard++;

      const alphaFwd = hitAlpha(cx, cy, vx, vy);

      if (alphaFwd >= 1) {
        // No wall hit — draw to destination
        this.ctx.beginPath();
        this.ctx.moveTo(cx, cy);
        this.ctx.lineTo(cx + vx, cy + vy);
        this.ctx.stroke();
        break;
      }

      // Draw segment to wall hit
      const wallX = cx + vx * alphaFwd;
      const wallY = cy + vy * alphaFwd;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, cy);
      this.ctx.lineTo(wallX, wallY);
      this.ctx.stroke();

      // Remaining velocity
      const remainVx = vx * (1 - alphaFwd);
      const remainVy = vy * (1 - alphaFwd);

      // Red dot: trace backwards from current pos to wall
      const alphaRev = hitAlpha(cx, cy, -vx, -vy);
      cx = cx - vx * alphaRev;
      cy = cy - vy * alphaRev;
      vx = remainVx;
      vy = remainVy;
    }
  }

  drawAnimationGhosts(ghosts, center, ghostCenter, offset, motion, _inverse = false) {
    if (!ghosts || ghosts.length === 0 || !center) return;
    const ctx = this.ctx;
    const radius = PHYSICS_CONFIG.pegRadius;

    const fallbackCenter = offset
      ? { x: center.x + offset.dx, y: center.y + offset.dy }
      : null;
    const targetCenter = ghostCenter || fallbackCenter;

    // Guide line: center → ghost (forward), and center → wall (backward) + fat dot
    ctx.save();
    const dx = (motion && motion.dx) || (targetCenter ? targetCenter.x - center.x : 0);
    const dy = (motion && motion.dy) || (targetCenter ? targetCenter.y - center.y : 0);
    const hasDelta = Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001;

    if (hasDelta) {
      const W = this.width, H = this.height;

      // Forward line: center → ghost destination (traces through walls)
      ctx.strokeStyle = '#ffd60a';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      this.drawWrappedMotionLine(center, { dx, dy });
      ctx.setLineDash([]);

      // Reverse line: trace from center in OPPOSITE direction until hitting a wall
      const rdx = -dx, rdy = -dy;
      let wallAlpha = Infinity;

      if (Math.abs(rdx) > 1e-6) {
        const a = (rdx > 0 ? W - center.x : -center.x) / rdx;
        if (a > 1e-6) wallAlpha = Math.min(wallAlpha, a);
      }
      if (Math.abs(rdy) > 1e-6) {
        const a = (rdy > 0 ? H - center.y : -center.y) / rdy;
        if (a > 1e-6) wallAlpha = Math.min(wallAlpha, a);
      }

      if (Number.isFinite(wallAlpha)) {
        const wallX = center.x + rdx * wallAlpha;
        const wallY = center.y + rdy * wallAlpha;

        // Draw reverse dashed line (same color, slightly dimmer)
        ctx.strokeStyle = 'rgba(255, 214, 10, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(center.x, center.y);
        ctx.lineTo(wallX, wallY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Fat dot at wall intersection
        ctx.fillStyle = '#ff3b30';
        ctx.beginPath();
        ctx.arc(wallX, wallY, 6, 0, Math.PI * 2);
        ctx.fill();

      }
    }

    // Draw ghost pegs at offset position
    ctx.globalAlpha = 0.35;
    for (const ghost of ghosts) {
      this.drawPeg(ghost, false, false);
    }
    ctx.globalAlpha = 1;

    // Yellow outline around each ghost peg to indicate draggable
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 1.5;
    for (const ghost of ghosts) {
      if (ghost.shape === 'brick' && ghost.curveSlices && ghost.curveSlices.length >= 2) {
        const halfH = (ghost.height || radius * 1.2) / 2;
        this.drawCurvedBrickPath(ctx, ghost.curveSlices, halfH + 3, -halfH - 3);
        ctx.stroke();
      } else if (ghost.shape === 'brick') {
        ctx.save();
        ctx.translate(ghost.x, ghost.y);
        ctx.rotate(ghost.angle || 0);
        const w = ghost.width || radius * 4;
        const h = ghost.height || radius * 1.2;
        ctx.strokeRect(-w/2 - 3, -h/2 - 3, w + 6, h + 6);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(ghost.x, ghost.y, radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  drawAnimationIndicators(pegs, groups) {
    if (!pegs) return;
    const ctx = this.ctx;
    const groupAnimIds = new Set();

    // Mark group-animated pegs
    if (groups) {
      for (const g of groups) {
        if (g.animation) {
          for (const p of pegs) {
            if (p.groupId === g.id) groupAnimIds.add(p.id);
          }
        }
      }
    }

    ctx.save();
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd60a';

    for (const peg of pegs) {
      const hasAnim = peg.animation || groupAnimIds.has(peg.id);
      if (hasAnim) {
        const radius = peg.shape === 'brick'
          ? Math.max(peg.width || 40, peg.height || 12) / 2
          : PHYSICS_CONFIG.pegRadius;
        ctx.fillText('\u2194', peg.x, peg.y - radius - 5);
      }
    }
    ctx.restore();
  }

  drawEditorHUD(pegCount, selectedCount, drawMode = false, drawShapeMode = 'free') {
    const ctx = this.ctx;

    ctx.fillStyle = COLORS.textDim;
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Pegs: ${pegCount}`, 10, this.height - 15);

    if (selectedCount > 0) {
      ctx.fillText(`Selected: ${selectedCount}`, 80, this.height - 15);
    }

    if (drawMode) {
      ctx.fillStyle = COLORS.orange;
      ctx.textAlign = 'right';
      let hint;
      if (drawShapeMode === 'circle') {
        hint = 'DRAW: Circle (C) | W=sine D=free';
      } else if (drawShapeMode === 'sine') {
        hint = 'DRAW: Sine (W) | C=circle D=free';
      } else {
        hint = 'DRAW: Freehand | SHIFT=snap | C=circle W=sine';
      }
      ctx.fillText(hint, this.width - 10, this.height - 15);
    }
  }

  drawShapeCenter(x, y) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    const size = 8;
    ctx.beginPath();
    ctx.moveTo(x - size, y);
    ctx.lineTo(x + size, y);
    ctx.moveTo(x, y - size);
    ctx.lineTo(x, y + size);
    ctx.stroke();
    ctx.restore();
  }

  drawSelectionBox(startX, startY, endX, endY) {
    const ctx = this.ctx;
    
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const w = Math.abs(endX - startX);
    const h = Math.abs(endY - startY);

    ctx.fillStyle = COLORS.selectionFill;
    ctx.fillRect(x, y, w, h);
    
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  drawRotationHandle(handle, bounds, isBumperScale = false) {
    if (!handle || !bounds) return;

    const ctx = this.ctx;

    // Draw selection bounds outline
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      bounds.minX - 4,
      bounds.minY - 4,
      bounds.maxX - bounds.minX + 8,
      bounds.maxY - bounds.minY + 8
    );
    ctx.setLineDash([]);

    // Draw line from top of bounds to handle
    const centerX = (bounds.minX + bounds.maxX) / 2;
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, bounds.minY - 4);
    ctx.lineTo(handle.x, handle.y);
    ctx.stroke();

    // Draw handle circle
    ctx.fillStyle = COLORS.selection;
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, 8, 0, Math.PI * 2);
    ctx.fill();

    if (isBumperScale) {
      // Draw scale arrows icon (↔) instead of rotation dot
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⇔', handle.x, handle.y);
    } else {
      // Inner circle (rotation)
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Render full game frame
  renderGame(state) {
    this.clear();
    
    if (state.showGrid) {
      this.showGrid = true;
      this.drawGrid();
    }

    this.drawPegs(
      state.pegs,
      state.hitPegIds,
      state.selectedPegIds || new Set(),
      state.wrapCopyPegIds || null
    );

    // Draw ghost preview during draw mode
    if (state.ghostBricks && state.ghostBricks.length > 0) {
      this.drawSplinePath(state.drawPath);
      this.drawGhostBricks(state.ghostBricks, state.brickWidth, state.brickHeight, state.pegType, state.pegShape);
    }

    // Draw trajectory before ball
    if (state.trajectory) {
      this.drawTrajectory(state.trajectory, state.showFullTrajectory);
    }
    
    if (state.balls) {
      this.drawBalls(state.balls);
    } else if (state.ball) {
      this.drawBall(state.ball);
    }

    if (state.bucket) {
      this.drawBucket(state.bucket);
    }

    if (state.flippers) {
      this.drawFlippers(state.flippers, this.canvas.width, state.flipperSelected);
    }

    if (state.showLauncher) {
      this.drawLauncher(state.launchX, state.launchY, state.aimAngle, state.showAim);
    }

    if (state.score !== undefined) {
      this.drawScore(state.score, state.ballsLeft, state.orangePegsLeft, state.totalOrangePegs);
    }

    if (state.selectionBox) {
      this.drawSelectionBox(
        state.selectionBox.startX,
        state.selectionBox.startY,
        state.selectionBox.endX,
        state.selectionBox.endY
      );
    }

    // Draw rotation/scale handle for selected elements
    if (state.rotationHandle && state.selectionBounds) {
      this.drawRotationHandle(state.rotationHandle, state.selectionBounds, state.isBumperSelection);
    }

    // Animation ghosts (editor animation mode)
    if (state.animationMode && state.animationGhosts) {
      this.drawAnimationGhosts(
        state.animationGhosts,
        state.animationCenter,
        state.animationGhostCenter,
        state.animationGhostOffset,
        state.animationMotion,
        state.animationInverse
      );
    }

    if (state.message) {
      this.drawMessage(state.message, state.subMessage);
    }

    if (state.drawCenter) {
      this.drawShapeCenter(state.drawCenter.x, state.drawCenter.y);
    }

    if (state.isEditor) {
      this.drawEditorHUD(state.pegs.length, state.selectedPegIds?.size || 0, state.drawMode, state.drawShapeMode);
      // Show animation indicators when not in animation mode
      if (!state.animationMode) {
        this.drawAnimationIndicators(state.pegs, state.groups);
      }
    }
  }
}
