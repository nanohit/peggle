// Graph validation and normalization.
// Run on load/sync/save/export to catch malformed data early.

import { topoOrder } from './core.js';

/**
 * Validate and normalize a graph in-place. Returns a warnings array.
 * - Ensures nodes array exists
 * - Normalizes node.type to 'normal' if missing
 * - Ensures node.children is an array
 * - Prunes children referencing non-existent node IDs
 * - Deduplicates children arrays
 * - Detects cycles (nodes unreachable by topo sort)
 *
 * @param {Object} graph - { nodes: [...] }
 * @returns {string[]} warnings (empty = clean graph)
 */
export function validateGraph(graph) {
  const warnings = [];

  if (!graph || typeof graph !== 'object') return ['Graph is null/undefined/non-object'];
  if (!Array.isArray(graph.nodes)) {
    graph.nodes = [];
    warnings.push('Missing nodes array — initialized to empty');
    return warnings;
  }

  // Guard against malformed entries (nulls/primitives/arrays) inside nodes.
  // Keep only plain object nodes so normalization below cannot throw.
  const filteredNodes = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      warnings.push(`nodes[${i}] is not an object — removed`);
      continue;
    }
    filteredNodes.push(node);
  }
  if (filteredNodes.length !== graph.nodes.length) {
    graph.nodes = filteredNodes;
  }

  // Validate and fix node IDs: must be unique finite integers
  let nextFreeId = 0;
  const seenIds = new Set();
  const idRemap = new Map(); // old -> new (used as fallback for invalid child refs)
  for (const node of graph.nodes) {
    const oldId = node.id;
    if (typeof oldId !== 'number' || !Number.isFinite(oldId) || !Number.isInteger(oldId) || seenIds.has(oldId)) {
      while (seenIds.has(nextFreeId)) nextFreeId++;
      warnings.push(`Node id=${JSON.stringify(oldId)} invalid/duplicate — reassigned to ${nextFreeId}`);
      node.id = nextFreeId;
      if (!idRemap.has(oldId)) idRemap.set(oldId, nextFreeId);
    }
    seenIds.add(node.id);
    if (node.id >= nextFreeId) nextFreeId = node.id + 1;
  }

  const validIds = new Set(graph.nodes.map(n => n.id));

  for (const node of graph.nodes) {
    // Normalize type
    if (!node.type) node.type = 'normal';

    // Ensure children array
    if (!Array.isArray(node.children)) {
      node.children = [];
      warnings.push(`Node ${node.id}: children was not an array — reset to []`);
    }

    // Remap children after ID normalization.
    // Keep already-valid refs as-is; only map invalid refs through idRemap.
    if (idRemap.size > 0) {
      let remappedCount = 0;
      node.children = node.children.map(cid => {
        if (validIds.has(cid)) return cid;
        if (idRemap.has(cid)) {
          remappedCount++;
          return idRemap.get(cid);
        }
        return cid;
      });
      if (remappedCount > 0) {
        warnings.push(`Node ${node.id}: remapped ${remappedCount} child ref(s) after id normalization`);
      }
    }

    // Prune dangling children
    const before = node.children.length;
    node.children = node.children.filter(cid => validIds.has(cid));
    if (node.children.length < before) {
      warnings.push(`Node ${node.id}: pruned ${before - node.children.length} dangling child ref(s)`);
    }

    // Remove self-edges
    if (node.children.includes(node.id)) {
      node.children = node.children.filter(c => c !== node.id);
      warnings.push(`Node ${node.id}: removed self-edge`);
    }

    // Deduplicate
    const unique = [...new Set(node.children)];
    if (unique.length < node.children.length) {
      warnings.push(`Node ${node.id}: deduplicated ${node.children.length - unique.length} child ref(s)`);
      node.children = unique;
    }
  }

  // Cycle detection
  const order = topoOrder(graph);
  if (order.length < graph.nodes.length) {
    const reachable = new Set(order);
    const cycleNodes = graph.nodes.filter(n => !reachable.has(n.id)).map(n => n.id);
    warnings.push(`Cycle detected — nodes not in topo order: [${cycleNodes.join(', ')}]`);
  }

  return warnings;
}
