/**
 * Liquid-State Engine - JavaScript Host Layer
 * 
 * This module handles:
 * 1. Canvas setup and fullscreen management
 * 2. Loading the WebAssembly module
 * 3. Reading the pixel buffer from Wasm memory and painting to Canvas
 * 4. Input event capture (mouse/touch) and forwarding to Wasm
 * 5. The main render loop (requestAnimationFrame)
 * 6. SharedArrayBuffer setup for future Web Worker integration
 */

// ============================================================
// Configuration
// ============================================================
const MAX_NODES = 10000;
const SPAWN_BATCH = 50;       // Nodes to spawn on click
const INITIAL_NODES = 200;    // Starting node count

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
let engine = null;       // Wasm LiquidEngine instance
let wasmMemory = null;   // Wasm linear memory
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
let prevMouseX = 0;
let prevMouseY = 0;

// ============================================================
// Wasm Loading
// ============================================================
async function initEngine() {
    try {
        hudStatus.textContent = 'loading wasm...';
        
        // Import the wasm-bindgen generated module
        const wasm = await import('../pkg/liquid_state_engine.js');
        await wasm.default();  // Initialize wasm

        hudStatus.textContent = 'initializing...';
        
        // Create engine instance
        engine = new wasm.LiquidEngine(canvas.width, canvas.height, MAX_NODES);
        wasmMemory = wasm.__wasm.memory;

        // Spawn initial nodes
        spawnInitialNodes();

        hudStatus.textContent = 'ACTIVE';
        running = true;
        lastTime = performance.now();
        requestAnimationFrame(gameLoop);

    } catch (err) {
        hudStatus.textContent = `ERROR: ${err.message}`;
        console.error('Engine init failed:', err);
        
        // Fallback: run in demo mode without Wasm
        console.log('Running in DEMO mode (no Wasm)');
        hudStatus.textContent = 'DEMO MODE (no Wasm)';
        runDemoMode();
    }
}

// ============================================================
// Node Spawning
// ============================================================
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
        
        // Color derived from bitmask (matches Rust logic)
        const colors = getColorFromBitmask(bitmask);
        engine.spawn_node(x, y, vx, vy, colors[0], colors[1], colors[2], 255, bitmask, radius);
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
        const colors = getColorFromBitmask(bitmask);
        engine.spawn_node(x, y, vx, vy, colors[0], colors[1], colors[2], 255, bitmask, radius);
    }
}

// ============================================================
// Color Utility (mirrors Rust BIT_COLORS)
// ============================================================
const BIT_COLORS = [
    [255, 60, 60],    // Bit 0: Red
    [60, 255, 60],    // Bit 1: Green
    [60, 100, 255],   // Bit 2: Blue
    [255, 255, 60],   // Bit 3: Yellow
    [255, 60, 255],   // Bit 4: Magenta
    [60, 255, 255],   // Bit 5: Cyan
    [255, 160, 60],   // Bit 6: Orange
    [200, 130, 255],  // Bit 7: Purple
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
// Main Game Loop
// ============================================================
function gameLoop(timestamp) {
    if (!running) return;

    const dt = Math.min((timestamp - lastTime) / 1000, 0.033); // Cap at ~30fps min
    lastTime = timestamp;

    // Update FPS counter
    frameCount++;
    fpsTimer += dt;
    if (fpsTimer >= 1.0) {
        currentFps = frameCount;
        frameCount = 0;
        fpsTimer = 0;
        hudFps.textContent = currentFps;
        hudNodes.textContent = engine.node_count();
    }

    // Apply drag force if active
    if (isDragging && dragNodeId !== null && dragNodeId !== 0xFFFFFFFF) {
        const dx = mouseX - prevMouseX;
        const dy = mouseY - prevMouseY;
        engine.apply_force(dragNodeId, dx * 15, dy * 15);
    }
    prevMouseX = mouseX;
    prevMouseY = mouseY;

    // Tick the engine (physics + collision + render)
    engine.tick(dt);

    // Read pixel buffer from Wasm memory and draw to canvas
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
    
    // Read dirty rectangle
    const dirtyPtr = engine.dirty_rect_ptr();
    const dirtyView = new Uint32Array(wasmMemory.buffer, dirtyPtr, 4);
    const [dx, dy, dw, dh] = dirtyView;

    if (dw === 0 || dh === 0) return;

    hudDirty.textContent = `${dw}x${dh}`;

    // Create ImageData from the dirty region of the pixel buffer
    // For efficiency, we only copy the dirty rectangle portion
    const fullBuffer = new Uint8ClampedArray(wasmMemory.buffer, ptr, len);
    const w = canvas.width;

    // Create a sub-image for just the dirty region
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
}

// ============================================================
// Input Handling
// ============================================================
canvas.addEventListener('mousedown', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    prevMouseX = mouseX;
    prevMouseY = mouseY;

    if (!engine) return;

    // Try to pick a node
    dragNodeId = engine.pick_node_at(mouseX, mouseY);
    
    if (dragNodeId !== 0xFFFFFFFF) {
        isDragging = true;
    } else {
        // Click on empty space: spawn new nodes
        spawnNodesAtPosition(mouseX, mouseY, SPAWN_BATCH);
    }
});

canvas.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
});

canvas.addEventListener('mouseup', () => {
    isDragging = false;
    dragNodeId = null;
});

canvas.addEventListener('dblclick', (e) => {
    if (!engine) return;
    // Double-click: fracture the node under cursor
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
    prevMouseX = mouseX;
    prevMouseY = mouseY;

    if (!engine) return;

    dragNodeId = engine.pick_node_at(mouseX, mouseY);
    if (dragNodeId !== 0xFFFFFFFF) {
        isDragging = true;
    } else {
        spawnNodesAtPosition(mouseX, mouseY, SPAWN_BATCH);
    }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    mouseX = touch.clientX;
    mouseY = touch.clientY;
}, { passive: false });

canvas.addEventListener('touchend', () => {
    isDragging = false;
    dragNodeId = null;
});

// ============================================================
// Demo Mode (runs without Wasm for preview/testing)
// ============================================================
function runDemoMode() {
    // Pure JS fallback that demonstrates the visual concept
    const nodes = [];
    const w = canvas.width;
    const h = canvas.height;

    for (let i = 0; i < INITIAL_NODES; i++) {
        const bitmask = 1 << Math.floor(Math.random() * 7);
        const colors = getColorFromBitmask(bitmask);
        nodes.push({
            x: Math.random() * w,
            y: Math.random() * h,
            vx: (Math.random() - 0.5) * 60,
            vy: (Math.random() - 0.5) * 60,
            r: 4 + Math.random() * 8,
            color: `rgb(${colors[0]}, ${colors[1]}, ${colors[2]})`,
        });
    }

    function demoLoop() {
        ctx.fillStyle = 'rgba(10, 10, 20, 0.15)';
        ctx.fillRect(0, 0, w, h);

        for (const n of nodes) {
            n.vx *= 0.98;
            n.vy *= 0.98;
            n.x += n.vx * 0.016;
            n.y += n.vy * 0.016;

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
