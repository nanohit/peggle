// Graph core — pure functions for DAG operations.
// No DOM, no side effects. Safe for both browser and Node (Vercel serverless).

/**
 * Build a Map of nodeId → node from graph.nodes array.
 */
export function buildNodeMap(graph) {
  if (!graph?.nodes?.length) return new Map();
  return new Map(graph.nodes.map(n => [n.id, n]));
}

/**
 * Build parent map: nodeId → [parentNodeIds].
 * Only includes edges where both endpoints exist in the graph.
 */
export function buildParentMap(graph) {
  const pm = new Map();
  if (!graph?.nodes) return pm;
  const ids = new Set(graph.nodes.map(n => n.id));
  for (const n of graph.nodes) {
    for (const cid of (n.children || [])) {
      if (!ids.has(cid)) continue;
      if (!pm.has(cid)) pm.set(cid, []);
      pm.get(cid).push(n.id);
    }
  }
  return pm;
}

/**
 * Topological sort via Kahn's algorithm.
 * Returns array of node IDs in play order.
 * Nodes in cycles are omitted (logged if warn=true).
 */
export function topoOrder(graph, warn = false) {
  if (!graph?.nodes?.length) return [];
  const nodeMap = buildNodeMap(graph);

  const inDeg = new Map();
  for (const n of graph.nodes) inDeg.set(n.id, 0);
  for (const n of graph.nodes) {
    for (const c of (n.children || [])) {
      if (inDeg.has(c)) inDeg.set(c, inDeg.get(c) + 1);
    }
  }

  const queue = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  const order = [];
  while (queue.length) {
    const nid = queue.shift();
    order.push(nid);
    const node = nodeMap.get(nid);
    if (!node) continue;
    for (const cid of (node.children || [])) {
      if (!inDeg.has(cid)) continue;
      const next = inDeg.get(cid) - 1;
      inDeg.set(cid, next);
      if (next === 0) queue.push(cid);
    }
  }

  if (warn && order.length < graph.nodes.length) {
    console.warn('[graph] Cycle detected — %d node(s) unreachable',
      graph.nodes.length - order.length);
  }
  return order;
}

/**
 * Check if adding edge from→to would create a cycle
 * (i.e., 'to' can already reach 'from' via existing edges).
 */
export function wouldCycle(graph, fromId, toId) {
  const nodeMap = buildNodeMap(graph);
  const visited = new Set();
  const stack = [toId];
  while (stack.length) {
    const nid = stack.pop();
    if (nid === fromId) return true;
    if (visited.has(nid)) continue;
    visited.add(nid);
    const node = nodeMap.get(nid);
    if (node) {
      for (const c of (node.children || [])) stack.push(c);
    }
  }
  return false;
}

/**
 * Get next available node ID for a graph.
 */
export function nextNodeId(graph) {
  if (!graph?.nodes?.length) return 0;
  let max = -1;
  for (const n of graph.nodes) {
    if (typeof n.id === 'number' && Number.isFinite(n.id) && n.id > max) max = n.id;
  }
  return max + 1;
}

/**
 * Create a linear graph from a level-names array (editor format).
 */
export function graphFromLinear(levelNames) {
  if (!levelNames?.length) return { nodes: [] };
  return {
    nodes: levelNames.map((name, i) => ({
      id: i,
      levelName: name,
      children: i < levelNames.length - 1 ? [i + 1] : [],
      type: 'normal'
    }))
  };
}

/**
 * Create a linear graph from a levels array (player format, with levelIndex).
 */
export function graphFromLevels(levels) {
  if (!levels?.length) return { nodes: [] };
  return {
    nodes: levels.map((_, i) => ({
      id: i,
      levelIndex: i,
      children: i < levels.length - 1 ? [i + 1] : [],
      type: 'normal'
    }))
  };
}

/**
 * Resolve a graph node's level name, supporting both levelName and levelIndex formats.
 * @param {Object} node - Graph node
 * @param {string[]} levelNames - Fallback array for levelIndex lookup
 * @returns {string} Level name or empty string
 */
export function resolveNodeLevelName(node, levelNames) {
  if (!node) return '';
  if (typeof node.levelName === 'string' && node.levelName) return node.levelName;
  if (typeof node.levelIndex === 'number' && Number.isInteger(node.levelIndex) && node.levelIndex >= 0) {
    return (levelNames && levelNames[node.levelIndex]) || '';
  }
  return '';
}

/**
 * Build nodeId → levelIndex map from graph nodes + levels array.
 * Handles both levelIndex and levelName formats.
 */
export function buildLevelIndexMap(graph, levels) {
  const map = new Map();
  if (!graph?.nodes || !levels) return map;
  for (const n of graph.nodes) {
    if (typeof n.levelIndex === 'number' && Number.isInteger(n.levelIndex) &&
        n.levelIndex >= 0 && n.levelIndex < levels.length) {
      map.set(n.id, n.levelIndex);
    } else if (n.levelName) {
      const idx = levels.findIndex(l => {
        const safe = (l.name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
        return safe === n.levelName || l.name === n.levelName;
      });
      if (idx >= 0) map.set(n.id, idx);
    }
  }
  return map;
}

/**
 * Derive levelNames array from graph in play order.
 * Supports both levelName and levelIndex node formats.
 */
export function syncLevelNames(graph, fallbackLevelNames = []) {
  const order = topoOrder(graph);
  const nodeMap = buildNodeMap(graph);
  return order
    .map(id => resolveNodeLevelName(nodeMap.get(id), fallbackLevelNames))
    .filter(Boolean);
}
