// Progression engine — pure state machine for campaign graph traversal.
// No DOM, no side effects. Testable in isolation.

/**
 * Check if a node is unlocked (all its parents are in the completed set).
 */
export function isUnlocked(nodeId, parentMap, completedNodes) {
  const parents = parentMap.get(nodeId) || [];
  return parents.length === 0 || parents.every(p => completedNodes.has(p));
}

/**
 * Find the first unlocked, incomplete node in topo order.
 * Returns nodeId or null if everything is done.
 */
export function findNextNode(playOrder, parentMap, completedNodes) {
  for (const nid of playOrder) {
    if (completedNodes.has(nid)) continue;
    if (isUnlocked(nid, parentMap, completedNodes)) return nid;
  }
  return null;
}

/**
 * Determine what happens after winning the current node.
 *
 * @param {Object} graph
 * @param {number} currentNodeId
 * @param {Set} completedNodes - MUST already include currentNodeId (caller marks it before calling)
 * @param {Map} nodeMap
 * @param {Map} parentMap
 * @param {Map} levelIndexMap - nodeId → levelIndex (nodes without a valid mapping are filtered out)
 * @param {number[]} playOrder
 *
 * @returns {{ action: 'advance', nodeId: number }
 *         | { action: 'choose', choices: number[] }
 *         | { action: 'complete' }}
 *
 * 'advance'  — single unambiguous next node, auto-jump
 * 'choose'   — multiple unlocked children, player picks
 * 'complete' — no more reachable nodes, campaign done
 */
export function resolveWin(graph, currentNodeId, completedNodes, nodeMap, parentMap, levelIndexMap, playOrder) {
  const currentNode = nodeMap.get(currentNodeId);
  const children = (currentNode?.children || []).filter(c =>
    nodeMap.has(c) && levelIndexMap.has(c)
  );

  // Filter to children that are actually unlocked
  const unlocked = children.filter(cid => isUnlocked(cid, parentMap, completedNodes));

  if (unlocked.length === 1) {
    return { action: 'advance', nodeId: unlocked[0] };
  }
  if (unlocked.length > 1) {
    return { action: 'choose', choices: unlocked };
  }

  // No unlocked children — find next available from any branch
  const next = findNextNode(playOrder, parentMap, completedNodes);
  if (next) {
    return { action: 'advance', nodeId: next };
  }

  return { action: 'complete' };
}

/**
 * Get the node state for display purposes.
 *
 * @returns {'completed' | 'current' | 'next' | 'locked' | 'secret'}
 */
export function getNodeState(nodeId, node, currentNodeId, completedNodes, parentMap) {
  if (!node) return 'locked';
  if (nodeId === currentNodeId) return 'current';
  if (completedNodes.has(nodeId)) return 'completed';

  const unlocked = isUnlocked(nodeId, parentMap, completedNodes);
  if (node.type === 'secret') return unlocked ? 'next' : 'secret';
  return unlocked ? 'next' : 'locked';
}

/**
 * Migrate old linear progress format to graph-based format.
 *
 * @param {Object} saved - { levelIndex: number } (old) or { completedNodeIds, currentNodeId } (new)
 * @param {number[]} playOrder
 * @param {Map} nodeMap
 * @returns {{ completedNodes: Set, currentNodeId: number|null }}
 */
export function migrateProgress(saved, playOrder, nodeMap) {
  if (!saved) return { completedNodes: new Set(), currentNodeId: playOrder[0] ?? null };

  if (Array.isArray(saved.completedNodeIds)) {
    const completedNodes = new Set(saved.completedNodeIds);
    const currentNodeId = (saved.currentNodeId != null && nodeMap.has(saved.currentNodeId))
      ? saved.currentNodeId
      : null;
    return { completedNodes, currentNodeId };
  }

  if (typeof saved.levelIndex === 'number') {
    const completedNodes = new Set();
    for (let i = 0; i < saved.levelIndex && i < playOrder.length; i++) {
      completedNodes.add(playOrder[i]);
    }
    const currentNodeId = saved.levelIndex < playOrder.length
      ? playOrder[saved.levelIndex]
      : null;
    return { completedNodes, currentNodeId };
  }

  return { completedNodes: new Set(), currentNodeId: playOrder[0] ?? null };
}
