/**
 * Worker-based Engine Adapter
 *
 * Provides the same API as the direct LiquidEngine but proxies
 * all calls through a Web Worker. Supports both SharedArrayBuffer
 * and transfer-based postMessage paths.
 */

export class WorkerEngine {
  constructor() {
    this.worker = null;
    this.mode = 'none'; // 'direct' | 'worker-sab' | 'worker-transfer'
    this.sharedPixelBuffer = null;
    this.sharedControlBuffer = null;
    this.pixelData = null;
    this.dirtyRect = [0, 0, 0, 0];
    this._nodeCount = 0;
    this._eventQueue = [];
    this._pendingEvents = [];
    this._ready = false;
    this._resolveReady = null;
    this._pickResolvers = new Map();
    this._pickId = 0;
  }

  /**
   * Initialize. Returns the mode to use: 'direct' or 'worker-sab' or 'worker-transfer'.
   */
  async init(config) {
    const { width, height, maxNodes } = config;

    // Check if we can use SharedArrayBuffer
    const sabAvailable = typeof SharedArrayBuffer !== 'undefined';
    const workerAvailable = typeof Worker !== 'undefined';

    if (!workerAvailable) {
      this.mode = 'none';
      return 'none';
    }

    // Try SharedArrayBuffer path
    if (sabAvailable) {
      try {
        const pixelSize = width * height * 4;
        this.sharedPixelBuffer = new SharedArrayBuffer(pixelSize);
        this.sharedControlBuffer = new SharedArrayBuffer(64); // enough for ~16 int32

        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        this.mode = 'worker-sab';
      } catch (e) {
        console.warn('SharedArrayBuffer not available, falling back to transfer:', e.message);
        this.sharedPixelBuffer = null;
        this.sharedControlBuffer = null;
      }
    }

    // Fallback: regular transfer-based worker
    if (!this.sharedPixelBuffer) {
      try {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        this.mode = 'worker-transfer';
      } catch (e) {
        console.warn('Web Worker not available:', e.message);
        this.mode = 'none';
        return 'none';
      }
    }

    // Set up message handler
    this._readyPromise = new Promise(resolve => { this._resolveReady = resolve; });

    this.worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          this._ready = true;
          this._resolveReady();
          break;
        case 'frame':
          this.pixelData = new Uint8ClampedArray(msg.pixels);
          this.dirtyRect = msg.dirty;
          this._nodeCount = msg.nodeCount;
          break;
        case 'events':
          this._pendingEvents.push(...msg.data);
          break;
        case 'pick_result':
          this._nodeCount = msg.nodeCount || this._nodeCount;
          break;
        case 'error':
          console.error('Worker error:', msg.message);
          break;
      }
    };

    // Send init message
    this.worker.postMessage({
      type: 'init',
      width, height, maxNodes,
      sharedPixelBuffer: this.sharedPixelBuffer,
      sharedControlBuffer: this.sharedControlBuffer,
    });

    await this._readyPromise;
    return this.mode;
  }

  /** Check if worker is ready */
  get ready() { return this._ready; }

  /** Get current mode */
  getMode() { return this.mode; }

  /** Read latest pixel buffer (from shared mem or postMessage transfer) */
  getPixelData() {
    if (this.mode === 'worker-sab' && this.sharedPixelBuffer) {
      // Data is already in the shared buffer
      const len = this.sharedPixelBuffer.byteLength;
      return new Uint8ClampedArray(this.sharedPixelBuffer, 0, len);
    }
    return this.pixelData;
  }

  /** Get latest dirty rect */
  getDirtyRect() {
    if (this.mode === 'worker-sab' && this.sharedControlBuffer) {
      const ctrl = new Int32Array(this.sharedControlBuffer);
      return [ctrl[2], ctrl[3], ctrl[4], ctrl[5]];
    }
    return this.dirtyRect;
  }

  /** Check if shared buffer has new frame ready (SAB mode) */
  isFrameReady() {
    if (this.mode === 'worker-sab' && this.sharedControlBuffer) {
      const ctrl = new Int32Array(this.sharedControlBuffer);
      return Atomics.load(ctrl, 0) === 1;
    }
    return this.pixelData !== null;
  }

  /** Mark frame consumed (SAB mode) */
  clearFrameReady() {
    if (this.mode === 'worker-sab' && this.sharedControlBuffer) {
      const ctrl = new Int32Array(this.sharedControlBuffer);
      Atomics.store(ctrl, 0, 0);
    }
    this.pixelData = null;
  }

  /** Drain pending events from worker */
  drainEvents() {
    const evts = this._pendingEvents;
    this._pendingEvents = [];
    this._eventQueue = [];
    return evts;
  }

  /** Get current node count */
  nodeCount() { return this._nodeCount; }

  // ---- Proxy methods (send to worker) ----

  spawnNode(x, y, vx, vy, r, g, b, a, bitmask, radius) {
    if (!this.worker) return 0xFFFFFFFF;
    this.worker.postMessage({ type: 'spawn', x, y, vx, vy, r, g, b, a, bitmask, radius });
    // Worker doesn't return ID synchronously. We track it via events.
    return 0xFFFFFFFF; // Caller should use spawn event to get real ID
  }

  removeNode(id) {
    if (this.worker) this.worker.postMessage({ type: 'remove', id });
  }

  applyForce(id, fx, fy) {
    if (this.worker) this.worker.postMessage({ type: 'apply_force', id, fx, fy });
  }

  fractureNode(id) {
    if (this.worker) this.worker.postMessage({ type: 'fracture', id });
  }

  pinNode(id, cursorX, cursorY) {
    if (this.worker) this.worker.postMessage({ type: 'pin_node', id, cursorX, cursorY });
  }

  unpinNode(id) {
    if (this.worker) this.worker.postMessage({ type: 'unpin_node', id });
  }

  updatePinTarget(id, cursorX, cursorY) {
    if (this.worker) this.worker.postMessage({ type: 'update_pin', id, cursorX, cursorY });
  }

  tick(dt) {
    if (this.mode === 'worker-transfer' && this.worker) {
      this.worker.postMessage({ type: 'tick', dt });
    }
    // In SAB mode, the worker runs its own tick loop
  }

  pickNodeAt(x, y) {
    // pick is async — return MAX by default, result comes via event
    if (this.worker) this.worker.postMessage({ type: 'pick', x, y });
    return 0xFFFFFFFF;
  }

  setViscosity(v) {
    if (this.worker) this.worker.postMessage({ type: 'set_viscosity', value: v });
  }

  setGravity(g) {
    if (this.worker) this.worker.postMessage({ type: 'set_gravity', value: g });
  }

  stop() {
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' });
      this.worker.terminate();
      this.worker = null;
    }
    this._ready = false;
  }
}
