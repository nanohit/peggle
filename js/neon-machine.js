// NEON DROP procedural material system.
//
// The game deliberately stays on the existing 400 x 600 logical canvas.  These
// helpers add depth with gradients, cached surfaces and restrained highlights,
// avoiding extra GPU contexts, textures, and high-DPI backing stores on mobile.

export const NEON_MACHINE = Object.freeze({
  ink: '#020711',
  well: '#061321',
  wellDeep: '#030a13',
  panel: '#0b2135',
  panelLight: '#173b56',
  cyan: '#57efff',
  cyanSoft: 'rgba(87, 239, 255, 0.22)',
  cyanFaint: 'rgba(87, 239, 255, 0.07)',
  orange: '#ff6a1f',
  orangeHot: '#ffb33a',
  white: '#f4fdff',
  shadow: 'rgba(0, 3, 10, 0.72)'
});

const TAU = Math.PI * 2;

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width * 0.5, height * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

export function drawMachineBackdrop(ctx, width, height) {
  ctx.save();

  const base = ctx.createLinearGradient(0, 0, 0, height);
  base.addColorStop(0, '#071b2c');
  base.addColorStop(0.38, '#061422');
  base.addColorStop(0.76, '#040d18');
  base.addColorStop(1, '#02070e');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // Broad, soft overhead light. It gives every level the same stage lighting
  // without competing with the authored peg arrangement.
  const overhead = ctx.createRadialGradient(width * 0.5, height * 0.1, 0, width * 0.5, height * 0.13, width * 0.72);
  overhead.addColorStop(0, 'rgba(63, 202, 255, 0.17)');
  overhead.addColorStop(0.4, 'rgba(28, 112, 170, 0.075)');
  overhead.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = overhead;
  ctx.fillRect(0, 0, width, height * 0.72);

  const floorBloom = ctx.createRadialGradient(width * 0.5, height * 0.96, 0, width * 0.5, height * 0.96, width * 0.62);
  floorBloom.addColorStop(0, 'rgba(0, 211, 255, 0.095)');
  floorBloom.addColorStop(0.52, 'rgba(0, 105, 176, 0.035)');
  floorBloom.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = floorBloom;
  ctx.fillRect(0, height * 0.55, width, height * 0.45);

  // A sparse technical grid reads as a finished playfield surface, not a
  // background illustration. Horizontal spacing tightens toward the top to
  // suggest a shallow perspective well.
  ctx.lineWidth = 0.65;
  ctx.strokeStyle = 'rgba(112, 214, 255, 0.035)';
  for (let x = 24; x < width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 72; y < height; y += 36) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Recessed inner wall with tiny cyan catches along the machined bevel.
  roundedRect(ctx, 9, 6, width - 18, height - 12, 22);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.58)';
  ctx.lineWidth = 9;
  ctx.stroke();
  roundedRect(ctx, 13.5, 10.5, width - 27, height - 21, 18);
  ctx.strokeStyle = 'rgba(108, 226, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const leftShade = ctx.createLinearGradient(0, 0, 42, 0);
  leftShade.addColorStop(0, 'rgba(0, 1, 5, 0.8)');
  leftShade.addColorStop(0.48, 'rgba(0, 4, 10, 0.28)');
  leftShade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = leftShade;
  ctx.fillRect(0, 0, 42, height);
  const rightShade = ctx.createLinearGradient(width, 0, width - 42, 0);
  rightShade.addColorStop(0, 'rgba(0, 1, 5, 0.8)');
  rightShade.addColorStop(0.48, 'rgba(0, 4, 10, 0.28)');
  rightShade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = rightShade;
  ctx.fillRect(width - 42, 0, 42, height);

  // Symmetric rail emitters: pure geometry, deliberately quiet.
  for (const side of [-1, 1]) {
    const x = side < 0 ? 13 : width - 13;
    for (let y = 118; y < height - 56; y += 104) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(side * -0.18);
      const rail = ctx.createLinearGradient(side < 0 ? -1 : 1, -15, side < 0 ? 6 : -6, 15);
      rail.addColorStop(0, 'rgba(7, 21, 35, 0.94)');
      rail.addColorStop(0.5, 'rgba(56, 127, 163, 0.46)');
      rail.addColorStop(1, 'rgba(112, 233, 255, 0.72)');
      ctx.strokeStyle = rail;
      ctx.lineWidth = 4.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.lineTo(side * 7, 13);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(227, 253, 255, 0.72)';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(side * -0.6, -11);
      ctx.lineTo(side * 5.5, 10);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();
}

