/**
 * Data Payload System
 *
 * Maintains a Map<entityId, payload> on the JS side.
 * Each shell (Rust entity) carries an opaque payload:
 *   { type: 'text'|'number'|'json'|'array'|'composite',
 *     value: any,
 *     label?: string }
 *
 * Events from Wasm (merge/fracture/spawn/despawn) drive payload updates.
 */

export class PayloadRegistry {
  constructor() {
    /** @type {Map<number, Object>} */
    this.map = new Map();
  }

  /** Register a payload for a newly spawned node. */
  register(id, payload) {
    this.map.set(id, { ...payload });
  }

  /** Remove a payload when its node is despawned. */
  remove(id) {
    this.map.delete(id);
  }

  /** Get payload for a node. */
  get(id) {
    return this.map.get(id);
  }

  /** Check if a node has a payload. */
  has(id) {
    return this.map.has(id);
  }

  /** Get all entries. */
  entries() {
    return this.map.entries();
  }

  /** Number of registered payloads. */
  get size() {
    return this.map.size;
  }

  /**
   * Process a batch of packed u32 events from Wasm.
   * Events format: [kind, consumed_count, produced_count, consumed_ids..., produced_ids...]
   * Returns an array of structured event objects for rule processing.
   */
  decodeEvents(u32Array) {
    const events = [];
    let i = 0;
    while (i < u32Array.length) {
      const kind = u32Array[i];
      const consumedCount = u32Array[i + 1];
      const producedCount = u32Array[i + 2];
      const consumed = [];
      const produced = [];
      for (let j = 0; j < consumedCount; j++) {
        consumed.push(u32Array[i + 3 + j]);
      }
      for (let j = 0; j < producedCount; j++) {
        produced.push(u32Array[i + 3 + consumedCount + j]);
      }
      events.push({ kind, consumed, produced });
      i += 3 + consumedCount + producedCount;
    }
    return events;
  }

  /**
   * Apply decoded events to the payload registry.
   * - spawn(2): payload already registered via register()
   * - despawn(3): remove consumed payloads
   * - merge(0): consumed payloads removed, produced gets combined payload
   * - fracture(1): consumed payload removed, produced get split payloads
   *
   * Returns the decoded events for rules to process further.
   */
  applyEvents(decodedEvents, rules) {
    for (const ev of decodedEvents) {
      switch (ev.kind) {
        case 3: // DESPAWN
          for (const id of ev.consumed) {
            this.remove(id);
          }
          break;

        case 0: { // MERGE
          const consumedPayloads = ev.consumed.map(id => this.get(id)).filter(Boolean);
          for (const id of ev.consumed) this.remove(id);
          if (consumedPayloads.length && ev.produced.length) {
            const merged = rules.merge(consumedPayloads);
            this.register(ev.produced[0], merged);
          }
          break;
        }

        case 1: { // FRACTURE
          const consumedPayload = this.get(ev.consumed[0]);
          this.remove(ev.consumed[0]);
          if (consumedPayload && ev.produced.length) {
            const fragments = rules.fracture(consumedPayload, ev.produced.length);
            for (let i = 0; i < ev.produced.length && i < fragments.length; i++) {
              this.register(ev.produced[i], fragments[i]);
            }
          }
          break;
        }

        case 2: // SPAWN — payload should already be registered
          break;
      }
    }
    return decodedEvents;
  }
}
