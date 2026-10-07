// Hierarchical motion adapter for the cleaned Peggle Blast scene graph.
// Geometry and pivots are sourced; timing curves are documented approximations.
// All motion is relative to t=0, preserving the dumped authored pose exactly.
const TAU = Math.PI * 2;
const mod = (x, n) => ((x % n) + n) % n;
const smooth = t => (1 - Math.cos(TAU * t)) / 2;
const identity = () => [1, 0, 0, 1, 0, 0];
export function multiplyAffine(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function inverseAffine(a) {
  const d = a[0]*a[3]-a[1]*a[2];
  if (Math.abs(d) < 1e-12) throw new Error('Singular Blast transform');
  return [a[3]/d, -a[1]/d, -a[2]/d, a[0]/d,
    (a[2]*a[5]-a[3]*a[4])/d, (a[1]*a[4]-a[0]*a[5])/d];
}
export const affinePoint = (a, p) => [a[0]*p[0]+a[2]*p[1]+a[4], a[1]*p[0]+a[3]*p[1]+a[5]];
const rotation = a => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];

export function sampleSpline(path, fraction) {
  const pts = path?.points || [];
  if (!pts.length) return [0, 0];
  if (pts.length === 1) return pts[0].p;
  const segments = path.closed ? pts.length : pts.length - 1;
  const q = Math.max(0, Math.min(1, fraction)) * segments;
  const i = Math.min(segments - 1, Math.floor(q)), t = q - i;
  const at = j => pts[path.closed ? mod(j, pts.length) : Math.max(0, Math.min(pts.length-1, j))];
  const a = at(i), b = at(i+1);
  if (/Bezier/i.test(path.interpolation)) {
    const h1 = a.out || [0,0], h2 = b.in || [0,0], u = 1-t;
    return [0,1].map(k => u*u*u*a.p[k]+3*u*u*t*(a.p[k]+h1[k])+3*u*t*t*(b.p[k]+h2[k])+t*t*t*b.p[k]);
  }
  if (/Linear/i.test(path.interpolation)) return [0,1].map(k => a.p[k]*(1-t)+b.p[k]*t);
  const prev = at(i-1).p, next = at(i+2).p;
  return [0,1].map(k => 0.5*((2*a.p[k])+(-prev[k]+b.p[k])*t+
    (2*prev[k]-5*a.p[k]+4*b.p[k]-next[k])*t*t+(-prev[k]+3*a.p[k]-3*b.p[k]+next[k])*t*t*t));
}

function moverDelta(m, seconds) {
  const phase = Number(m.phase) || 0, elapsed = seconds / Math.max(0.001, Number(m.time) || 1);
  const f = mod(elapsed + phase, 1), f0 = mod(phase, 1);
  if (m.type === 'MoverRotate') return rotation(elapsed * TAU);
  if (m.type === 'MoverSnapRotate') {
    const steps = Math.floor((elapsed+phase)*360/Math.max(0.001, Math.abs(m.degreeStep))) - Math.floor(phase*360/Math.max(0.001, Math.abs(m.degreeStep)));
    return rotation(steps * m.degreeStep * Math.PI/180);
  }
  if (m.type === 'MoverConstrainedRotate') return rotation((smooth(f)-smooth(f0)) * m.degreeRange * Math.PI/180);
  if (m.type === 'MoverTranslate' || m.type === 'MoverTranslateFlip') {
    const d = smooth(f) - smooth(f0);
    return [1,0,0,1,(m.delta?.[0] || 0)*d,(m.delta?.[1] || 0)*d];
  }
  if (m.type === 'PathMover' && m.path?.points?.length) {
    const travel = u => /PING|REVERSE/i.test(m.EndOfPathAction || '') ? 1-Math.abs(2*u-1) : u;
    const p = sampleSpline(m.path, travel(f)), p0 = sampleSpline(m.path, travel(f0));
    return [1,0,0,1,p[0]-p0[0],p[1]-p0[1]];
  }
  return identity();
}

export class BlastRigAnimator {
  constructor(rig) {
    this.rig = rig;
    this.elapsed = 0;
    this.nodes = rig.nodes || [];
    this.curveMembers = new WeakSet();
    this.movingIds = new Set(rig.objects.filter(o => o.moving).map(o => o.pegId));
  }
  tick(pegs, dt, suspended = new Set()) {
    this.elapsed += dt;
    if (!this.movingIds.size) return false;
    const matrices = new Map();
    for (const n of this.nodes) {
      let local = n.rest;
      for (const m of n.movers || []) local = multiplyAffine(local, moverDelta(m, this.elapsed));
      matrices.set(n.id, multiplyAffine(matrices.get(n.parentId) || identity(), local));
    }
    const lookup = new Map(pegs.map(p => [p.id, p]));
    const tr = this.rig.transform, mirror = tr.mirrorX === true;
    for (const o of this.rig.objects) {
      if (!o.moving || suspended.has(o.pegId)) continue;
      const p = lookup.get(o.pegId), a = matrices.get(o.nodeId);
      if (!p || !a) continue;
      const pos = affinePoint(a, o.center || [0,0]);
      const x = tr.tx + pos[0]*tr.scale;
      p.x = mirror ? (tr.width || 400)-x : x;
      p.y = tr.ty - pos[1]*tr.scale;
      const sourceAngle = Math.atan2(a[1], a[0]) + (o.angleOffset || 0);
      p.angle = mirror ? sourceAngle : -sourceAngle;
      // Generated Bezier members carry their baked ribbon in node-local space.
      // Transform every sample and normal from rest, never incrementally: this
      // keeps the shared contour intact after rotation and member removal.
      if (Array.isArray(o.curveSlices)) {
        if (!this.curveMembers.has(p)) {
          p.curveSlices = o.curveSlices.map(() => ({}));
          this.curveMembers.add(p);
        }
        for (let i = 0; i < o.curveSlices.length; i++) {
          const s = o.curveSlices[i], point = affinePoint(a, [s.x, s.y]);
          const nx = a[0]*s.nx+a[2]*s.ny, ny = a[1]*s.nx+a[3]*s.ny;
          const length = Math.hypot(nx, ny) || 1;
          p.curveSlices[i] ||= {};
          Object.assign(p.curveSlices[i], {
            x: mirror ? (tr.width || 400)-(tr.tx+point[0]*tr.scale) : tr.tx+point[0]*tr.scale,
            y: tr.ty-point[1]*tr.scale, nx: (mirror ? -nx : nx)/length, ny: -ny/length
          });
        }
      }
      // Parent scale can change the effective collider as children rotate.
      // Match the source sphere's max-axis scale and each box axis separately.
      if (o.collider) {
        const sx=Math.hypot(a[0],a[1]),sy=Math.hypot(a[2],a[3]);
        if(o.collider.shape==='brick') {
          p.width=o.collider.width*sx*tr.scale;
          p.height=o.collider.height*sy*tr.scale;
        } else {
          const radiusScale=o.collider.radius*Math.max(sx,sy)/0.195;
          if(p.type==='bumper')p.bumperScale=radiusScale;
          else p.radiusScale=radiusScale;
        }
      }
    }
    return true;
  }
}
