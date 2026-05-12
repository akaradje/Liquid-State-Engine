/**
 * Liquid-State Engine - JavaScript Host Layer
 *
 * This module handles:
 * 1. Canvas setup and fullscreen management
 * 2. Loading the WebAssembly module
 * 3. Reading the pixel buffer from Wasm memory and painting to Canvas
 * 4. Input event capture (mouse/touch) and forwarding to Wasm
 * 5. The main render loop (requestAnimationFrame)
 * 6. Payload registry + rule engine integration
 * 7. Draw mode, drag-and-drop data ingestion
 */

import { PayloadRegistry } from './payload.js';
import * as rules from './rules.js';

// ============================================================
// Configuration
// ============================================================
const MAX_NODES = 10000;
const SPAWN_BATCH = 50;
const INITIAL_NODES = 200;

// ============================================================
// Canvas Setup
// ============================================================
const canvas = document.getElementById('liquid-canvas');
const ctx = canvas.getContext('2d', {
  willReadFrequently: true,
  alpha: false
});

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ============================================================
// HUD Elements
// ============================================================
const hudFps = document.getElementById('fps');
const hudNodes = document.getElementById('nodes');
const hudDirty = document.getElementById('dirty');
const hudStatus = document.getElementById('status');

// ============================================================
// Engine State
// ============================================================
let engine = null;
let wasmMemory = null;
let running = false;
let lastTime = 0;
let frameCount = 0;
let fpsTimer = 0;
let currentFps = 0;

// Interaction state
let isDragging = false;
let dragNodeId = null;
let mouseX = 0;
let mouseY = 0;

// Draw mode
let drawMode = false;
let drawPath = [];
let pickedNodeId = null;

// Payload
const payloads = new PayloadRegistry();

// ============================================================
// Wasm Loading
// ============================================================
async function initEngine() {
  try {
    hudStatus.textContent = 'loading wasm...';

    const wasm = await import('../pkg/liquid_state_engine.js');
    await wasm.default();

    hudStatus.textContent = 'initializing...';

    engine = new wasm.LiquidEngine(canvas.width, canvas.height, MAX_NODES);
    wasmMemory = wasm.__wasm.memory;

    spawnInitialNodes();

    hudStatus.textContent = 'ACTIVE';
    running = true;
    lastTime = performance.now();
    requestAnimationFrame(gameLoop);

  } catch (err) {
    hudStatus.textContent = `ERROR: ${err.message}`;
    console.error('Engine init failed:', err);
    console.log('Running in DEMO mode (no Wasm)');
    hudStatus.textContent = 'DEMO MODE (no Wasm)';
    runDemoMode();
  }
}

// ============================================================
// Node Spawning
// ============================================================
function spawnNodeWithPayload(px, py, vx, vy, bitmask, radius, payload) {
  if (!engine) return null;
  const colors = getColorFromBitmask(bitmask);
  const id = engine.spawn_node(px, py, vx, vy, colors[0], colors[1], colors[2], 255, bitmask, radius);
  if (id !== 0xFFFFFFFF) {
    payloads.register(id, payload);
  }
  return id;
}

function makeRandomPayload() {
  const types = ['text', 'number', 'json', 'array'];
  const t = types[Math.floor(Math.random() * types.length)];
  switch (t) {
    case 'text': return { type: 'text', value: words[Math.floor(Math.random() * words.length)], label: 'word' };
    case 'number': return { type: 'number', value: Math.floor(Math.random() * 1000), label: 'num' };
    case 'json': return { type: 'json', value: { x: Math.floor(Math.random() * 100), y: Math.floor(Math.random() * 100) }, label: 'point' };
    case 'array': return { type: 'array', value: Array.from({ length: 3 }, () => Math.floor(Math.random() * 100)), label: 'arr' };
    default: return { type: 'number', value: 0 };
  }
}

const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma',
  'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega', 'hello', 'world', 'liquid', 'state'];

