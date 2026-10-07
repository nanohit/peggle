import {randomFrom} from '../destruction/grammar.js';

export const MODES = Object.freeze([
  {id: 'auto', name: 'Свободная грамматика'},
  {id: 'compose', name: 'Составная цепочка'},
  {id: 'cascade', name: 'Последовательный пересып'},
  {id: 'merge', name: 'Слияние потоков'},
  {id: 'parallel', name: 'Два независимых пути'},
  {id: 'portal', name: 'Перенос через портал'},
  {id: 'magnet', name: 'Магнитный накопитель'},
  {id: 'cross', name: 'Перекрёстные пути'}
]);
const round = n => Math.round(n * 1e6) / 1e6;
const pick = (rng, values) => values[Math.floor(rng() * values.length)];

// This plans a directed transfer network before drawing anything. Serial, merge,
// parallel and crossed networks have different action dependencies, not just
// different arrangements of the same five construction templates.
export function planIntents(seed, mode = 'auto') {
  const rng = randomFrom(seed + ':plan');
  if (!MODES.some(m => m.id === mode)) throw Error('Unknown intent mode');
  if (mode === 'auto') mode = pick(randomFrom(seed+':mode'), MODES.slice(1).map(m => m.id));
  const mirror = rng() < .5 ? -1 : 1;
  const topology = mode === 'compose' ? pick(rng,['single','parallel','merge']) : mode;
  const parallel = topology === 'parallel' || topology === 'cross';
  const sources = (parallel || topology === 'merge') ? 2 : 1;
  const depth = (mode === 'cascade' || (mode === 'compose' && topology !== 'merge')) ? pick(rng, [1, 2]) : 1;
  const transportKind = mode === 'compose' && topology !== 'merge' ? pick(rng,['none','portal','magnet']) : mode;
  const magnet = transportKind === 'magnet' && !parallel;
  const portal = transportKind === 'portal' || mode === 'cross';
  const crossed = mode === 'cross' || (mode === 'compose' && parallel && portal && rng() < .5);
  const radius = parallel ? 48 + rng() * 5 : 58 + rng() * 10;
  const firstMouth = magnet ? 350 + rng() * 10 : 284 + rng() * 20;
  const receiver = parallel ? [106 + rng() * 9, 285 + rng() * 9]
    : [200 + mirror * (depth === 2 ? -18 : (rng() - .5) * 24)];
  return {mode, sources, depth, parallel, crossed, mirror, radius, firstMouth, receiver,
    sourceKind: parallel ? ['hopper', 'hopper'] : Array.from({length: sources}, () => pick(rng, ['ramp', 'hopper'])),
    receiverKind: Array.from({length: parallel ? 2 * depth : depth}, () => pick(rng, ['tilt', 'break'])),
    sourceY: 158 + rng() * 18, count: parallel ? 4 : 4 + Math.floor(rng() * 3),
    slope: .14 + rng() * .1, portal, magnet};
}

