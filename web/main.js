// Suppress SES/Lockdown interference from browser extensions (MetaMask, crypto wallets)
if (typeof globalThis.__sesshin_lockdown !== 'undefined' || typeof globalThis.lockdown === 'function') {
  console.warn('[LSE] Detected SES/Lockdown (likely crypto wallet extension). Some features may be affected.');
}

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
import { emitFractureParticles, emitMergeParticles } from './particles.js';
import { drawBeam, startTrailLoop } from './trails.js';
import { playCreate, playFracture, playMerge, playHover, toggleMute } from './audio.js';
import { saveWorkspace, loadWorkspace, checkAutosave, exportAsJSON, importFromJSON, showToast } from './persistence.js';
import { connect, isConnected, onRemoteCreate, onRemoteDelete, onRemoteFracture, onRemoteMerge, onRemoteMove, broadcastCreate, broadcastDelete, broadcastFracture, broadcastMerge, broadcastMove, broadcastCursor, getOnlineCount } from './collab.js';
import { SemanticSpace } from './semantic-space.js';
import { Ontology } from './ontology.js';
import { startCuriosityEngine, touchInput, dismissCurrent } from './curiosity.js';
import { scheduleTensionAnalysis, startPulseLoop, getTensionCount } from './tension-detector.js';
import { MetaLearner } from './meta-learner.js';

// ============================================================
// Workspace
// ============================================================
const workspace = document.getElementById('workspace');
const createBtn = document.getElementById('create-btn');

// Global semantic memory (survives page reloads via localStorage)
const memory = new SemanticMemory();
const semanticSpace = new SemanticSpace();
const ontology = new Ontology();
const metaLearner = new MetaLearner();

let nodeIdCounter = 0;
/** @type {Map<number, HTMLElement>} */
const nodes = new Map();

// Interaction state
let mouseX = 0;
let mouseY = 0;
let prevMouseX = 0;
let prevMouseY = 0;
let isDragging = false;
let dragNodeId = null;

// ============================================================
// Optional Wasm Physics Layer
// ============================================================

/** @type {object|null} */
let physicsEngine = null;
let physicsEnabled = false;
let wasmMemory = null;
/** Map from DOM node ID → Wasm entity ID */
const wasmIdMap = new Map();

async function initPhysics() {
  try {
    const wasm = await import('./pkg/liquid_state_engine.js');
    await wasm.default();
    wasmMemory = wasm.__wasm?.memory;
    if (!wasmMemory) { console.log('[Physics] Wasm memory unavailable, using static DOM'); return; }

    physicsEngine = new wasm.LiquidEngine(
      window.innerWidth, window.innerHeight, 5000
    );
    physicsEnabled = true;
    console.log('[Physics] Wasm engine initialized — liquid physics active');
  } catch (err) {
    console.log('[Physics] Wasm not available, using static DOM:', err.message);
  }
}

/** Register a DOM node with the physics engine. */
function physicsSpawn(domId, x, y, vx = 0, vy = 0) {
  if (!physicsEngine) return;
  const radius = 22; // Approximate data-box half-width
  const eid = physicsEngine.spawn_at(x, y, vx, vy, radius);
  if (eid !== 0xFFFFFFFF) {
    wasmIdMap.set(domId, eid);
  }
  return eid;
}

function physicsDespawn(domId) {
  if (!physicsEngine) return;
  const eid = wasmIdMap.get(domId);
  if (eid !== undefined) {
    physicsEngine.despawn(eid);
    wasmIdMap.delete(domId);
  }
}

function physicsSetPosition(domId, x, y) {
  if (!physicsEngine) return;
  const eid = wasmIdMap.get(domId);
  if (eid !== undefined) {
    physicsEngine.set_position(eid, x, y);
    physicsEngine.set_velocity_zero(eid);
  }
}

function physicsApplyImpulse(domId, vx, vy) {
  if (!physicsEngine) return;
  const eid = wasmIdMap.get(domId);
  if (eid !== undefined) {
    physicsEngine.apply_impulse(eid, vx, vy);
  }
}

/** Sync DOM positions from physics engine after tick. */
function physicsSyncPositions() {
  if (!physicsEngine || !wasmMemory) return;
  const count = physicsEngine.active_count();
  if (count === 0) return;

  const idsPtr = physicsEngine.active_ids_ptr();
  const posPtr = physicsEngine.positions_ptr();
  const ids = new Uint32Array(wasmMemory.buffer, idsPtr, count);
  const positions = new Float32Array(wasmMemory.buffer, posPtr, count * 2);

  for (let j = 0; j < count; j++) {
    const eid = ids[j];
    const x = positions[j * 2];
    const y = positions[j * 2 + 1];

    // Find the DOM node for this Wasm entity
    for (const [domId, mappedEid] of wasmIdMap) {
      if (mappedEid === eid) {
        const el = nodes.get(domId);
        if (el) {
          el.style.left = x + 'px';
          el.style.top = y + 'px';
        }
        break;
      }
    }
  }
}

/** Main physics loop (runs independently of render). */
let lastPhysicsTime = 0;
function physicsLoop(timestamp) {
  if (!physicsEngine || !physicsEnabled) return;
  if (lastPhysicsTime === 0) { lastPhysicsTime = timestamp; return; }

  const dt = Math.min((timestamp - lastPhysicsTime) / 1000, 0.033);
  lastPhysicsTime = timestamp;

  // Update drag-locked nodes
  if (isDragging && dragNodeId !== null) {
    const mouse = getMousePos();
    physicsSetPosition(dragNodeId, mouse.x, mouse.y);
  }

  physicsEngine.tick_dom(dt);
  physicsSyncPositions();
}

// Kick off physics init
initPhysics();

// ============================================================
// Collaboration (WebSocket)
// ============================================================

connect().then(connected => {
  if (connected) {
    console.log('[Collab] Connected to relay server');
    setupCollabHandlers();
  } else {
    console.log('[Collab] Running in single-user mode');
  }
});

