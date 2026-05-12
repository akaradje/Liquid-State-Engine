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
 */

// ============================================================
// Workspace
// ============================================================
const workspace = document.getElementById('workspace');
const createBtn = document.getElementById('create-btn');

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
    if (enriched.type === 'array' && Array.isArray(enriched.value) && enriched.value.length > 0) {
      el.classList.add('enriched');
      el.dataset.components = JSON.stringify(enriched.value);
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
    const response = await fetch('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'merge', keywords: [keywordA, keywordB] }),
    });

    if (!response.ok) {
      throw new Error(`Server error ${response.status}`);
    }

    const data = await response.json();
    const result = data.result || 'Conceptual Anomaly';

    // CRITICAL: remove BOTH old boxes from DOM before spawning the new one
    draggedEl.remove();
    targetEl.remove();
    nodes.delete(draggedId);
    nodes.delete(targetId);

    // Spawn the new merged result at the exact collision midpoint
    const mergedId = createNode(result, cx, cy);
    const mergedEl = nodes.get(mergedId);
    if (mergedEl) {
      mergedEl.classList.add('merged-flash');
      mergedEl.classList.add('enriched');
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

  const count = components.length;
  const spread = 40 + count * 12;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const x = cx + Math.cos(angle) * spread;
    const y = cy + Math.sin(angle) * spread;
    const childId = createNode(components[i], x, y);
    const childEl = nodes.get(childId);
    if (childEl) {
      childEl.classList.add('child');
      childEl.classList.add('enriched');
      childEl.dataset.components = JSON.stringify([components[i]]);
    }
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
// Double-Click: Create (on empty) or Fracture (on node)
// ============================================================

workspace.addEventListener('dblclick', (e) => {
  const box = e.target.closest('.data-box');
  if (box) {
    const id = Number(box.dataset.id);
    fractureNode(id);
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
  mergeNodes,
  getNodes() { return nodes; },
  getNodeCount() { return nodes.size; },
};