export function generateIntentLevel(seed = 'intent-001', mode = 'auto') {
  const plan = planIntents(seed, mode), rng = randomFrom(seed + ':geometry');
  const id = 'des1-' + plan.mode + '-' + String(seed).replace(/[^a-zA-Z0-9_-]/g, '').slice(0,48);
  const pegs = [], groups = [], nodes = [], edges = [], cargo = [];
  let serial = 0;
  const peg = (x, y, type = 'blue', extra = {}) => {
    const p = {id: id + ':p' + (++serial), x: round(x), y: round(y), type, shape: 'circle', angle: 0,
      destructionStatic: false, destructionPhysicsOnHit: false, ...extra};
    pegs.push(p); return p;
  };
  const brick = (x, y, width, height, angle = 0, type = 'blue', extra = {}) =>
    peg(x, y, type, {shape: 'brick', width: round(width), height: round(height), angle: round(angle), brickBaseRadius: 8.5, ...extra});
  const asleep = {destructionPhysicsOnHit: true, destructionPhysicsOnHitBallOnly: true};
  const staticBody = {destructionStatic: true};
  const label = (p, node, role) => {
    p.intentNode = node.id; p.constructionAssembly = node.id; p.constructionRole = role;
    node.pegs.push(p.id); return p;
  };

  function source(index, cx, direction) {
    const node = {id: id + ':source' + index, kind: 'source', pegs: [], cargoIds: [], triggerIds: [],
      requiredCount: 2, prerequisites: [], instruction: 'Освободи груз: попади в оранжевый затвор.'};
    const kind = plan.sourceKind[index], width = plan.sources === 2 ? 80 : 108;
    const angle = kind === 'ramp' ? direction * plan.slope : 0;
    const cy = plan.sourceY + (index ? (rng() - .5) * 14 : 0);
    const c = Math.cos(angle), s = Math.sin(angle);
    let floor, gate;
    if (kind === 'ramp') {
      floor = label(brick(cx, cy, width, 8, angle, 'obstacle', staticBody), node, 'slope');
      const gx = cx + direction * (width / 2 - 3) * c + s * 12.5;
      const gy = cy + direction * (width / 2 - 3) * s - c * 12.5;
      gate = label(peg(gx, gy, 'orange', asleep), node, 'release-gate');
    } else {
      const groupId=node.id+':trapdoor';
      groups.push({id:groupId,name:'Створка с вынесенным затвором',pattern:'intent-source',destructionBody:true});
      floor = label(brick(cx, cy, width, 8, 0, 'obstacle', {...asleep,groupId,
        destructionHinge: {pivotFraction: direction > 0 ? .15 : .85,
          minAngle: direction > 0 ? 0 : -1.32, maxAngle: direction > 0 ? 1.32 : .03,
          damping: .997, stopBounce: .02}}), node, 'trapdoor');
      gate = label(peg(cx + direction * (width/2+12),cy-5,'orange',{...asleep,groupId}),node,'release-handle');
    }
    node.triggerIds = [gate.id]; node.releaseY = cy + 26;
    const count = Math.min(plan.count, kind === 'ramp' || width === 80 ? 4 : 5);
    for (let k = 0; k < count; k++) {
      const offset = kind === 'ramp' ? direction * (width / 2 - 22 - k * 17.8) : (k - (count - 1) / 2) * 17.8;
      const p = label(peg(cx + offset * c + s * 12.5, cy + offset * s - c * 12.5, 'obstacle'), node, 'cargo');
      node.cargoIds.push(p.id); cargo.push({id: p.id, source: node.id});
    }
    node.geometry = {kind, x: cx, y: cy, direction, width, angle, outletX: kind === 'ramp' ? gate.x : cx - direction * width * .18};
    nodes.push(node); return node;
  }

  function cup(index, cx, mouth, radius, direction, upstream, kind) {
    const node = {id: id + ':cup' + index, kind: 'cup', pegs: [], cargoIds: upstream.flatMap(n => n.cargoIds),
      triggerIds: [], prerequisites: upstream.map(n => n.id), requiredCount: upstream.length * 2,
      perSource: upstream.length > 1 ? 2 : null, holdSeconds: .3,
      instruction: upstream.length > 1 ? 'Собери груз из обеих веток в синей чаше.' : 'Дай грузу собраться в синей чаше.',
      releaseInstruction: kind === 'tilt' ? 'Груз собран. Ударь по синему ободу и опрокинь чашу.' : 'Груз собран. Разбей нижнюю часть синей чаши.'};
    if (upstream.length > 1) {
      node.paths = upstream.map(n => ({stage:n.id,cargoIds:n.cargoIds}));
      node.prerequisites = [];
    }
    const cy = mouth - radius * .5, a0 = Math.PI / 6, span = Math.PI * 2 / 3;
    const groupId = node.id + ':vessel';
    const segments = 7 + Math.floor(rng() * 3);
    if (kind === 'tilt') groups.push({id: groupId, name: 'Опрокидываемая чаша', pattern: 'intent-vessel', destructionBody: true});
    for (let k = 0; k < segments; k++) {
      const a = a0 + span * (k + .5) / segments, half = span / segments / 2;
      const slices = Array.from({length: 7}, (_, j) => {
        const t = a - half + j * half * 2 / 6;
        return {x: round(cx + radius * Math.cos(t)), y: round(cy + radius * Math.sin(t)), nx: Math.cos(t), ny: Math.sin(t)};
      });
      const p = label(brick(cx + radius * Math.cos(a), cy + radius * Math.sin(a), radius * span / segments, 7.6, a + Math.PI / 2, 'blue', {
        curveSlices: slices, ...(kind === 'tilt' ? {...asleep, groupId} : staticBody)
      }), node, 'receiver-wall');
      node.triggerIds.push(p.id);
    }
    if (kind === 'tilt') {
      const hingeX = cx - direction * radius * Math.cos(a0);
      const handle = label(brick(hingeX, mouth, 24, 7.6, 0, 'blue', {...asleep, groupId,
        destructionHinge: {pivotFraction: .5, minAngle: direction > 0 ? 0 : -1.32,
          maxAngle: direction > 0 ? 1.32 : .03, damping: .997, stopBounce: .02}}), node, 'pour-handle');
      node.triggerIds.push(handle.id);
    }
    node.region = {minX: cx - radius * .78, maxX: cx + radius * .78, minY: mouth - 12, maxY: cy + radius - 7};
    node.geometry = {kind, x: cx, mouthY: mouth, radius, direction};
    nodes.push(node); for (const n of upstream) edges.push({from: n.id, to: node.id, action: 'collect-then-release'});
    return node;
  }

  function transport(sourceNode, targetX, targetMouth, crossIndex) {
    const node = {id: id + ':portal' + crossIndex, kind: 'portal', pegs: [], cargoIds: sourceNode.cargoIds,
      prerequisites: [sourceNode.id], requiredCount: 2, instruction: 'Проведи груз через синий портал.'};
    const g = sourceNode.geometry;
    const entryX = g.outletX + g.direction * (g.kind === 'ramp' ? 29 : 20);
    const entry = label(peg(entryX, g.y + 64, 'portalBlue', {...staticBody, portalScale: 4,
      portalOneWay: true, portalOneWayFlip: false}), node, 'transport-entry');
    const exit = label(peg(targetX, targetMouth - 48, 'portalOrange', {...staticBody, portalScale: 4,
      portalOneWay: true, portalOneWayFlip: true}), node, 'transport-exit');
    entry.portalTargetId = exit.id; exit.portalTargetId = entry.id;
    node.entryId = entry.id; node.exitId = exit.id;
    nodes.push(node); edges.push({from: sourceNode.id, to: node.id, action: 'transport-cargo'});
    return node;
  }

  function magnet(sourceNode, cx, mouth) {
    const node = {id: id + ':magnet', kind: 'magnet', pegs: [], cargoIds: sourceNode.cargoIds,
      prerequisites: [sourceNode.id], requiredCount: 2, holdSeconds: .35,
      instruction: 'Дай магниту собрать груз.', releaseInstruction: 'Груз на магните. Выключи магнит прямым попаданием.'};
    const g = sourceNode.geometry, x = g.outletX + g.direction * 27, y = g.y + 78;
    const field = label(peg(x, y, 'bombMagnet', {...staticBody, magnetRadius: 52, magnetStrength: .9,
      magnetMode: 'attract', magnetBlast: false, magnetHittable: true, magnetKnockout: true}), node, 'hold-and-release-field');
    node.triggerIds = [field.id]; node.region = {x, y, radius: 34};
    nodes.push(node); edges.push({from: sourceNode.id, to: node.id, action: 'hold-with-force-field'});
    return node;
  }

  const parallel = plan.parallel;
  const sourceXs = plan.sources === 2 ? (parallel ? [83, 317] : plan.sourceKind.map((kind,i) =>
    kind === 'hopper' ? plan.receiver[0] + (i ? 66 : -66) : (i ? 307 : 93)))
    : [plan.sourceKind[0] === 'hopper' && !plan.portal && !plan.magnet
      ? plan.receiver[0] - plan.mirror * 10 : 200 - plan.mirror * 96];
  const sources = sourceXs.map((x, i) => source(i, x, plan.sources === 2 ? (i ? -1 : 1) : plan.mirror));
  let receivers = [];
  if (parallel) {
    for (let i = 0; i < 2; i++) {
      const target = plan.crossed ? 1 - i : i;
      const upstream = plan.portal ? transport(sources[i], plan.receiver[target], plan.firstMouth, i) : sources[i];
      const direction = target ? -1 : 1;
      let receiver = cup(i * plan.depth, plan.receiver[target], plan.firstMouth, plan.radius, direction, [upstream], plan.receiverKind[i * plan.depth]);
      if (plan.depth === 2) receiver = cup(i * plan.depth + 1, plan.receiver[target] + direction * (26 + rng() * 10),
        444 + rng() * 8, plan.radius, -direction, [receiver], plan.receiverKind[i * plan.depth + 1]);
      receivers.push(receiver);
    }
  } else {
    let upstream = sources;
    if (plan.portal) upstream = [transport(sources[0], plan.receiver[0], plan.firstMouth, 0)];
    if (plan.magnet) upstream = [magnet(sources[0], plan.receiver[0], plan.firstMouth)];
    const receiverX = plan.magnet ? upstream[0].region.x : plan.receiver[0];
    let receiver = cup(0, receiverX, plan.firstMouth, plan.radius, plan.mirror, upstream, plan.receiverKind[0]);
    if (plan.depth === 2) receiver = cup(1, receiverX + plan.mirror * (32 + rng() * 14),
      444 + rng() * 8, plan.radius - 3, -plan.mirror, [receiver], plan.receiverKind[1]);
    receivers = [receiver];
  }
  const outlet = {id: id + ':outlet', kind: 'outlet', pegs: [], cargoIds: cargo.map(c => c.id),
    requiredCount: plan.sources * 2, perSource: plan.sources > 1 ? 2 : null,
    prerequisites: receivers.map(n => n.id), releaseY: 566,
    instruction: 'Освободи собранный груз и доведи его до нижнего выхода.'};
  // Parallel cargo needs its own receiver passport, not the other branch's.
  if (parallel) outlet.prerequisites = [];
  outlet.paths = receivers.map(n => ({stage: n.id, cargoIds: n.cargoIds}));
  nodes.push(outlet); for (const receiver of receivers) edges.push({from: receiver.id, to: outlet.id, action: 'deliver'});
  const explanation = plan.sources === 2 && !parallel ? 'Два затвора → общая чаша → выпуск груза.'
    : plan.crossed ? 'Два потока пересекаются через порталы → разные чаши → общий выход.'
    : plan.magnet ? 'Затвор → магнитный накопитель → выключение поля → '+(plan.depth === 2 ? 'две чаши' : 'чаша')+' → выпуск.'
    : plan.portal ? 'Затвор → перенос груза порталом → '+(plan.depth === 2 ? 'две чаши' : 'чаша')+' → выпуск.'
    : plan.depth === 2 ? 'Освободи груз, собери его в первой чаше, пересыпь во вторую и выпусти.'
    : parallel ? 'Две ветки: освободить, собрать и выпустить груз из каждой.' : 'Затвор → сбор груза в чаше → опрокидывание или разрушение обода.';
  return {version: 1, id, name: MODES.find(m => m.id === plan.mode).name + ' · ' + seed,
    pegRadius: 8.5, ballCount: plan.depth === 2 ? 14 : 10, bucketEnabled: true, hitPegTimedClearEnabled: true, hitPegClearDelayMs: 650,
    pegs, groups, bezierCurves: {}, flippers: null,
    destruction: {enabled: true, gravityX: 0, gravityY: .115, damping: .994, restitution: .18, friction: .72,
      surfaceGrip: .18, dynamicPegBallBounce: .45, maxSpeed: 14, sleepSpeed: .055, sleepFrames: 18,
      bombImpulse: 12, stuckPileClearDelayMs: 220},
    metadata: {authorNotes: explanation, generator: {name: 'destruction_intents', version: '1.0.0', seed,
      mode: plan.mode, plan}, intentGraph: {version: 1, required: true, nodes, edges, cargo}}
  };
}
