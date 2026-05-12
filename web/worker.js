/**
 * Liquid-State Engine — Web Worker
 *
 * Owns the Wasm engine instance and runs the simulation loop.
 * Communicates with the main thread via postMessage.
 *
 * Architecture:
 * - SharedArrayBuffer path: pixel data is written into a shared buffer,
 *   synchronized via Atomics.wait/notify.
 * - Transfer path (fallback): pixel data is copied and transferred
 *   via postMessage each frame.
 */

// ---- State ----
let engine = null;
let wasmMemory = null;
let canvasWidth = 0;
let canvasHeight = 0;
let maxNodes = 10000;
let running = false;
let lastTime = 0;

// Shared buffer
let sharedPixelBuffer = null;   // Uint8ClampedArray view of SAB
let sharedControlBuffer = null; // Int32Array view of control SAB
// Control layout: [0] = frame_ready flag, [1] = buffer_size
const CTRL_READY = 0;
const CTRL_SIZE = 1;
let useSharedBuffer = false;

// ---- Message Handler ----
self.onmessage = async function(e) {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      canvasWidth = msg.width;
      canvasHeight = msg.height;
      maxNodes = msg.maxNodes || 10000;

      // Check for SharedArrayBuffer support
      if (msg.sharedPixelBuffer && msg.sharedControlBuffer) {
        useSharedBuffer = true;
        sharedPixelBuffer = new Uint8ClampedArray(msg.sharedPixelBuffer);
        sharedControlBuffer = new Int32Array(msg.sharedControlBuffer);
      }

      try {
        const wasm = await import('./pkg/liquid_state_engine.js');
        await wasm.default();
        engine = new wasm.LiquidEngine(canvasWidth, canvasHeight, maxNodes);
        wasmMemory = wasm.__wasm.memory;
        running = true;
        lastTime = performance.now();
        self.postMessage({ type: 'ready' });
        tickLoop();
      } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
      }
      break;
    }

    case 'tick': {
      // Advance one frame (used for transfer-mode frame pacing)
      if (engine && running && !useSharedBuffer) {
        const dt = Math.min((performance.now() - lastTime) / 1000, 0.033);
        lastTime = performance.now();
        tickFrame(dt);
      }
      break;
    }

    case 'spawn': {
      if (engine) {
        engine.spawn_node(msg.x, msg.y, msg.vx, msg.vy, msg.r, msg.g, msg.b, msg.a, msg.bitmask, msg.radius);
      }
      break;
    }

    case 'remove': {
      if (engine) engine.remove_node(msg.id);
      break;
    }

    case 'apply_force': {
      if (engine) engine.apply_force(msg.id, msg.fx, msg.fy);
      break;
    }

    case 'fracture': {
      if (engine) engine.fracture_node(msg.id);
      break;
    }

    case 'pin_node': {
      if (engine) engine.pin_node(msg.id, msg.cursorX, msg.cursorY);
      break;
    }

    case 'unpin_node': {
      if (engine) engine.unpin_node(msg.id);
      break;
    }

    case 'update_pin': {
      if (engine) engine.update_pin_target(msg.id, msg.cursorX, msg.cursorY);
      break;
    }

    case 'pick': {
      if (engine) {
        const id = engine.pick_node_at(msg.x, msg.y);
        self.postMessage({ type: 'pick_result', id });
      }
      break;
    }

    case 'set_viscosity': {
      if (engine) engine.set_viscosity(msg.value);
      break;
    }

    case 'set_gravity': {
      if (engine) engine.set_gravity(msg.value);
      break;
    }

    case 'stop': {
      running = false;
      break;
    }
  }
};

// ---- Worker Tick Loop (for SharedArrayBuffer mode) ----
function tickLoop() {
  if (!running || !useSharedBuffer) return;

  function step() {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.033);
    lastTime = now;

    tickFrame(dt);

    // Signal main thread that frame is ready
    Atomics.store(sharedControlBuffer, CTRL_READY, 1);
    Atomics.notify(sharedControlBuffer, CTRL_READY, 1);

    // Throttle to ~60fps (schedule next tick)
    setTimeout(step, 12); // ~16ms - computation time
  }

  lastTime = performance.now();
  step();
}

// ---- Frame Tick ----
function tickFrame(dt) {
  if (!engine) return;

  engine.tick(dt);

  // Copy pixel buffer to shared or transfer buffer
  if (engine.has_dirty_region()) {
    const ptr = engine.pixel_buffer_ptr();
    const len = engine.pixel_buffer_len();
    const dirtyPtr = engine.dirty_rect_ptr();

    if (useSharedBuffer && sharedPixelBuffer && sharedControlBuffer) {
      // Copy dirty rect metadata and pixel data into shared buffers
      const dirtyView = new Uint32Array(wasmMemory.buffer, dirtyPtr, 4);
      // Store dirty rect in control buffer at indices 2-5
      for (let i = 0; i < 4; i++) {
        sharedControlBuffer[2 + i] = dirtyView[i];
      }

      // Copy full pixel buffer into shared buffer (fast memcpy)
      const src = new Uint8ClampedArray(wasmMemory.buffer, ptr, len);
      if (len <= sharedPixelBuffer.length) {
        sharedPixelBuffer.set(src);
      }

      engine.clear_dirty();

      // Don't postMessage — main thread polls via Atomics.wait
    } else {
      // Transfer path: copy pixel data and send via postMessage
      const pixelCopy = new Uint8ClampedArray(wasmMemory.buffer.slice(ptr, ptr + len));
      const dirtyView = new Uint32Array(wasmMemory.buffer, dirtyPtr, 4);
      const dirty = [dirtyView[0], dirtyView[1], dirtyView[2], dirtyView[3]];

      engine.clear_dirty();

      self.postMessage({
        type: 'frame',
        pixels: pixelCopy.buffer,
        dirty: dirty,
        width: canvasWidth,
        height: canvasHeight,
        nodeCount: engine.node_count(),
      }, [pixelCopy.buffer]);
    }
  }

  // Events
  const eventCount = engine.event_count();
  if (eventCount > 0) {
    const evtPtr = engine.event_ptr();
    const events = new Uint32Array(wasmMemory.buffer.slice(evtPtr, evtPtr + eventCount * 4));
    engine.drain_events();
    self.postMessage({ type: 'events', data: new Uint32Array(events) });
  }
}