export function drawMachineAtmosphere(ctx, width, height, timeMs = 0, progress = 0) {
  const t = Math.max(0, Number(timeMs) || 0) * 0.001;
  const completion = Math.max(0, Math.min(1, Number(progress) || 0));
  const breathe = 0.5 + Math.sin(t * 0.72) * 0.5;

  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  // A very slow overhead reflection makes the well feel like a physical
  // cabinet under glass. It is intentionally broad enough to avoid visual
  // noise or expensive particle work on mobile GPUs.
  const lightX = width * (0.34 + Math.sin(t * 0.18) * 0.18);
  const roof = ctx.createRadialGradient(lightX, height * 0.04, 0, lightX, height * 0.08, width * 0.64);
  roof.addColorStop(0, `rgba(92, 226, 255, ${0.034 + breathe * 0.018})`);
  roof.addColorStop(0.46, 'rgba(30, 132, 190, 0.012)');
  roof.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = roof;
  ctx.fillRect(0, 0, width, height * 0.7);

  if (completion > 0.02) {
    const charge = ctx.createRadialGradient(width * 0.5, height * 0.68, 0, width * 0.5, height * 0.68, width * 0.62);
    charge.addColorStop(0, `rgba(255, 100, 24, ${completion * 0.045})`);
    charge.addColorStop(0.42, `rgba(255, 52, 16, ${completion * 0.018})`);
    charge.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = charge;
    ctx.fillRect(0, height * 0.32, width, height * 0.58);
  }

  const scanY = ((t * 13) % (height + 100)) - 50;
  const scan = ctx.createLinearGradient(0, scanY - 16, 0, scanY + 16);
  scan.addColorStop(0, 'rgba(50, 211, 255, 0)');
  scan.addColorStop(0.5, 'rgba(105, 231, 255, 0.018)');
  scan.addColorStop(1, 'rgba(50, 211, 255, 0)');
  ctx.fillStyle = scan;
  ctx.fillRect(12, scanY - 16, width - 24, 32);
  ctx.restore();
}

export function drawPegContactShadow(ctx, x, y, radius, shape = 'circle', width = 0, height = 0, angle = 0) {
  ctx.save();
  ctx.translate(x + 2.3, y + 4.2);
  ctx.rotate(angle || 0);
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(radius * 1.75, width * 0.58));
  shadow.addColorStop(0, 'rgba(0, 1, 6, 0.48)');
  shadow.addColorStop(0.52, 'rgba(0, 2, 8, 0.25)');
  shadow.addColorStop(1, 'rgba(0, 2, 8, 0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  if (shape === 'brick') {
    ctx.ellipse(0, 0, Math.max(width * 0.62, radius), Math.max(height * 1.35, radius * 0.6), 0, 0, TAU);
  } else {
    ctx.ellipse(0, 0, radius * 1.55, radius * 1.18, 0, 0, TAU);
  }
  ctx.fill();
  ctx.restore();
}