function setupCollabHandlers() {
  // When a remote user creates a node
  onRemoteCreate((text, x, y, userId, color) => {
    const id = createNode(text, x, y);
    const el = nodes.get(id);
    if (el && color) el.style.borderColor = color;
  });

  // When a remote user deletes a node
  onRemoteDelete((id) => {
    const el = nodes.get(id);
    if (el) { el.remove(); nodes.delete(id); }
  });

  // When a remote user fractures a node
  onRemoteFracture((parentId, children, userId) => {
    const parentEl = nodes.get(parentId);
    if (parentEl) { parentEl.remove(); nodes.delete(parentId); }
    if (children) {
      for (const c of children) {
        createNode(c.text, c.x, c.y);
      }
    }
  });

  // When a remote user merges two nodes
  onRemoteMerge((idA, idB, result, resultId, x, y) => {
    for (const id of [idA, idB]) {
      const el = nodes.get(id);
      if (el) { el.remove(); nodes.delete(id); }
    }
    createNode(result, x, y);
  });

  // When a remote user moves a node
  onRemoteMove((id, x, y) => {
    const el = nodes.get(id);
    if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
  });
}

// Throttled cursor broadcast
let lastCursorBroadcast = 0;
function maybeBroadcastCursor() {
  if (!isConnected()) return;
  const now = Date.now();
  if (now - lastCursorBroadcast < 50) return;
  lastCursorBroadcast = now;
  broadcastCursor(mouseX, mouseY);
}

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
  el.dataset.created = new Date().toLocaleTimeString();
  addRatingButtons(el);

  // Register with physics engine
  physicsSpawn(id, x, y, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);

  playCreate();
  broadcastCreate(id, label, x, y);
  if (label) { semanticSpace.addNode(id, label); ontology.classify(label); }

  scheduleTensionAnalysis(nodes);

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

  // Safety timeout: ensure node becomes interactive even if API hangs
  const safetyTimeout = setTimeout(() => { el.classList.remove('enriching'); }, 15000);

  try {
    const { enrichPayload } = await import('./ai-enrich.js');
    const enriched = await enrichPayload({ type: 'text', value: keyword, label: keyword }, id);

    const contextStr = memory.getEnrichContext(keyword);
    if (contextStr) {
      try {
        const ctxRes = await fetch('/api/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword, context: contextStr, userProfile: metaLearner.getUserProfile() }),
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
      if (enriched.grounded) {
        el.classList.add('grounded');
        el.title = (el.title || '') + '\n📚 Grounded in external knowledge';
      }
    }
    if (!el.dataset.confidence) {
      el.dataset.confidence = '0.7';
      el.style.setProperty('--conf-width', '70%');
    }
  } catch {
    // enrichment failed — node stays as plain text
  } finally {
    clearTimeout(safetyTimeout);
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
    // Build memory + ontology context for both keywords
    const ctxA = memory.getEnrichContext(keywordA);
    const ctxB = memory.getEnrichContext(keywordB);
    const lca = ontology.getLCA(keywordA, keywordB);
    const lcaContext = lca ? `Both concepts share common ancestor: ${lca}. Find emergent property at this abstraction level.` : '';
    const memoryContext = [lcaContext, ctxA, ctxB].filter(Boolean).join(' | ');

    const response = await fetch('/api/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'merge',
        keywords: [keywordA, keywordB],
        context: memoryContext || undefined,
        userProfile: metaLearner.getUserProfile(),
        disableReflection: !(window.__LSE_CONFIG__?.enableReflection ?? true),
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

    // Emit spiral merge particles + fusion sound BEFORE removing sources
    playMerge();
    emitMergeParticles(
      parseFloat(draggedEl.style.left) || 0, parseFloat(draggedEl.style.top) || 0,
      parseFloat(targetEl.style.left) || 0, parseFloat(targetEl.style.top) || 0,
      cx, cy
    );

    // CRITICAL: remove BOTH old boxes from DOM before spawning the new one
    draggedEl.remove();
    targetEl.remove();
    nodes.delete(draggedId);
    nodes.delete(targetId);
    physicsDespawn(draggedId);
    physicsDespawn(targetId);

    // Record merge in semantic memory
    memory.recordMerge(keywordA, keywordB, result);

    // Broadcast merge to collaborators
    broadcastMerge(draggedId, targetId, result, 0, cx, cy);

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

      // Reflection-improved: blue pulse
      if (data.reflection?.attempts > 1) {
        mergedEl.classList.add('reflection-improved');
        mergedEl.dataset.critique = data.reflection?.critique || '';
        setTimeout(() => mergedEl.classList.remove('reflection-improved'), 2000);
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
    el.textContent = '🔄 Reflecting...';
    try {
      const { enrichPayload } = await import('./ai-enrich.js');
      const enriched = await enrichPayload({ type: 'text', value: keyword, label: keyword }, id);
      if (enriched.type === 'array' && Array.isArray(enriched.value) && enriched.value.length > 1) {
        components = enriched.value.map(String);
      }
      if (enriched._reflection?.attempts > 1) {
        el.classList.add('reflection-improved');
        el.dataset.critique = enriched._reflection?.critique || '';
        setTimeout(() => el.classList.remove('reflection-improved'), 2000);
      }
    } catch {
      el.classList.remove('enriching');
      el.textContent = keyword;
      return;
    }
  }

  el.classList.remove('enriching');
  el.textContent = keyword;
  if (!components || components.length < 2) return;

  el.remove();
  nodes.delete(id);
  physicsDespawn(id);

  // Particle burst at fracture point
  emitFractureParticles(cx, cy);
  playFracture();

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
    // Apply radial ejection velocity
    physicsApplyImpulse(childId, Math.cos(angle) * 80, Math.sin(angle) * 80);
    const childEl = nodes.get(childId);
    if (childEl) {
      childEl.classList.add('child');
      childEl.classList.add('enriched');
      childEl.dataset.components = JSON.stringify([components[i]]);
    }
  }

  // Draw parent→child relationship lines
  addParentRelation(id, childIds);

  // Broadcast fracture event
  const childData = childIds.map(cid => {
    const cel = nodes.get(cid);
    return { id: cid, text: cel?.textContent || '', x: parseFloat(cel?.style.left) || 0, y: parseFloat(cel?.style.top) || 0 };
  });
  broadcastFracture(id, childData);
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
// Physics Animation Loop
// ============================================================

function getMousePos() { return { x: mouseX, y: mouseY }; }

function startPhysicsLoop() {
  const loop = (ts) => { physicsLoop(ts); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
startPhysicsLoop();
startTrailLoop();
startCuriosityEngine(nodes);

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
  try {
    console.log('[Drag] mousedown target:', e.target?.tagName, e.target?.className);
    e.stopImmediatePropagation();
    const box = e.target?.closest?.('.data-box');
    if (box) {
      dragTarget = box;
      dragTarget.classList.add('dragging');
      isDragging = true;
      dragNodeId = Number(box.dataset.id);
      highlightSimilarNodes(Number(box.dataset.id));
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartX = parseFloat(box.style.left) || 0;
      nodeStartY = parseFloat(box.style.top) || 0;
      e.preventDefault();
    }
  } catch (err) { console.warn('[Drag] mousedown error:', err.message); }
});

window.addEventListener('mousemove', (e) => {
  try {
    touchInput();
    mouseX = e.clientX;
    mouseY = e.clientY;
    maybeBroadcastCursor();

    if (!dragTarget) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    dragTarget.style.left = (nodeStartX + dx) + 'px';
    dragTarget.style.top = (nodeStartY + dy) + 'px';

    // Collision detection: highlight merge target
    const target = findMergeTarget(dragTarget);
    if (target) {
      const fromEl = dragTarget;
      const toEl = target.el;
      drawBeam(
        { x: parseFloat(fromEl.style.left) || 0, y: parseFloat(fromEl.style.top) || 0 },
        { x: parseFloat(toEl.style.left) || 0, y: parseFloat(toEl.style.top) || 0 }
      );
    } else {
      drawBeam(null, null);
    }

    if (target && target.el !== mergeTarget?.el) {
      if (mergeTarget) mergeTarget.el.classList.remove('merge-target');
      mergeTarget = target;
      mergeTarget.el.classList.add('merge-target');
    } else if (!target && mergeTarget) {
      mergeTarget.el.classList.remove('merge-target');
      mergeTarget = null;
    }
  } catch (err) { /* mousemove errors are non-critical */ }
});

window.addEventListener('mouseup', () => {
  try {
    clearSimilarHighlights();
    if (dragTarget) {
      dragTarget.classList.remove('dragging');
      drawBeam(null, null);

      if (mergeTarget) {
        mergeTarget.el.classList.remove('merge-target');
        const draggedId = Number(dragTarget.dataset.id);
        const targetId = Number(mergeTarget.el.dataset.id);
        mergeNodes(draggedId, targetId);
        mergeTarget = null;
      }

      dragTarget = null;
      isDragging = false;
      dragNodeId = null;
    }
  } catch (err) { console.warn('[Drag] mouseup error:', err.message); }
});

// ============================================================
// Touch Support (mobile devices)
// ============================================================

// Double-tap detection
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

// Long-press detection
let longPressTimer = null;
let longPressTarget = null;
let touchMoved = false;

// Pinch zoom
let pinchStartDist = 0;
let pinchScale = 1;

function getTouchPos(touch) {
  return { x: touch.clientX, y: touch.clientY };
}

function handleDragStart(pos, target) {
  const box = target.closest('.data-box');
  if (box) {
    dragTarget = box;
    dragTarget.classList.add('dragging');
    isDragging = true;
    dragNodeId = Number(box.dataset.id);
    dragStartX = pos.x;
    dragStartY = pos.y;
    nodeStartX = parseFloat(box.style.left) || 0;
    nodeStartY = parseFloat(box.style.top) || 0;
    mouseX = pos.x;
    mouseY = pos.y;
  }
}

function handleDragMove(pos) {
  if (!dragTarget) return;
  mouseX = pos.x;
  mouseY = pos.y;
  maybeBroadcastCursor();
  const dx = pos.x - dragStartX;
  const dy = pos.y - dragStartY;
  dragTarget.style.left = (nodeStartX + dx) + 'px';
  dragTarget.style.top = (nodeStartY + dy) + 'px';

  const target = findMergeTarget(dragTarget);
  if (target) {
    drawBeam(
      { x: parseFloat(dragTarget.style.left) || 0, y: parseFloat(dragTarget.style.top) || 0 },
      { x: parseFloat(target.el.style.left) || 0, y: parseFloat(target.el.style.top) || 0 }
    );
  } else { drawBeam(null, null); }

  if (target && target.el !== mergeTarget?.el) {
    if (mergeTarget) mergeTarget.el.classList.remove('merge-target');
    mergeTarget = target;
    mergeTarget.el.classList.add('merge-target');
  } else if (!target && mergeTarget) {
    mergeTarget.el.classList.remove('merge-target');
    mergeTarget = null;
  }
}

function handleDragEnd() {
  if (dragTarget) {
    dragTarget.classList.remove('dragging');
    drawBeam(null, null);
    if (mergeTarget) {
      mergeTarget.el.classList.remove('merge-target');
      const draggedId = Number(dragTarget.dataset.id);
      const targetId = Number(mergeTarget.el.dataset.id);
      mergeNodes(draggedId, targetId);
      mergeTarget = null;
    }
    dragTarget = null;
    isDragging = false;
    dragNodeId = null;
  }
}

// Touch handlers
workspace.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    const pos = getTouchPos(e.touches[0]);
    touchMoved = false;

    // Double-tap detection
    const now = Date.now();
    if (now - lastTapTime < 300 && Math.abs(pos.x - lastTapX) < 20 && Math.abs(pos.y - lastTapY) < 20) {
      // Double tap detected
      clearTimeout(longPressTimer);
      const box = e.target.closest('.data-box');
      if (box) {
        const id = Number(box.dataset.id);
        if (e.shiftKey) { deepFracture(id, 2); } else { fractureNode(id); }
      } else if (e.target === workspace || e.target.closest('#workspace')) {
        showInputDialog(pos.x, pos.y);
      }
      lastTapTime = 0;
      e.preventDefault();
      return;
    }
    lastTapTime = now;
    lastTapX = pos.x;
    lastTapY = pos.y;

    // Start drag
    handleDragStart(pos, e.target);

    // Long-press detection
    const target = e.target.closest('.data-box');
    if (target) {
      longPressTarget = target;
      longPressTimer = setTimeout(() => {
        if (!touchMoved) showContextMenu(target, pos);
      }, 600);
    }

    e.preventDefault();
  }

  // Pinch start
  if (e.touches.length === 2) {
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
  }
}, { passive: false });