function spawnInitialNodes() {
  const w = canvas.width;
  const h = canvas.height;

  for (let i = 0; i < INITIAL_NODES; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const vx = (Math.random() - 0.5) * 60;
    const vy = (Math.random() - 0.5) * 60;
    const bitmask = 1 << Math.floor(Math.random() * 7);
    const radius = 4 + Math.random() * 8;
    const payload = makeRandomPayload();
    spawnNodeWithPayload(x, y, vx, vy, bitmask, radius, payload);
  }
}

function spawnNodesAtPosition(px, py, count) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const spread = 20 + Math.random() * 30;
    const x = px + Math.cos(angle) * spread;
    const y = py + Math.sin(angle) * spread;
    const vx = Math.cos(angle) * (40 + Math.random() * 60);
    const vy = Math.sin(angle) * (40 + Math.random() * 60);
    const bitmask = 1 << Math.floor(Math.random() * 7);
    const radius = 4 + Math.random() * 8;
    const payload = makeRandomPayload();
    spawnNodeWithPayload(x, y, vx, vy, bitmask, radius, payload);
  }
}

// ============================================================
// Event Processing (Wasm → Payload Registry)
// ============================================================
function processWasmEvents() {
  const count = engine.event_count();
  if (count === 0) return [];

  const ptr = engine.event_ptr();
  const u32 = new Uint32Array(wasmMemory.buffer, ptr, count);
  // Copy to avoid mutation during rule processing
  const copy = new Uint32Array(u32);

  const decoded = payloads.decodeEvents(copy);
  payloads.applyEvents(decoded, rules);
  engine.drain_events();

  // Dispatch to HUD if available
  if (decoded.length > 0) {
    window.dispatchEvent(new CustomEvent('lse-events', { detail: decoded }));
  }
  return decoded;
}

// ============================================================
// Main Game Loop
// ============================================================
function gameLoop(timestamp) {
  if (!running) return;

  const dt = Math.min((timestamp - lastTime) / 1000, 0.033);
  lastTime = timestamp;

  frameCount++;
  fpsTimer += dt;
  if (fpsTimer >= 1.0) {
    currentFps = frameCount;
    frameCount = 0;
    fpsTimer = 0;
    hudFps.textContent = currentFps;
    hudNodes.textContent = engine.node_count();
  }

  // Update pinned drag spring target
  if (isDragging && dragNodeId !== null && dragNodeId !== 0xFFFFFFFF) {
    engine.update_pin_target(dragNodeId, mouseX, mouseY);
  }

  // Tick the engine
  engine.tick(dt);

  // Process events from Wasm
  processWasmEvents();

  // Read pixel buffer
  if (engine.has_dirty_region()) {
    drawPixelBuffer();
    engine.clear_dirty();
  }

  requestAnimationFrame(gameLoop);
}