export function drawMachineBumper(ctx, peg, radius, isHit = false) {
  const orange = !!peg?.bumperOrange;
  const cyan = !!peg?.bumperDisappear;
  const accent = orange ? '#ff6a22' : (cyan ? '#5cefff' : '#b7dce5');
  const core = orange ? '#ff792c' : (cyan ? '#39cde4' : '#688a9d');
  const hot = orange ? '#ffd59d' : (cyan ? '#e2fcff' : '#f4fdff');
  const pulse = isHit ? 1 : Math.max(0, Math.min(1, (Number(peg?._bumperHitScale) || 1) - 1));

  ctx.save();
  const cast = ctx.createRadialGradient(peg.x + radius * 0.22, peg.y + radius * 0.62, 0, peg.x + radius * 0.22, peg.y + radius * 0.62, radius * 1.75);
  cast.addColorStop(0, 'rgba(0, 1, 6, 0.66)');
  cast.addColorStop(0.52, 'rgba(0, 2, 8, 0.26)');
  cast.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = cast;
  ctx.beginPath();
  ctx.ellipse(peg.x + radius * 0.18, peg.y + radius * 0.54, radius * 1.58, radius * 1.17, 0, 0, TAU);
  ctx.fill();

  if (pulse > 0.01) {
    const aura = ctx.createRadialGradient(peg.x, peg.y, radius * 0.45, peg.x, peg.y, radius * (1.7 + pulse * 0.35));
    aura.addColorStop(0, orange ? `rgba(255, 107, 29, ${0.38 + pulse * 0.18})` : `rgba(76, 228, 255, ${0.32 + pulse * 0.18})`);
    aura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(peg.x, peg.y, radius * (1.72 + pulse * 0.35), 0, TAU);
    ctx.fill();
  }

  const outer = ctx.createLinearGradient(peg.x - radius, peg.y - radius, peg.x + radius, peg.y + radius);
  outer.addColorStop(0, '#d7f4f7');
  outer.addColorStop(0.12, '#50788b');
  outer.addColorStop(0.36, '#16354a');
  outer.addColorStop(0.68, '#06101c');
  outer.addColorStop(0.86, '#315f72');
  outer.addColorStop(1, '#91c4ce');
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(peg.x, peg.y, radius, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#020711';
  ctx.beginPath();
  ctx.arc(peg.x, peg.y, radius * 0.78, 0, TAU);
  ctx.fill();

  const body = ctx.createRadialGradient(
    peg.x - radius * 0.24,
    peg.y - radius * 0.28,
    radius * 0.03,
    peg.x + radius * 0.12,
    peg.y + radius * 0.18,
    radius * 0.76
  );
  body.addColorStop(0, hot);
  body.addColorStop(0.16, core);
  body.addColorStop(0.54, orange ? '#a72d0d' : (cyan ? '#07596f' : '#264252'));
  body.addColorStop(1, '#030914');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(peg.x, peg.y, radius * 0.68, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.82;
  ctx.lineWidth = Math.max(0.9, radius * 0.075);
  ctx.beginPath();
  ctx.arc(peg.x, peg.y, radius * 0.74, Math.PI * 1.04, Math.PI * 1.86);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Three recessed markers distinguish a powered bumper from a large peg.
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI * 0.5 + i * TAU / 3;
    const x = peg.x + Math.cos(a) * radius * 0.88;
    const y = peg.y + Math.sin(a) * radius * 0.88;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.65, radius * 0.055), 0, TAU);
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = isHit ? 5 : 2;
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

function drawChromeRing(ctx, x, y, outer, inner, active = false, enemy = false) {
  const accent = enemy ? '#ff395e' : NEON_MACHINE.cyan;
  ctx.save();
  const cast = ctx.createRadialGradient(x, y + outer * 0.24, inner * 0.3, x, y + outer * 0.24, outer * 1.42);
  cast.addColorStop(0, 'rgba(0, 0, 0, 0.44)');
  cast.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = cast;
  ctx.beginPath();
  ctx.arc(x, y + outer * 0.22, outer * 1.42, 0, TAU);
  ctx.fill();

  const metal = ctx.createLinearGradient(x, y - outer, x, y + outer);
  metal.addColorStop(0, '#3f6a82');
  metal.addColorStop(0.16, '#c3edf3');
  metal.addColorStop(0.28, '#36586d');
  metal.addColorStop(0.62, '#10293b');
  metal.addColorStop(1, '#020813');
  ctx.fillStyle = metal;
  ctx.beginPath();
  ctx.arc(x, y, outer, 0, TAU);
  ctx.fill();

  ctx.fillStyle = '#020913';
  ctx.beginPath();
  ctx.arc(x, y, inner, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = active ? accent : 'rgba(115, 225, 247, 0.48)';
  ctx.lineWidth = active ? 2.2 : 1.25;
  ctx.beginPath();
  ctx.arc(x, y, inner + 1.8, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

export function drawMachineBall(ctx, ball, radius) {
  if (!ball || radius <= 0) return;
  const enemy = ball.side === 'cpu';
  const accent = enemy ? '#ff3459' : '#75efff';
  ctx.save();
  const shadow = ctx.createRadialGradient(ball.x + 2, ball.y + radius * 0.72, 0, ball.x + 2, ball.y + radius * 0.72, radius * 1.8);
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.62)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(ball.x + 2, ball.y + radius * 0.78, radius * 1.65, radius * 1.15, 0, 0, TAU);
  ctx.fill();

  const body = ctx.createRadialGradient(
    ball.x - radius * 0.38,
    ball.y - radius * 0.44,
    radius * 0.05,
    ball.x + radius * 0.18,
    ball.y + radius * 0.2,
    radius * 1.12
  );
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.2, '#dffbff');
  body.addColorStop(0.48, '#78bfcf');
  body.addColorStop(0.74, '#214d65');
  body.addColorStop(1, '#06101d');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = enemy ? 0.9 : 0.68;
  ctx.lineWidth = Math.max(1, radius * 0.12);
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius - 0.45, Math.PI * 1.05, Math.PI * 1.86);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawMachineLauncher(ctx, x, y, angle, previewRadius, options = null) {
  const active = !!options?.active;
  const enemy = options?.side === 'cpu' || options?.enemy === true;
  const accent = enemy ? '#ff3459' : NEON_MACHINE.cyan;
  drawChromeRing(ctx, x, y, active ? 30 : 27, active ? 19 : 17, active, enemy);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle || Math.PI * 0.5);
  const nozzle = ctx.createLinearGradient(0, -7, 0, 7);
  nozzle.addColorStop(0, '#b6eef4');
  nozzle.addColorStop(0.25, '#426f86');
  nozzle.addColorStop(0.72, '#10283b');
  nozzle.addColorStop(1, '#020812');
  roundedRect(ctx, 12, -6.5, 29, 13, 6.5);
  ctx.fillStyle = nozzle;
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = active ? 0.88 : 0.52;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();

  drawMachineBall(ctx, { x, y, side: enemy ? 'cpu' : null }, previewRadius);
}

export function drawMachineCatcher(ctx, bucket, flash = 0) {
  const { x, y, width, height } = bucket;
  const intensity = Math.max(0, Math.min(1, flash || 0));
  // The collision bucket is intentionally compact, but its visible machine
  // housing is larger: a pachinko catcher should read as hardware, not a slit.
  const visualWidth = Math.max(width * 1.38, 78);
  const visualHeight = Math.max(height * 2.35, 30);
  const topY = y - visualHeight * 0.58;
  const bottomY = y + visualHeight * 0.42;
  const outerHalf = visualWidth * 0.5;
  const innerHalf = visualWidth * 0.31;

  ctx.save();
  if (intensity > 0.001) {
    const beam = ctx.createLinearGradient(x, topY - height * 3.2, x, bottomY);
    beam.addColorStop(0, 'rgba(87, 239, 255, 0)');
    beam.addColorStop(0.7, `rgba(87, 239, 255, ${0.045 + intensity * 0.09})`);
    beam.addColorStop(1, `rgba(205, 251, 255, ${0.18 + intensity * 0.22})`);
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(x - innerHalf * 1.32, topY - height * 3);
    ctx.lineTo(x + innerHalf * 1.32, topY - height * 3);
    ctx.lineTo(x + innerHalf, topY + 3);
    ctx.lineTo(x - innerHalf, topY + 3);
    ctx.closePath();
    ctx.fill();
  }

  const shadow = ctx.createRadialGradient(x, bottomY + 4, 0, x, bottomY + 4, outerHalf * 1.4);
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.68)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(x, bottomY + 4, outerHalf * 1.4, height * 0.72, 0, 0, TAU);
  ctx.fill();

  const shell = ctx.createLinearGradient(0, topY, 0, bottomY);
  shell.addColorStop(0, '#d8fbff');
  shell.addColorStop(0.08, '#62a9bd');
  shell.addColorStop(0.23, '#244d64');
  shell.addColorStop(0.52, '#0d2538');
  shell.addColorStop(0.82, '#06131f');
  shell.addColorStop(1, '#020711');
  ctx.beginPath();
  ctx.moveTo(x - outerHalf, topY);
  ctx.lineTo(x - outerHalf * 0.68, bottomY);
  ctx.quadraticCurveTo(x, bottomY + height * 0.24, x + outerHalf * 0.68, bottomY);
  ctx.lineTo(x + outerHalf, topY);
  ctx.quadraticCurveTo(x, topY + height * 0.44, x - outerHalf, topY);
  ctx.closePath();
  ctx.fillStyle = shell;
  ctx.fill();
  ctx.strokeStyle = 'rgba(108, 223, 241, 0.48)';
  ctx.lineWidth = 1.25;
  ctx.stroke();

  // Layered cheek plates give the bucket visible thickness and catch the same
  // cyan key light as the playfield rails.
  const cheek = ctx.createLinearGradient(x - outerHalf, topY, x + outerHalf, bottomY);
  cheek.addColorStop(0, 'rgba(166, 246, 255, 0.58)');
  cheek.addColorStop(0.34, 'rgba(35, 91, 112, 0.48)');
  cheek.addColorStop(1, 'rgba(1, 8, 15, 0.86)');
  ctx.fillStyle = cheek;
  ctx.beginPath();
  ctx.moveTo(x - outerHalf, topY + 1);
  ctx.lineTo(x - innerHalf * 1.05, topY + 4);
  ctx.lineTo(x - innerHalf * 0.75, bottomY - 1);
  ctx.lineTo(x - outerHalf * 0.66, bottomY - 2);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.translate(x * 2, 0);
  ctx.scale(-1, 1);
  ctx.beginPath();
  ctx.moveTo(x - outerHalf, topY + 1);
  ctx.lineTo(x - innerHalf * 1.05, topY + 4);
  ctx.lineTo(x - innerHalf * 0.75, bottomY - 1);
  ctx.lineTo(x - outerHalf * 0.66, bottomY - 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const mouth = ctx.createRadialGradient(x, topY + 1, 0, x, topY + 1, innerHalf);
  mouth.addColorStop(0, intensity > 0.001 ? '#d9fdff' : '#55eaff');
  mouth.addColorStop(0.25, `rgba(83, 235, 255, ${0.78 + intensity * 0.2})`);
  mouth.addColorStop(0.7, '#0b526d');
  mouth.addColorStop(1, '#01050b');
  ctx.fillStyle = mouth;
  ctx.beginPath();
  ctx.ellipse(x, topY + 2, innerHalf, visualHeight * 0.14, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = `rgba(183, 249, 255, ${0.72 + intensity * 0.28})`;
  ctx.lineWidth = 1.25 + intensity * 1.5;
  ctx.stroke();

  const core = ctx.createLinearGradient(x, topY + 3, x, bottomY);
  core.addColorStop(0, `rgba(188, 252, 255, ${0.18 + intensity * 0.28})`);
  core.addColorStop(0.42, `rgba(35, 184, 216, ${0.10 + intensity * 0.18})`);
  core.addColorStop(1, 'rgba(2, 10, 18, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.moveTo(x - innerHalf * 0.78, topY + 4);
  ctx.lineTo(x + innerHalf * 0.78, topY + 4);
  ctx.lineTo(x + innerHalf * 0.45, bottomY - 1);
  ctx.lineTo(x - innerHalf * 0.45, bottomY - 1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawMachineFlipper(ctx, pivotX, pivotY, angle, length, width, active = 0, selected = false) {
  ctx.save();
  ctx.translate(pivotX, pivotY);
  ctx.rotate(angle);
  const r = width * 0.5;

  const capsule = () => {
    ctx.beginPath();
    ctx.arc(0, 0, r, Math.PI * 0.5, Math.PI * 1.5);
    ctx.lineTo(length - r, -r);
    ctx.arc(length - r, 0, r, -Math.PI * 0.5, Math.PI * 0.5);
    ctx.closePath();
  };

  ctx.save();
  ctx.translate(2.4, 4.2);
  capsule();
  ctx.fillStyle = 'rgba(0, 1, 7, 0.62)';
  ctx.fill();
  ctx.restore();

  const body = ctx.createLinearGradient(0, -r, 0, r);
  body.addColorStop(0, active > 0.5 ? '#e7feff' : '#a7eaf2');
  body.addColorStop(0.18, '#376d83');
  body.addColorStop(0.56, '#10293d');
  body.addColorStop(1, '#030914');
  capsule();
  ctx.fillStyle = body;
  ctx.fill();
  ctx.strokeStyle = selected ? '#ffe35c' : 'rgba(86, 237, 255, 0.82)';
  ctx.lineWidth = selected ? 2 : 1.2;
  ctx.stroke();

  ctx.strokeStyle = 'rgba(235, 255, 255, 0.62)';
  ctx.lineWidth = Math.max(0.7, width * 0.08);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r * 0.25, -r * 0.5);
  ctx.lineTo(length - r * 1.15, -r * 0.5);
  ctx.stroke();

  drawChromeRing(ctx, 0, 0, r * 0.76, r * 0.36, active > 0.5, false);
  ctx.restore();
}