workspace.addEventListener('touchmove', (e) => {
  if (e.touches.length === 1) {
    touchMoved = true;
    clearTimeout(longPressTimer);
    const pos = getTouchPos(e.touches[0]);
    handleDragMove(pos);
    e.preventDefault();
  }

  // Pinch zoom
  if (e.touches.length === 2) {
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    if (pinchStartDist > 0) {
      const scale = dist / pinchStartDist;
      pinchScale *= scale;
      pinchStartDist = dist;
      if (window.__LSE_CONFIG__) window.__LSE_CONFIG__.zoom = pinchScale;
      console.log(`[Zoom] ${(pinchScale * 100).toFixed(0)}%`);
    }
    e.preventDefault();
  }
}, { passive: false });

workspace.addEventListener('touchend', (e) => {
  clearTimeout(longPressTimer);
  if (e.touches.length === 0) {
    handleDragEnd();
    longPressTarget = null;
  }
  pinchStartDist = 0;
});

// ---- Long-Press Context Menu ----

function showContextMenu(el, pos) {
  // Remove any existing
  document.querySelector('.context-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.cssText = `
    position:fixed; left:${pos.x}px; top:${pos.y}px;
    z-index:5000; min-width:140px;
    background:rgba(15,22,40,0.95); backdrop-filter:blur(16px);
    border:1px solid rgba(100,180,255,0.25); border-radius:10px;
    padding:4px; box-shadow:0 8px 32px rgba(0,0,0,0.6);
    font-family:'SF Mono',monospace; font-size:11px;
    animation:tooltipIn 0.15s ease-out;
  `;

  const items = [
    { label: '⚡ Fracture', action: () => fractureNode(Number(el.dataset.id)) },
    { label: '🔬 Deep Fracture', action: () => deepFracture(Number(el.dataset.id), 2) },
    { label: '💭 Imagine without...', action: () => spawnCounterfactual(el, 'absent') },
    { label: '🔄 Invert this...', action: () => spawnCounterfactual(el, 'inverted') },
    { label: '🔺 Amplify this...', action: () => spawnCounterfactual(el, 'extreme') },
    { label: '📋 Copy Keyword', action: () => { navigator.clipboard.writeText(el.textContent?.trim() || ''); showToast('Copied!'); } },
    { label: '🗑️ Delete', action: () => { const id = Number(el.dataset.id); el.remove(); nodes.delete(id); physicsDespawn(id); } },
  ];

  for (const item of items) {
    const btn = document.createElement('div');
    btn.textContent = item.label;
    btn.style.cssText = 'padding:8px 12px;cursor:pointer;border-radius:6px;color:rgba(200,225,255,0.85);';
    btn.onmouseenter = () => { btn.style.background = 'rgba(60,120,255,0.2)'; };
    btn.onmouseleave = () => { btn.style.background = 'transparent'; };
    btn.onclick = () => { item.action(); menu.remove(); };
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Close on tap outside
  const close = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); }
    document.removeEventListener('touchstart', close);
    document.removeEventListener('mousedown', close);
  };
  setTimeout(() => {
    document.addEventListener('touchstart', close);
    document.addEventListener('mousedown', close);
  }, 100);
}

// Right-click context menu (desktop)
workspace.addEventListener('contextmenu', (e) => {
  const box = e.target.closest('.data-box');
  if (box) {
    e.preventDefault();
    showContextMenu(box, { x: e.clientX, y: e.clientY });
  }
});

// ---- Counterfactual Reasoning ----

async function spawnCounterfactual(el, mode) {
  const keyword = el.textContent?.trim();
  if (!keyword) return;
  const cx = parseFloat(el.style.left) || 0;
  const cy = parseFloat(el.style.top) || 0;

  const depth = parseInt(el.dataset.cfDepth) || 0;
  const newDepth = depth + 1;
  if (newDepth > 5) { showToast('⚠️ Max counterfactual depth (5) reached'); return; }

  el.classList.add('enriching');
  const origText = el.textContent;

  try {
    const res = await fetch('/api/counterfactual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, mode }),
    });
    if (!res.ok) throw new Error('CF failed');
    const data = await res.json();

    let label;
    if (mode === 'absent') label = data.alternative || `¬${keyword}`;
    else if (mode === 'inverted') label = data.inverse || `~${keyword}`;
    else label = data.extreme || `∞${keyword}`;

    // Spawn counterfactual node offset from parent
    const cfId = createNode(label, cx + 80 + Math.random() * 40, cy - 40 + Math.random() * 80);
    const cfEl = nodes.get(cfId);
    if (cfEl) {
      cfEl.classList.add('counterfactual');
      cfEl.dataset.cfDepth = String(newDepth);
      cfEl.dataset.cfParent = el.dataset.id;
      cfEl.title = mode === 'absent'
        ? `Without "${keyword}": ${data.reasoning || ''}`
        : mode === 'inverted'
        ? `Inverse of "${keyword}": ${data.reasoning || ''}`
        : `Extreme "${keyword}": ${(data.implications || []).join(', ')}`;

      // Draw SVG line from parent to counterfactual
      drawCFLine({
        fromX: cx, fromY: cy,
        toX: parseFloat(cfEl.style.left) || 0,
        toY: parseFloat(cfEl.style.top) || 0,
      });
    }
  } catch (err) { console.warn('[CF] Failed:', err.message); }
  el.classList.remove('enriching');
}

/** Draw a dashed violet line from parent to counterfactual node. */
function drawCFLine({ fromX, fromY, toX, toY }) {
  const svg = document.getElementById('relations-svg') || document.getElementById('tension-svg');
  if (!svg) return;
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', fromX); line.setAttribute('y1', fromY);
  line.setAttribute('x2', toX); line.setAttribute('y2', toY);
  line.setAttribute('stroke', 'rgba(180,120,255,0.35)');
  line.setAttribute('stroke-width', '1.2');
  line.setAttribute('stroke-dasharray', '6,4');
  line.classList.add('cf-line');
  svg.appendChild(line);
    // Fade out after 10s
    setTimeout(() => { line.style.opacity = '0'; line.style.transition = 'opacity 2s'; }, 10000);
}

// Reality anchor: 'T' to promote, 'Escape' to collapse
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 't' || e.key === 'T') {
    // Promote nearest counterfactual node under mouse
    const hovered = document.elementFromPoint(mouseX || 0, mouseY || 0);
    const cfBox = hovered?.closest?.('.data-box.counterfactual');
    if (cfBox) {
      cfBox.classList.remove('counterfactual');
      cfBox.style.opacity = '1';
      cfBox.style.fontStyle = 'normal';
      delete cfBox.dataset.cfDepth;
      showToast('💫 Made real');
    }
  }
  if (e.key === 'Escape') {
    // Collapse nearest counterfactual back to parent
    const hovered = document.elementFromPoint(mouseX || 0, mouseY || 0);
    const cfBox = hovered?.closest?.('.data-box.counterfactual');
    if (cfBox) {
      const parentId = Number(cfBox.dataset.cfParent);
      cfBox.remove();
      nodes.delete(Number(cfBox.dataset.id));
      physicsDespawn(Number(cfBox.dataset.id));
      // Highlight parent briefly
      const parentEl = nodes.get(parentId);
      if (parentEl) { parentEl.classList.add('analogy-source'); setTimeout(() => parentEl.classList.remove('analogy-source'), 2000); }
    }
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
// Auto-Save (every 10 seconds if changed)
// ============================================================

let lastSavedNodeCount = 0;
let lastSavedHash = '';

function autoSave() {
  const els = document.querySelectorAll('.data-box');
  const hash = [...els].map(e => `${e.textContent}|${e.style.left}|${e.style.top}`).join(',');
  if (hash !== lastSavedHash && els.length > 0) {
    lastSavedHash = hash;
    const count = saveWorkspace();
    lastSavedNodeCount = count;
  }
}
setInterval(autoSave, 10000);

// Periodic semantic stats update for HUD
setInterval(() => {
  const learnerEl = document.getElementById('learner-status');
  if (learnerEl) {
    const profile = metaLearner.getUserProfile();
    if (profile) {
      learnerEl.textContent = `${profile.preferredStyle}·${profile.preferredLength}c`;
      learnerEl.style.color = 'rgba(140,220,180,0.8)';
    } else {
      learnerEl.textContent = 'learning...';
      learnerEl.style.color = '';
    }
  }

  const el = document.getElementById('sem-sim-count');
  if (!el) return;
  const dups = semanticSpace.detectDuplicates();
  const clusters = semanticSpace.findClusters(0.70);
  const parts = [];
  if (clusters.length > 0) parts.push(`${clusters.length} clusters`);
  if (dups.length > 0) parts.push(`⚠️${dups.length} dups`);
  el.textContent = parts.join(' ') || '—';
  el.style.color = dups.length > 0 ? 'rgba(255,150,100,0.8)' : '';
}, 15000);

// Check for autosave on load and show toast
const restoredCount = checkAutosave();
if (restoredCount > 0) {
  setTimeout(() => showToast(`📁 ${restoredCount} nodes available — press L to restore`), 1500);
}

// ============================================================
// Multi-Agent Debate (Alt + double-click)
// ============================================================

const AGENT_COLORS = { scientist: '#4ECDC4', philosopher: '#A78BFA', artist: '#FFE66D' };

async function triggerDebate(id) {
  const el = nodes.get(id);
  if (!el) return;
  const keyword = el.textContent?.trim();
  if (!keyword) return;

  const cx = parseFloat(el.style.left) || 0;
  const cy = parseFloat(el.style.top) || 0;

  el.classList.add('debating');
  el.textContent = '🗣️ Debating...';

  try {
    const res = await fetch('/api/debate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, rounds: 2 }),
    });
    if (!res.ok) throw new Error('Debate failed');
    const data = await res.json();
    if (!data.components?.length) throw new Error('No components');

    el.classList.remove('debating');
    el.remove();
    nodes.delete(id);
    physicsDespawn(id);
    memory.recordFracture(keyword, data.components);

    const count = data.components.length;
    const spread = 50 + count * 14;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count;
      const x = cx + Math.cos(angle) * spread;
      const y = cy + Math.sin(angle) * spread;
      const agent = data.perspectives?.[data.components[i]] || 'scientist';
      const childId = createNode(data.components[i], x, y);
      const childEl = nodes.get(childId);
      if (childEl) {
        childEl.classList.add('child', 'enriched');
        childEl.dataset.agent = agent;
        childEl.style.borderColor = AGENT_COLORS[agent] || '#4ECDC4';
        childEl.title = `Agent: ${agent}`;
        physicsApplyImpulse(childId, Math.cos(angle) * 60, Math.sin(angle) * 60);
      }
    }
  } catch (err) {
    console.warn('[Debate] Failed:', err.message);
    el.classList.remove('debating');
    el.textContent = keyword;
  }
}

// ============================================================
// Analogical Reasoning (A:B::C:?)
// ============================================================

let analogyMode = false;
let analogySlots = { a: null, b: null, c: null };

function enterAnalogyMode() {
  analogyMode = true;
  analogySlots = { a: null, b: null, c: null };
  highlightAnalogySlots();
  showToast('🔗 Analogy mode: click 3 nodes (A, B, C) — Esc to cancel');
}

function exitAnalogyMode() {
  analogyMode = false;
  analogySlots = { a: null, b: null, c: null };
  for (const el of document.querySelectorAll('.analogy-slot')) el.remove();
  showToast('Analogy mode cancelled');
}

function highlightAnalogySlots() {
  for (const el of document.querySelectorAll('.analogy-slot')) el.remove();
  // Show floating hints near empty slot positions
  const cx = window.innerWidth / 2;
  const positions = [
    { x: cx - 200, y: 60, label: 'A' },
    { x: cx - 80, y: 60, label: 'B' },
    { x: cx + 80, y: 60, label: 'C' },
    { x: cx + 200, y: 60, label: '?' },
  ];
  let idx = 0;
  if (analogySlots.a) idx++;
  if (analogySlots.b) idx++;
  if (analogySlots.c) idx++;
  // Show only the next needed slot
  if (idx < 3) {
    const slot = positions[idx];
    const el = document.createElement('div');
    el.className = 'analogy-slot';
    el.textContent = slot.label;
    el.style.cssText = `position:fixed;left:${slot.x}px;top:${slot.y}px;z-index:500;pointer-events:none;font-size:18px;color:rgba(140,200,255,0.5);font-family:monospace;transform:translate(-50%,-50%);`;
    document.body.appendChild(el);
  }
}

async function completeAnalogy() {
  if (!analogySlots.a || !analogySlots.b || !analogySlots.c) return;

  const elA = nodes.get(analogySlots.a);
  const elB = nodes.get(analogySlots.b);
  const elC = nodes.get(analogySlots.c);
  const a = elA?.textContent?.trim() || '';
  const b = elB?.textContent?.trim() || '';
  const c = elC?.textContent?.trim() || '';
  if (!a || !b || !c) { exitAnalogyMode(); return; }

  // Show loading on C
  elC.classList.add('enriching');
  elC.textContent = '🤔 Computing...';

  try {
    const res = await fetch('/api/analogy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a, b, c }),
    });
    if (!res.ok) throw new Error('Analogy failed');
    const data = await res.json();
    const answer = data.answer || '?';

    elC.classList.remove('enriching');
    elC.textContent = c;

    // Compute position for result: parallelogram completion
    const ax = parseFloat(elA.style.left) || 0, ay = parseFloat(elA.style.top) || 0;
    const bx = parseFloat(elB.style.left) || 0, by = parseFloat(elB.style.top) || 0;
    const dx = parseFloat(elC.style.left) || 0, dy = parseFloat(elC.style.top) || 0;
    // D = C + (B - A) → parallelogram
    const rx = dx + (bx - ax);
    const ry = dy + (by - ay);

    const resultId = createNode(answer, rx, ry);
    const resultEl = nodes.get(resultId);
    if (resultEl) {
      resultEl.classList.add('analogy-result', 'enriched');
      resultEl.title = `Relationship: ${data.relationship}\nConfidence: ${((data.confidence||0.5)*100).toFixed(0)}%`;
      resultEl.dataset.analogyA = String(analogySlots.a);
      resultEl.dataset.analogyB = String(analogySlots.b);
      resultEl.dataset.analogyC = String(analogySlots.c);
      resultEl.dataset.relationship = data.relationship || '';

      // Highlight source nodes
      for (const id of [analogySlots.a, analogySlots.b, analogySlots.c]) {
        const el = nodes.get(id);
        if (el) { el.classList.add('analogy-source'); setTimeout(() => el.classList.remove('analogy-source'), 3000); }
      }
    }
  } catch { /* fail silently */ }
  exitAnalogyMode();
}

// Reverse explanation: Shift+click on analogy result
async function explainAnalogy(el) {
  const aId = Number(el.dataset.analogyA);
  const bId = Number(el.dataset.analogyB);
  const cId = Number(el.dataset.analogyC);
  const a = nodes.get(aId)?.textContent?.trim() || '';
  const b = nodes.get(bId)?.textContent?.trim() || '';
  const c = nodes.get(cId)?.textContent?.trim() || '';
  const answer = el.textContent?.trim() || '';

  el.classList.add('enriching');
  try {
    const res = await fetch('/api/analogy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a, b, c, answer, explain: true }),
    });
    if (res.ok) {
      const data = await res.json();
      const tooltip = document.createElement('div');
      tooltip.className = 'node-tooltip';
      tooltip.innerHTML = `<div><span class="tt-label">Why</span> <span class="tt-val">${eschtml(data.explanation || a + ':' + b + '::' + c + ':' + answer)}</span></div><div><span class="tt-label">Relationship</span> <span class="tt-val">${eschtml(data.relationship || '—')}</span></div>`;
      const rect = el.getBoundingClientRect();
      tooltip.style.left = rect.left + 'px';
      tooltip.style.top = (rect.top - 60) + 'px';
      document.body.appendChild(tooltip);
      setTimeout(() => tooltip.remove(), 4000);
    }
  } catch {}
  el.classList.remove('enriching');
}

// Intercept clicks during analogy mode
workspace.addEventListener('click', (e) => {
  if (!analogyMode) return;
  const box = e.target.closest('.data-box');
  if (!box) return;
  const id = Number(box.dataset.id);

  if (!analogySlots.a) {
    analogySlots.a = id;
    box.style.boxShadow = '0 0 16px rgba(100,200,255,0.5)';
  } else if (!analogySlots.b) {
    analogySlots.b = id;
    box.style.boxShadow = '0 0 16px rgba(100,200,255,0.5)';
  } else if (!analogySlots.c) {
    analogySlots.c = id;
    completeAnalogy();
    return;
  }
  highlightAnalogySlots();

  if (analogySlots.a && analogySlots.b && analogySlots.c) {
    completeAnalogy();
  }
}, true);

// Shift+click for reverse explanation on analogy nodes
workspace.addEventListener('click', (e) => {
  if (analogyMode) return;
  if (!e.shiftKey) return;
  const box = e.target.closest('.data-box.analogy-result');
  if (box) { explainAnalogy(box); e.stopPropagation(); }
});

// Cancel analogy mode + dismiss curiosity on Escape
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (analogyMode) { exitAnalogyMode(); return; }
    dismissCurrent();
  }
  touchInput();
});

// Listen for curiosity execution
window.addEventListener('lse-curiosity-execute', (e) => {
  const { type, suggestedNodes } = e.detail;
  if (type === 'merge' && suggestedNodes?.length >= 2) {
    // Find nodes matching suggested keywords and merge them
    let idA, idB;
    for (const [id, el] of nodes) {
      const kw = el.textContent?.trim();
      if (!idA && kw === suggestedNodes[0]) idA = id;
      else if (!idB && kw === suggestedNodes[1]) idB = id;
    }
    if (idA && idB) mergeNodes(idA, idB);
  } else if (type === 'fracture' && suggestedNodes?.length >= 1) {
    for (const [id, el] of nodes) {
      if (el.textContent?.trim() === suggestedNodes[0]) { fractureNode(id); break; }
    }
  } else if (type === 'explore' && suggestedNodes?.length >= 2) {
    // Highlight both nodes briefly
    for (const [id, el] of nodes) {
      if (suggestedNodes.includes(el.textContent?.trim())) {
        el.classList.add('analogy-source');
        setTimeout(() => el.classList.remove('analogy-source'), 3000);
      }
    }
  }
});

// Listen for tension resolution
window.addEventListener('lse-tension-resolved', (e) => {
  const { synthesis, x, y, explanation, confidence } = e.detail;
  const id = createNode(synthesis, x, y);
  const el = nodes.get(id);
  if (el) {
    el.classList.add('merged-flash', 'enriched');
    el.title = `🔄 Dialectical synthesis\n${explanation || ''}`;
    el.dataset.confidence = String(confidence || 0.7);
    el.style.setProperty('--conf-width', `${((confidence || 0.7) * 100).toFixed(0)}%`);
  }
  scheduleTensionAnalysis(nodes);
});

// Start tension pulse animation
startPulseLoop();

// ============================================================
// Keyboard Shortcuts
// ============================================================

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  const key = e.key.toLowerCase();
  if (key === 'r') {
    const nowVisible = toggleVisibility();
    console.log(`[Relations] ${nowVisible ? 'Shown' : 'Hidden'}`);
  }
  if (key === 'f') {
    const cfg = window.__LSE_CONFIG__ || {};
    cfg.enableReflection = !(cfg.enableReflection ?? true);
    showToast(`🪞 Reflection ${cfg.enableReflection ? 'ON' : 'OFF'}`);
  }
  if (key === 'm') {
    const nowMuted = toggleMute();
    console.log(`[Audio] ${nowMuted ? 'Muted' : 'Unmuted'}`);
  }
  if (key === 's') {
    const count = saveWorkspace();
    showToast(`💾 Saved ${count} nodes`);
  }
  if (key === 'l') {
    // Show file load dialog
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = await importFromJSON(file);
        const count = loadWorkspace(data, createNode);
        showToast(`📂 Loaded ${count} nodes`);
      } catch (err) {
        showToast(`❌ ${err.message}`);
      }
    };
    input.click();
  }
  if (key === 'x') {
    if (!confirm('Clear entire workspace? This cannot be undone.')) return;
    for (const el of document.querySelectorAll('.data-box')) el.remove();
    for (const [id] of nodes) { nodes.delete(id); physicsDespawn(id); }
    showToast('🗑️ Workspace cleared');
  }
  if (key === 'a') {
    enterAnalogyMode();
  }
  if (key === 'h') {
    toggleHierarchyView();
  }
  if (key === 'c') {
    autoCluster();
  }
});

// ---- Hierarchy View ('H' key) ----

let hierarchyActive = false;
let savedPositions = [];

function toggleHierarchyView() {
  hierarchyActive = !hierarchyActive;
  if (hierarchyActive) {
    savedPositions = [];
    const levels = {};
    let maxLevel = 0;

    // Group nodes by ontology level (most general = lowest level number from bottom)
    for (const [id, el] of nodes) {
      const keyword = el.textContent?.trim() || '';
      const chain = ontology.getParentChain(keyword);
      const level = chain.length - 1; // 0 = most specific, N = most general
      savedPositions.push({ id, x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, level });
      if (!levels[level]) levels[level] = [];
      levels[level].push(el);
      if (level > maxLevel) maxLevel = level;
    }

    // Arrange: most general at top (y=100), most specific at bottom (y=h-200)
    const spacing = Math.min(80, (window.innerHeight - 300) / Math.max(1, maxLevel));
    for (let lvl = maxLevel; lvl >= 0; lvl--) {
      const items = levels[lvl] || [];
      const y = 100 + (maxLevel - lvl) * spacing;
      const itemSpacing = window.innerWidth / Math.max(1, items.length + 1);
      items.forEach((el, i) => {
        el.style.transition = 'left 0.6s ease, top 0.6s ease';
        el.style.left = (itemSpacing * (i + 1)) + 'px';
        el.style.top = y + 'px';
      });
    }

    showToast('📊 Hierarchy view — press H to return');
  } else {
    // Restore saved positions
    for (const saved of savedPositions) {
      const el = nodes.get(saved.id);
      if (el) {
        el.style.transition = 'left 0.6s ease, top 0.6s ease';
        el.style.left = saved.x + 'px';
        el.style.top = saved.y + 'px';
      }
    }
    showToast('📍 Free-floating mode');
  }
}

// ---- Auto-Cluster: move similar nodes closer together ----

async function autoCluster() {
  const clusters = semanticSpace.findClusters(0.70);
  if (clusters.length === 0) {
    showToast('📊 No semantic clusters detected');
    return;
  }
  showToast(`📊 ${clusters.length} cluster(s) found — grouping...`);

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;
    // Compute centroid
    let cx = 0, cy = 0;
    for (const id of cluster) {
      const el = nodes.get(id);
      if (!el) continue;
      cx += parseFloat(el.style.left) || 0;
      cy += parseFloat(el.style.top) || 0;
    }
    cx /= cluster.length;
    cy /= cluster.length;

    // Spread around centroid
    const spread = 60 + cluster.length * 10;
    for (let i = 0; i < cluster.length; i++) {
      const el = nodes.get(cluster[i]);
      if (!el) continue;
      const angle = (Math.PI * 2 * i) / cluster.length;
      const x = cx + Math.cos(angle) * spread;
      const y = cy + Math.sin(angle) * spread;
      el.style.transition = 'left 0.8s cubic-bezier(0.25,0.1,0.25,1), top 0.8s cubic-bezier(0.25,0.1,0.25,1)';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      updatePosCache?.(cluster[i], x, y);
      if (physicsEngine) physicsSetPosition(cluster[i], x, y);
    }
  }

  // Check duplicates
  const dups = semanticSpace.detectDuplicates();
  if (dups.length > 0) {
    setTimeout(() => showToast(`⚠️ ${dups.length} near-duplicate pair(s) detected`), 1500);
  }
}

// ---- Drag: highlight top-3 semantically similar nodes ----

let similarHighlights = [];

async function highlightSimilarNodes(draggedId) {
  clearSimilarHighlights();
  const nearest = semanticSpace.findNearest(draggedId, 3);
  for (const { id, similarity } of nearest) {
    if (similarity < 0.3) continue;
    const el = nodes.get(id);
    if (el) {
      el.classList.add('semantic-similar');
      el.style.setProperty('--sim-glow', `${(similarity * 0.4).toFixed(2)}`);
      similarHighlights.push(el);
    }
  }
}

function clearSimilarHighlights() {
  for (const el of similarHighlights) {
    el.classList.remove('semantic-similar');
    el.style.removeProperty('--sim-glow');
  }
  similarHighlights = [];
}

// ============================================================
// Double-Click: Create / Fracture / Deep Fracture (Shift)
// ============================================================

workspace.addEventListener('dblclick', (e) => {
  const box = e.target.closest('.data-box');
  if (box) {
    const id = Number(box.dataset.id);
    if (e.altKey) {
      // Alt+double-click → multi-agent debate
      triggerDebate(id);
    } else if (e.shiftKey) {
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

// ---- Rating Buttons (thumbs up/down) ----

function addRatingButtons(el) {
  const container = document.createElement('span');
  container.className = 'rating-btns';
  container.innerHTML = `<button class="rb-up" title="Good result">👍</button><button class="rb-down" title="Poor result">👎</button>`;
  container.style.cssText = 'position:absolute;top:-8px;right:-4px;display:none;gap:2px;z-index:10;';
  el.style.position = el.style.position || 'absolute'; // ensure relative positioning
  el.appendChild(container);

  const id = Number(el.dataset.id);
  const keyword = el.textContent?.trim() || '';
  let components = [];
  try { components = JSON.parse(el.dataset.components || '[]'); } catch {}

  container.querySelector('.rb-up').onclick = (e) => {
    e.stopPropagation();
    metaLearner.rate(id, keyword, 'enrich', components, 1);
    container.style.display = 'none';
    el.classList.add('rated');
  };
  container.querySelector('.rb-down').onclick = (e) => {
    e.stopPropagation();
    metaLearner.rate(id, keyword, 'enrich', components, -1);
    container.style.display = 'none';
    el.classList.add('rated');
  };

  el.addEventListener('mouseenter', () => {
    if (!el.classList.contains('rated')) container.style.display = 'flex';
  });
  el.addEventListener('mouseleave', () => {
    container.style.display = 'none';
  });
}

// ============================================================
// Hover Tooltip (shows after 500ms hover on a node)
// ============================================================

let tooltipEl = null;
let tooltipTimer = null;

function showTooltip(el, e) {
  hideTooltip();
  playHover();
  tooltipTimer = setTimeout(() => {
    const label = el.textContent?.trim() || '…';
    const hasComponents = el.dataset.components ? JSON.parse(el.dataset.components).length : 0;
    const conf = el.dataset.confidence ? `${(parseFloat(el.dataset.confidence) * 100).toFixed(0)}%` : '—';
    const created = el.dataset.created || '—';

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'node-tooltip';
    tooltipEl.innerHTML = `
      <div><span class="tt-label">Keyword</span> <span class="tt-val">${eschtml(label)}</span></div>
      <div><span class="tt-label">Components</span> <span class="tt-val">${hasComponents}</span></div>
      <div><span class="tt-label">Confidence</span> <span class="tt-val">${conf}</span></div>
      <div><span class="tt-label">Created</span> <span class="tt-val">${created}</span></div>
    `;
    tooltipEl.style.left = (e.clientX + 16) + 'px';
    tooltipEl.style.top = (e.clientY - 10) + 'px';
    document.body.appendChild(tooltipEl);
  }, 500);
}

function hideTooltip() {
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
}

function eschtml(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

workspace.addEventListener('mouseover', (e) => {
  const box = e.target.closest('.data-box');
  if (box && box !== dragTarget) showTooltip(box, e);
});
workspace.addEventListener('mouseout', (e) => {
  if (e.target.closest('.data-box')) hideTooltip();
});
workspace.addEventListener('mousemove', (e) => {
  if (tooltipEl && !dragTarget) {
    tooltipEl.style.left = (e.clientX + 16) + 'px';
    tooltipEl.style.top = (e.clientY - 10) + 'px';
  }
});

window.lse = {
  createNode,
  fractureNode,
  deepFracture,
  triggerDebate,
  mergeNodes,
  refreshSuggestions,
  startSuggestions,
  stopSuggestions,
  getNodes() { return nodes; },
  getNodeCount() { return nodes.size; },
  get memory() { return memory; },
};