// ============================================================
// Pixel Buffer -> Canvas Transfer
// ============================================================
function drawPixelBuffer() {
  const ptr = engine.pixel_buffer_ptr();
  const len = engine.pixel_buffer_len();

  const dirtyPtr = engine.dirty_rect_ptr();
  const dirtyView = new Uint32Array(wasmMemory.buffer, dirtyPtr, 4);
  const [dx, dy, dw, dh] = dirtyView;

  if (dw === 0 || dh === 0) return;

  hudDirty.textContent = `${dw}x${dh}`;

  const fullBuffer = new Uint8ClampedArray(wasmMemory.buffer, ptr, len);
  const w = canvas.width;

  const regionData = new ImageData(dw, dh);
  for (let row = 0; row < dh; row++) {
    const srcStart = ((dy + row) * w + dx) * 4;
    const dstStart = row * dw * 4;
    regionData.data.set(
      fullBuffer.subarray(srcStart, srcStart + dw * 4),
      dstStart
    );
  }

  ctx.putImageData(regionData, dx, dy);

  // If in draw mode, overlay the trail path on canvas
  if (drawMode && drawPath.length > 1) {
    ctx.beginPath();
    ctx.moveTo(drawPath[0].x, drawPath[0].y);
    for (let i = 1; i < drawPath.length; i++) {
      ctx.lineTo(drawPath[i].x, drawPath[i].y);
    }
    ctx.strokeStyle = 'rgba(100,200,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// ============================================================
// Draw Mode Helpers
// ============================================================
function finalizeDrawPath() {
  if (drawPath.length < 3) {
    drawPath = [];
    return;
  }

  // Compute centroid
  let cx = 0, cy = 0;
  for (const p of drawPath) { cx += p.x; cy += p.y; }
  cx /= drawPath.length;
  cy /= drawPath.length;

  // Compute bounding circle radius
  let maxDist = 20;
  for (const p of drawPath) {
    const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
    if (d > maxDist) maxDist = d;
  }

  const bitmask = 1 << Math.floor(Math.random() * 7);
  const id = spawnNodeWithPayload(cx, cy, 0, 0, bitmask, maxDist, { type: 'text', value: '', label: '' });

  // Notify HUD to open label/payload dialog
  if (id !== null) {
    window.dispatchEvent(new CustomEvent('lse-drawnode', { detail: { id, x: cx, y: cy } }));
  }

  drawPath = [];
}

// ============================================================
// Drag-and-Drop
// ============================================================
let dropTargetId = null;

canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  const x = e.clientX;
  const y = e.clientY;

  // Try to read files first
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result;
      const payload = rules.detectPayload(content);
      const bitmask = 1 << Math.floor(Math.random() * 7);
      spawnNodeWithPayload(x, y, 0, 0, bitmask, 20 + Math.random() * 10, payload);
    };
    reader.readAsText(file);
    return;
  }

  // Try to read text data
  const text = e.dataTransfer.getData('text/plain');
  if (text) {
    const payload = rules.detectPayload(text);
    const bitmask = 1 << Math.floor(Math.random() * 7);
    spawnNodeWithPayload(x, y, 0, 0, bitmask, 20 + Math.random() * 10, payload);
  }
});

// ============================================================
// Input Handling
// ============================================================
canvas.addEventListener('mousedown', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;

  if (!engine) return;

  if (drawMode) {
    drawPath = [{ x: mouseX, y: mouseY }];
    return;
  }

  dragNodeId = engine.pick_node_at(mouseX, mouseY);

  if (dragNodeId !== 0xFFFFFFFF) {
    isDragging = true;
    engine.pin_node(dragNodeId, mouseX, mouseY);
    pickedNodeId = dragNodeId;
    const payload = payloads.get(dragNodeId);
    window.dispatchEvent(new CustomEvent('lse-pick', { detail: { id: dragNodeId, payload } }));
  } else {
    spawnNodesAtPosition(mouseX, mouseY, SPAWN_BATCH);
    pickedNodeId = null;
    window.dispatchEvent(new CustomEvent('lse-pick', { detail: { id: null, payload: null } }));
  }
});

canvas.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;

  if (drawMode && drawPath.length > 0) {
    drawPath.push({ x: mouseX, y: mouseY });
  }
});

canvas.addEventListener('mouseup', () => {
  if (drawMode && drawPath.length > 0) {
    finalizeDrawPath();
  }

  if (isDragging && dragNodeId !== null && dragNodeId !== 0xFFFFFFFF) {
    engine.unpin_node(dragNodeId);
    // Check if dragged onto another node (merge trigger)
    const targetId = engine.pick_node_at(mouseX, mouseY);
    if (targetId !== 0xFFFFFFFF && targetId !== dragNodeId) {
      // Nodes are close — let physics merge handle it
    }
  }
  isDragging = false;
  dragNodeId = null;
});

canvas.addEventListener('dblclick', (e) => {
  if (!engine) return;
  const id = engine.pick_node_at(e.clientX, e.clientY);
  if (id !== 0xFFFFFFFF) {
    engine.fracture_node(id);
  }
});

