/**
 * Liquid-State Engine — Ultra-Lite DOM Architecture
 *
 * Pure HTML/JS/CSS. No Wasm, no canvas, no WebGL.
 *
 * Interactions:
 *   Double-click workspace → create a new node
 *   Click "+ New Node" button → create a new node
 *   Drag data boxes anywhere on screen
 *   Drag one box onto another → AI merge (combine keywords)
 *   Double-click a data box → AI fracture (DeepSeek decomposition)
 *
 * Semantic Memory: all node creation/fracture/merge events feed into
 * a persistent knowledge graph used to enrich AI prompts with context.
 */

import { SemanticMemory } from './ai-memory.js';
import { addParentRelation, addMergeRelation, toggleVisibility } from './relations-viz.js';

// ============================================================
// Workspace
// ============================================================
const workspace = document.getElementById('workspace');
const createBtn = document.getElementById('create-btn');

// Global semantic memory (survives page reloads via localStorage)
const memory = new SemanticMemory();

let nodeIdCounter = 0;
/** @type {Map<number, HTMLElement>} */
const nodes = new Map();

// ============================================================
// Node Creation
// ============================================================

function createNode(text, x, y) {
  const id = ++nodeIdCounter;
  const label = (text || '').trim();

  const el = document.createElement('div');
  el.className = 'data-box';
  el.textContent = label || '…';
  el.dataset.id = String(id);
  el.style.left = x + 'px';
  el.style.top = y + 'px';

  workspace.appendChild(el);
  nodes.set(id, el);

  if (label) {
    memory.recordCreate(label);
    triggerEnrich(id, label);
  }

  return id;
}

// ============================================================
// Input Dialog
// ============================================================

function showInputDialog(x, y) {
  const overlay = document.createElement('div');
  overlay.className = 'input-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'input-dialog';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Enter a keyword (e.g., Rainbow, Car, Blockchain)...';
  input.autofocus = true;

  const actions = document.createElement('div');
  actions.className = 'actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';

  const okBtn = document.createElement('button');
  okBtn.className = 'primary';
  okBtn.textContent = 'Create';

  const close = () => overlay.remove();

  cancelBtn.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  okBtn.onclick = () => {
    const text = input.value.trim();
    close();
    if (text) createNode(text, x, y);
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') close();
  };

  actions.append(cancelBtn, okBtn);
  dialog.append(input, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  requestAnimationFrame(() => input.focus());
}

// ============================================================
// AI Enrichment (fracture prep)
// ============================================================

async function triggerEnrich(id, keyword) {
  const el = nodes.get(id);
  if (!el) return;
  el.classList.add('enriching');

  try {
    const { enrichPayload } = await import('./ai-enrich.js');
    const enriched = await enrichPayload({ type: 'text', value: keyword, label: keyword }, id);

    // Also call /api/enrich directly to get memory-augmented context
    const contextStr = memory.getEnrichContext(keyword);
    if (contextStr) {
      try {
        const ctxRes = await fetch('/api/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword, context: contextStr }),
        });
        if (ctxRes.ok) {
          const ctxData = await ctxRes.json();
          if (ctxData.components?.length > 0) {
            enriched.value = ctxData.components;
          }
        }
      } catch { /* fall back to original enrichment */ }
    }

    if (enriched.type === 'array' && Array.isArray(enriched.value) && enriched.value.length > 0) {
      el.classList.add('enriched');
      el.dataset.components = JSON.stringify(enriched.value);
    }
    // Default confidence for non-merged (fracture/enrich) nodes
    if (!el.dataset.confidence) {
      el.dataset.confidence = '0.7';
      el.style.setProperty('--conf-width', '70%');
    }
  } catch {
    // enrichment failed — node stays as plain text
  } finally {
    el.classList.remove('enriching');
  }
}

// ============================================================
// AI Merge (drag A onto B → combine into one result)
// ============================================================

