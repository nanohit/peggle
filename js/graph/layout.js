// Shared tree layout — computes row/col positions for graph nodes.
// Used by both the player level-map and the editor campaign tree.
// No DOM dependencies.

import { buildNodeMap, buildParentMap } from './core.js';

/**
 * Compute layout positions for a graph's nodes.
 *
 * @param {Object} graph - { nodes: [{id, children, ...}] }
 * @returns {{ depthMap: Map<id,number>, colMap: Map<id,number>, roots: Object[], parentMap: Map }}
 *          or null if graph is empty / all-cyclic.
 */
export function computeLayout(graph) {
  const nodes = graph?.nodes;
  if (!nodes?.length) return null;

  const nodeMap = buildNodeMap(graph);
  const parentMap = buildParentMap(graph);

  // Roots: nodes with no parents
  const roots = nodes.filter(n => {
    const p = parentMap.get(n.id);
    return !p || p.length === 0;
  });
  if (roots.length === 0) return null;

  // BFS depths (max depth for merge nodes, clamped to prevent cycle hangs)
  const depthMap = new Map();
  const bfsQ = roots.map(r => [r.id, 0]);
  const maxDepth = nodes.length;
  while (bfsQ.length) {
    const [nid, d] = bfsQ.shift();
    if (d > maxDepth) continue;
    const prev = depthMap.get(nid);
    if (prev !== undefined && d <= prev) continue;
    depthMap.set(nid, d);
    const node = nodeMap.get(nid);
    if (node) {
      for (const cid of (node.children || [])) {
        if (!nodeMap.has(cid)) continue;
        if (d + 1 > maxDepth) continue;
        bfsQ.push([cid, d + 1]);
      }
    }
  }

  // Column assignment (recursive subdivision, visited-guarded)
  const colMap = new Map();
  const colVisited = new Set();

  const assignCol = (nid, col) => {
    if (colVisited.has(nid)) return;
    colVisited.add(nid);
    colMap.set(nid, col);

    const node = nodeMap.get(nid);
    if (!node) return;
    const ch = node.children || [];
    if (ch.length === 1) {
      assignCol(ch[0], col);
    } else if (ch.length > 1) {
      const sp = ch.length - 1;
      for (let i = 0; i < ch.length; i++) {
        assignCol(ch[i], col + (i - sp / 2));
      }
    }
  };

  if (roots.length === 1) {
    assignCol(roots[0].id, 0);
  } else {
    for (let i = 0; i < roots.length; i++) {
      assignCol(roots[i].id, i * 2);
    }
  }

  // Merge node re-centering (visited-guarded)
  for (const [nid, pids] of parentMap) {
    if (pids.length > 1 && pids.every(p => colMap.has(p))) {
      const avg = pids.reduce((s, p) => s + colMap.get(p), 0) / pids.length;
      const visited = new Set();
      const reassign = (id, c) => {
        if (visited.has(id)) return;
        visited.add(id);
        colMap.set(id, c);
        const nd = nodeMap.get(id);
        if (!nd) return;
        const ch = nd.children || [];
        if (ch.length === 1) reassign(ch[0], c);
        else if (ch.length > 1) {
          const sp = ch.length - 1;
          for (let i = 0; i < ch.length; i++) reassign(ch[i], c + (i - sp / 2));
        }
      };
      reassign(nid, avg);
    }
  }

  return { depthMap, colMap, roots, parentMap, nodeMap };
}

/**
 * Convert layout (row/col) into pixel positions.
 *
 * @param {Object} layout - from computeLayout()
 * @param {Object[]} nodes - graph.nodes
 * @param {Object} metrics - { rowH, colW, padX, padY }
 *   padX = horizontal margin (centering + width), padY = top offset for first row.
 *   For convenience, `pad` can be used instead to set both padX and padY to the same value.
 * @returns {{ positions: Map<id, {x,y,row,col}>, width: number, height: number }}
 */
export function toPixelPositions(layout, nodes, metrics) {
  const { depthMap, colMap } = layout;
  const { rowH, colW } = metrics;
  const padX = metrics.padX ?? metrics.pad ?? 0;
  const padY = metrics.padY ?? metrics.pad ?? 0;

  const cols = [...colMap.values()];
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);
  const colRange = maxCol - minCol;
  const graphW = colRange * colW + padX * 2;
  const width = Math.max(200, graphW);
  const centerX = (width / 2);
  const midCol = (minCol + maxCol) / 2;

  const positions = new Map();
  let maxY = 0;

  for (const n of nodes) {
    const d = depthMap.get(n.id) || 0;
    const c = colMap.get(n.id) || 0;
    const x = centerX + (c - midCol) * colW;
    const y = padY + d * rowH;
    positions.set(n.id, { x, y, row: d, col: c });
    if (y > maxY) maxY = y;
  }

  return {
    positions,
    width,
    height: maxY + padY
  };
}