// Touch support
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  mouseX = touch.clientX;
  mouseY = touch.clientY;

  if (!engine) return;

  if (drawMode) {
    drawPath = [{ x: mouseX, y: mouseY }];
    return;
  }

  dragNodeId = engine.pick_node_at(mouseX, mouseY);
  if (dragNodeId !== 0xFFFFFFFF) {
    isDragging = true;
    engine.pin_node(dragNodeId, mouseX, mouseY);
  } else {
    spawnNodesAtPosition(mouseX, mouseY, SPAWN_BATCH);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  mouseX = touch.clientX;
  mouseY = touch.clientY;

  if (drawMode && drawPath.length > 0) {
    drawPath.push({ x: mouseX, y: mouseY });
  }
}, { passive: false });

canvas.addEventListener('touchend', () => {
  if (drawMode && drawPath.length > 0) {
    finalizeDrawPath();
  }
  if (isDragging && dragNodeId !== null && dragNodeId !== 0xFFFFFFFF) {
    engine.unpin_node(dragNodeId);
  }
  isDragging = false;
  dragNodeId = null;
});

// ============================================================
// Mode & Config API (for HUD)
// ============================================================
window.lse = {
  setDrawMode(on) { drawMode = on; },
  getDrawMode() { return drawMode; },
  getEngine() { return engine; },
  getPayloads() { return payloads; },
  getRules() { return rules; },
  getPickedNodeId() { return pickedNodeId; },
  spawnNode(x, y, payload) {
    const bitmask = 1 << Math.floor(Math.random() * 7);
    return spawnNodeWithPayload(x, y, 0, 0, bitmask, 12 + Math.random() * 8, payload);
  },
  setViscosity(v) { if (engine) engine.set_viscosity(v); },
  setGravity(g) { if (engine) engine.set_gravity(g); },
};

// ============================================================
// Color Utility
// ============================================================
const BIT_COLORS = [
  [255, 60, 60], [60, 255, 60], [60, 100, 255],
  [255, 255, 60], [255, 60, 255], [60, 255, 255],
  [255, 160, 60], [200, 130, 255],
];

function getColorFromBitmask(mask) {
  let r = 0, g = 0, b = 0, count = 0;
  for (let bit = 0; bit < 8; bit++) {
    if (mask & (1 << bit)) {
      r += BIT_COLORS[bit][0];
      g += BIT_COLORS[bit][1];
      b += BIT_COLORS[bit][2];
      count++;
    }
  }
  if (count === 0) return [128, 128, 128];
  return [Math.floor(r / count), Math.floor(g / count), Math.floor(b / count)];
}

// ============================================================
// Demo Mode
// ============================================================
function runDemoMode() {
  const nodes = [];
  const w = canvas.width;
  const h = canvas.height;

  for (let i = 0; i < INITIAL_NODES; i++) {
    const bitmask = 1 << Math.floor(Math.random() * 7);
    const colors = getColorFromBitmask(bitmask);
    nodes.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60,
      r: 4 + Math.random() * 8,
      color: `rgb(${colors[0]}, ${colors[1]}, ${colors[2]})`,
    });
  }

  function demoLoop() {
    ctx.fillStyle = 'rgba(10, 10, 20, 0.15)';
    ctx.fillRect(0, 0, w, h);
    for (const n of nodes) {
      n.vx *= 0.98; n.vy *= 0.98;
      n.x += n.vx * 0.016; n.y += n.vy * 0.016;
      if (n.x < n.r || n.x > w - n.r) n.vx *= -0.7;
      if (n.y < n.r || n.y > h - n.r) n.vy *= -0.7;
      n.x = Math.max(n.r, Math.min(w - n.r, n.x));
      n.y = Math.max(n.r, Math.min(h - n.r, n.y));
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
    }
    requestAnimationFrame(demoLoop);
  }
  requestAnimationFrame(demoLoop);
}

// ============================================================
// Bootstrap
// ============================================================
initEngine();