async function mergeNodes(draggedId, targetId) {
  const draggedEl = nodes.get(draggedId);
  const targetEl = nodes.get(targetId);
  if (!draggedEl || !targetEl) return;

  const keywordA = draggedEl.textContent?.trim();
  const keywordB = targetEl.textContent?.trim();
  if (!keywordA || !keywordB) return;

  // Midpoint for the result
  const ax = parseFloat(draggedEl.style.left) || 0;
  const ay = parseFloat(draggedEl.style.top) || 0;
  const bx = parseFloat(targetEl.style.left) || 0;
  const by = parseFloat(targetEl.style.top) || 0;
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;

  // Immediately mark both boxes as merging with visual feedback
  draggedEl.classList.remove('merge-target');
  targetEl.classList.remove('merge-target');
  draggedEl.classList.add('merging');
  targetEl.classList.add('merging');
  // Show "Merging..." indicator
  const origTextA = draggedEl.textContent;
  const origTextB = targetEl.textContent;
  draggedEl.textContent = '⚗️ Merging...';
  targetEl.textContent = '⚗️ Merging...';

  try {
    // Build memory context for both keywords
    const ctxA = memory.getEnrichContext(keywordA);
    const ctxB = memory.getEnrichContext(keywordB);
    const memoryContext = [ctxA, ctxB].filter(Boolean).join(' | ');

    const response = await fetch('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'merge',
        keywords: [keywordA, keywordB],
        context: memoryContext || undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error ${response.status}`);
    }

    const data = await response.json();
    const result = data.result || 'Emergent Compound';
    const reasoning = data.reasoning || '';
    const emergentProperty = data.emergentProperty || '';
    const confidence = data.confidence ?? 0.5;

    // CRITICAL: remove BOTH old boxes from DOM before spawning the new one
    draggedEl.remove();
    targetEl.remove();
    nodes.delete(draggedId);
    nodes.delete(targetId);

    // Record merge in semantic memory
    memory.recordMerge(keywordA, keywordB, result);

    // Spawn the new merged result at the exact collision midpoint
    const mergedId = createNode(result, cx, cy);
    // Draw merge relationship lines
    addMergeRelation(mergedId, [draggedId, targetId]);
    const mergedEl = nodes.get(mergedId);
    if (mergedEl) {
      mergedEl.classList.add('merged-flash');
      mergedEl.classList.add('enriched');

      // Store synthesis metadata on the element
      if (reasoning) {
        mergedEl.title = `💡 ${reasoning}\n✨ ${emergentProperty}\n📊 Confidence: ${(confidence * 100).toFixed(0)}%`;
      }
      if (emergentProperty) {
        mergedEl.dataset.emergentProperty = emergentProperty;
      }
      mergedEl.dataset.confidence = String(confidence);

      // Set confidence bar width via CSS variable
      mergedEl.style.setProperty('--conf-width', `${(confidence * 100).toFixed(0)}%`);

      // High-confidence merges get a special glow
      if (confidence > 0.8) {
        mergedEl.classList.add('high-confidence');
      }

      triggerEnrich(mergedId, result);
    }
  } catch (err) {
    console.warn('[Merge] Failed:', err.message);
    // Restore original state on failure
    draggedEl.classList.remove('merging');
    targetEl.classList.remove('merging');
    draggedEl.textContent = origTextA;
    targetEl.textContent = origTextB;
  }
}

// ============================================================
// AI Fracture (double-click → split into components)
// ============================================================

async function fractureNode(id) {
  const el = nodes.get(id);
  if (!el) return;

  const keyword = el.textContent?.trim();
  if (!keyword) return;

  const cx = parseFloat(el.style.left) || 0;
  const cy = parseFloat(el.style.top) || 0;

  let components;

  if (el.dataset.components) {
    try { components = JSON.parse(el.dataset.components); } catch { /* fall through */ }
  }

  if (!components || components.length < 2) {
    el.classList.add('enriching');
    try {
      const { enrichPayload } = await import('./ai-enrich.js');
      const enriched = await enrichPayload({ type: 'text', value: keyword, label: keyword }, id);
      if (enriched.type === 'array' && Array.isArray(enriched.value) && enriched.value.length > 1) {
        components = enriched.value.map(String);
      }
    } catch {
      el.classList.remove('enriching');
      return;
    }
  }

  el.classList.remove('enriching');
  if (!components || components.length < 2) return;

  el.remove();
  nodes.delete(id);

  // Record fracture in semantic memory
  memory.recordFracture(keyword, components);

  // Collect child IDs for relationship viz
  const childIds = [];

  const count = components.length;
  const spread = 40 + count * 12;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const x = cx + Math.cos(angle) * spread;
    const y = cy + Math.sin(angle) * spread;
    const childId = createNode(components[i], x, y);
    childIds.push(childId);
    const childEl = nodes.get(childId);
    if (childEl) {
      childEl.classList.add('child');
      childEl.classList.add('enriched');
      childEl.dataset.components = JSON.stringify([components[i]]);
    }
  }

  // Draw parent→child relationship lines
  addParentRelation(id, childIds);
}

// ============================================================
// Deep Fracture (Shift+double-click → recursive multi-level decomposition)
// ============================================================

/**
 * Recursively fracture a node and its children up to `depth` levels.
 * Uses the server's /api/enrich/deep endpoint for the full tree,
 * then spawns ALL nodes in the tree with staggered animations.
 */
async function deepFracture(id, depth = 2) {
  const el = nodes.get(id);
  if (!el) return;

  const keyword = el.textContent?.trim();
  if (!keyword) return;

  const cx = parseFloat(el.style.left) || 0;
  const cy = parseFloat(el.style.top) || 0;

  // Show loading on the parent
  el.classList.add('enriching');
  el.textContent = '🔬 Deep Fracturing...';

  try {
    const response = await fetch('/api/enrich/deep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, depth }),
    });

    if (!response.ok) {
      throw new Error(`Server error ${response.status}`);
    }

    const data = await response.json();
    const tree = data.tree;
    if (!tree || !tree.components || tree.components.length < 2) {
      // Fall back to normal fracture
      el.classList.remove('enriching');
      el.textContent = keyword;
      fractureNode(id);
      return;
    }

    // Remove the parent
    el.remove();
    nodes.delete(id);
    memory.recordFracture(keyword, tree.components.map(c => c.keyword));

    // Spawn the full tree recursively with staggered animations
    spawnTree(tree.components, cx, cy, spreadForLevel(depth), 1, depth);
  } catch (err) {
    console.warn('[Deep Fracture] Failed:', err.message);
    el.classList.remove('enriching');
    el.textContent = keyword;
    // Fall back to normal fracture
    fractureNode(id);
  }
}

/** Compute spread radius for a given depth level. */
function spreadForLevel(depth) { return 40 + depth * 25; }

/**
 * Recursively spawn tree nodes in a circular pattern.
 * Each depth level gets a wider spread and delayed animation.
 */
function spawnTree(components, cx, cy, spread, currentDepth, maxDepth) {
  const count = components.length;
  const staggerDelay = currentDepth * 180; // ms delay per depth level

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const radius = spread * (0.6 + currentDepth * 0.5);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;

    setTimeout(() => {
      const childId = createNode(components[i].keyword, x, y);
      const childEl = nodes.get(childId);
      if (childEl) {
        childEl.dataset.depth = String(currentDepth);
        childEl.classList.add('child');
        childEl.classList.add('enriched');
        childEl.classList.add(`depth-${Math.min(currentDepth, 3)}`);

        if (components[i].components?.length > 0) {
          childEl.dataset.components = JSON.stringify(
            components[i].components.map(c => c.keyword)
          );
        }

        // Recurse into grandchildren
        if (components[i].components?.length > 0 && currentDepth < maxDepth) {
          setTimeout(() => {
            spawnTree(
              components[i].components,
              x, y,
              spread * 0.7, // tighter spread for deeper levels
              currentDepth + 1,
              maxDepth
            );
          }, 400);
        }
      }
    }, staggerDelay + i * 80);
  }
}

// ============================================================
// Drag System (with collision detection for merge)
// ============================================================

let dragTarget = null;
let dragStartX = 0;
let dragStartY = 0;
let nodeStartX = 0;
let nodeStartY = 0;
let mergeTarget = null; // currently highlighted merge target

/** Check if two boxes overlap (at least 40% of either box intersects). */
function boxesOverlap(a, b) {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();

  const overlapX = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
  const overlapY = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
  const overlapArea = overlapX * overlapY;

  const areaA = ra.width * ra.height;
  const areaB = rb.width * rb.height;
  const minArea = Math.min(areaA, areaB);

  return overlapArea > minArea * 0.35;
}

/** Find another data-box that overlaps with the dragged element. */
function findMergeTarget(dragged) {
  for (const [id, el] of nodes) {
    if (el === dragged) continue;
    if (boxesOverlap(dragged, el)) return { id, el };
  }
  return null;
}

workspace.addEventListener('mousedown', (e) => {
  const box = e.target.closest('.data-box');
  if (box) {
    dragTarget = box;
    dragTarget.classList.add('dragging');
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    nodeStartX = parseFloat(box.style.left) || 0;
    nodeStartY = parseFloat(box.style.top) || 0;
    e.preventDefault();
  }
});

window.addEventListener('mousemove', (e) => {
  if (!dragTarget) return;

  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  dragTarget.style.left = (nodeStartX + dx) + 'px';
  dragTarget.style.top = (nodeStartY + dy) + 'px';

  // Collision detection: highlight merge target
  const target = findMergeTarget(dragTarget);
  if (target && target.el !== mergeTarget?.el) {
    // New merge target found
    if (mergeTarget) mergeTarget.el.classList.remove('merge-target');
    mergeTarget = target;
    mergeTarget.el.classList.add('merge-target');
  } else if (!target && mergeTarget) {
    // No longer overlapping
    mergeTarget.el.classList.remove('merge-target');
    mergeTarget = null;
  }
});

window.addEventListener('mouseup', () => {
  if (dragTarget) {
    dragTarget.classList.remove('dragging');

    // Check for merge on drop
    if (mergeTarget) {
      mergeTarget.el.classList.remove('merge-target');
      const draggedId = Number(dragTarget.dataset.id);
      const targetId = Number(mergeTarget.el.dataset.id);
      mergeNodes(draggedId, targetId);
      mergeTarget = null;
    }

    dragTarget = null;
  }
});

// ============================================================
// Auto-Suggestion System (every 30s when workspace has >= 3 nodes)
// ============================================================

let suggestionTimer = null;
const suggestionContainer = document.createElement('div');
suggestionContainer.id = 'suggestions';
document.body.appendChild(suggestionContainer);

/** Clear and re-render ghost suggestion nodes. */
function renderSuggestions(suggestions) {
  suggestionContainer.innerHTML = '';
  if (!suggestions || suggestions.length === 0) return;

  const spacing = 48;
  const startY = window.innerHeight / 2 - (suggestions.length * spacing) / 2;

  suggestions.forEach((keyword, i) => {
    const ghost = document.createElement('div');
    ghost.className = 'data-box suggested';
    ghost.textContent = keyword;
    ghost.style.position = 'fixed';
    ghost.style.right = '12px';
    ghost.style.top = (startY + i * spacing) + 'px';
    ghost.style.left = 'auto';
    ghost.style.transform = 'translate(0, -50%)';
    ghost.style.zIndex = '90';
    ghost.title = 'Click to create this node';

    ghost.addEventListener('click', () => {
      const cx = window.innerWidth / 2 + (Math.random() - 0.5) * 200;
      const cy = window.innerHeight / 2 + (Math.random() - 0.5) * 200;
      createNode(keyword, cx, cy);
      // Remove this ghost
      ghost.remove();
    });

    suggestionContainer.appendChild(ghost);
  });
}

/** Fetch and render suggestions from the server. */
async function refreshSuggestions() {
  if (nodes.size < 3) {
    renderSuggestions([]);
    return;
  }

  try {
    const keywords = [];
    for (const el of nodes.values()) {
      const kw = el.textContent?.trim();
      if (kw && kw !== '⚗️ Merging...' && kw !== '🔬 Deep Fracturing...') {
        keywords.push(kw);
      }
    }

    const { getSuggestions } = await import('./ai-suggest.js');
    const suggestions = await getSuggestions(keywords);
    renderSuggestions(suggestions);
  } catch {
    // Silently fail — suggestions are non-critical
  }
}

/** Start the periodic suggestion refresh. */
function startSuggestions() {
  stopSuggestions();
  suggestionTimer = setInterval(refreshSuggestions, 30000);
  // Initial fetch after 8 seconds
  setTimeout(refreshSuggestions, 8000);
}

function stopSuggestions() {
  if (suggestionTimer) { clearInterval(suggestionTimer); suggestionTimer = null; }
}

// Kick off suggestions on load
startSuggestions();

// ============================================================
// Keyboard Shortcuts
// ============================================================

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    // Don't trigger when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const nowVisible = toggleVisibility();
    console.log(`[Relations] ${nowVisible ? 'Shown' : 'Hidden'}`);
  }
});

// ============================================================
// Double-Click: Create / Fracture / Deep Fracture (Shift)
// ============================================================

workspace.addEventListener('dblclick', (e) => {
  const box = e.target.closest('.data-box');
  if (box) {
    const id = Number(box.dataset.id);
    if (e.shiftKey) {
      // Shift+double-click → recursive deep fracture (depth 2)
      deepFracture(id, 2);
    } else {
      fractureNode(id);
    }
  } else if (e.target === workspace) {
    showInputDialog(e.clientX, e.clientY);
  }
});

// ============================================================
// Create Button
// ============================================================

createBtn.addEventListener('click', () => {
  showInputDialog(window.innerWidth / 2, window.innerHeight / 2);
});

// ============================================================
// Global API
// ============================================================

window.lse = {
  createNode,
  fractureNode,
  deepFracture,
  mergeNodes,
  refreshSuggestions,
  startSuggestions,
  stopSuggestions,
  getNodes() { return nodes; },
  getNodeCount() { return nodes.size; },
  get memory() { return memory; },
};
