/**
 * Data Payload System
 *
 * Maintains a Map<entityId, payload> on the JS side.
 * Each shell (Rust entity) carries an opaque payload:
 *   { type: 'text'|'number'|'json'|'array'|'composite',
 *     value: any,
 *     label?: string,
 *     _enrichment?: { source, model, timestamp, keyword, trustLevel } }
 *
 * Events from Wasm (merge/fracture/spawn/despawn) drive payload updates.
 * AI auto-enrichment triggers when a single-keyword text payload is registered.
 */

import { enrichPayload } from './ai-enrich.js';

export class PayloadRegistry {
  constructor() {
    /** @type {Map<number, Object>} */
    this.map = new Map();
    /** Track enrichment promises in flight per entity. */
    this._enriching = new Map();
    /** Enrichment callback — set by host to integrate with HUD. */
    this.onEnriched = null;
  }

  /** Register a payload for a newly spawned node. Triggers AI enrichment for text keywords. */
  register(id, payload) {
    const stored = { ...payload };
    this.map.set(id, stored);

    // Trigger AI auto-enrich for single-keyword text payloads (async, non-blocking)
    this._maybeEnrich(id, stored);
  }

  /** Remove a payload when its node is despawned. */
  remove(id) {
    this._enriching.delete(id);
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
   * Attempt AI enrichment for a payload in the background.
   * On success, replaces the stored payload with the enriched array version.
   */
  async _maybeEnrich(id, payload) {
    if (!payload || payload.type !== 'text') return;
    const keyword = (payload.value ?? '').trim();
    if (!keyword || keyword.split(/\s+/).filter(Boolean).length > 5) return;
    if (/[.!?;]$/.test(keyword)) return;

    try {
      const enriched = await enrichPayload(payload, id);
      if (enriched && enriched.type === 'array') {
        // Replace stored payload with enriched version
        this.map.set(id, enriched);
        // Notify host
        if (this.onEnriched) {
          this.onEnriched(id, enriched);
        }
        // Dispatch global event for HUD
        window.dispatchEvent(new CustomEvent('lse-payload-enriched', {
          detail: { entityId: id, original: payload, enriched },
        }));
      }
    } catch {
      // Enrichment failed silently — payload remains as original text
    }
  }

  /**
   * Process a batch of packed u32 events from Wasm.
   * Events format: [kind, consumed_count, produced_count, consumed_ids..., produced_ids...]
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
              // Propagate enrichment metadata to child nodes
              if (consumedPayload._enrichment && fragments[i]) {
                fragments[i]._enrichment = {
                  ...consumedPayload._enrichment,
                  trustLevel: 'medium',
                  parentKeyword: consumedPayload._enrichment.keyword,
                };
              }
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
