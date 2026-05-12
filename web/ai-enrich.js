/**
 * AI Auto-Enrich Module — DeepSeek V4 (Server-Proxy)
 *
 * When a text payload containing a single keyword/short phrase is registered,
 * this module calls the local server's /api/enrich endpoint, which proxies to
 * the DeepSeek API with intelligent model routing based on keyword complexity.
 *
 * The server handles all API key management — no keys are exposed client-side.
 *
 * Model routing (server-side):
 *   LITE     → deepseek-chat      (1-2 words, <10 chars)
 *   STANDARD → deepseek-chat      (moderate complexity)
 *   ULTRA    → deepseek-reasoner  (technical symbols, domain keywords)
 *
 * Design patterns from "Liquid Information" reference:
 * - Knowledge Artifacts: enriched nodes carry provenance metadata
 * - Visual-Meta: every enrichment stores model, timestamp, prompt used
 * - Trust Ladder: AI-generated content tagged with trust level
 * - Event-driven: enrichment lifecycle events for HUD observation
 */

// ---- Configuration ----

const ENRICH_ENDPOINT = '/api/enrich';

/** Cache enrichment results to avoid repeated API calls for the same keyword. */
const enrichmentCache = new Map();

/** Track in-flight requests to avoid duplicate concurrent calls. */
const pendingRequests = new Map();

// ---- Public API ----

/**
 * Attempt to auto-enrich a payload. If it's a single keyword text,
 * calls the DeepSeek proxy and returns an array-type payload of components.
 * Otherwise returns the payload unchanged.
 *
 * Dispatches 'lse-enrich-start', 'lse-enrich-done', 'lse-enrich-fail' events.
 *
 * @param {Object} payload - { type, value, label }
 * @param {number} entityId - The entity this payload belongs to
 * @returns {Promise<Object>} The enriched payload (or original if not applicable)
 */
export async function enrichPayload(payload, entityId) {
  if (!payload || payload.type !== 'text') return payload;

  const keyword = (payload.value ?? '').trim();
  if (!keyword) return payload;

  // Only enrich single keywords/short phrases (not long prose)
  const wordCount = keyword.split(/\s+/).filter(Boolean).length;
  if (wordCount > 5) return payload;

  // Skip if it looks like a sentence (contains sentence-ending punctuation)
  if (/[.!?;]$/.test(keyword)) return payload;

  // Check cache
  const cacheKey = keyword.toLowerCase();
  if (enrichmentCache.has(cacheKey)) {
    const cached = enrichmentCache.get(cacheKey);
    return {
      type: 'array',
      value: cached.components,
      label: payload.label || keyword,
      _enrichment: {
        source: 'DeepSeek V4',
        model: cached.model,
        tier: cached.tier,
        timestamp: cached.timestamp,
        keyword,
        trustLevel: 'medium',
      },
    };
  }

  // Check if already in-flight
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  // Dispatch enrichment start event
  window.dispatchEvent(new CustomEvent('lse-enrich-start', {
    detail: { entityId, keyword },
  }));

  // Start enrichment via server proxy
  const promise = callDeepSeekProxy(keyword)
    .then(({ components, model, tier }) => {
      pendingRequests.delete(cacheKey);

      const enriched = {
        type: 'array',
        value: components,
        label: payload.label || keyword,
        _enrichment: {
          source: 'DeepSeek V4',
          model,
          tier,
          timestamp: Date.now(),
          keyword,
          trustLevel: 'medium',
        },
      };

      enrichmentCache.set(cacheKey, {
        components,
        model,
        tier,
        timestamp: enriched._enrichment.timestamp,
      });

      window.dispatchEvent(new CustomEvent('lse-enrich-done', {
        detail: { entityId, keyword, components, enriched, model, tier },
      }));

      return enriched;
    })
    .catch(err => {
      pendingRequests.delete(cacheKey);
      console.warn('[AI-Enrich] Enrichment failed for:', keyword, err.message);

      window.dispatchEvent(new CustomEvent('lse-enrich-fail', {
        detail: { entityId, keyword, error: err.message },
      }));

      return payload;
    });

  pendingRequests.set(cacheKey, promise);
  return promise;
}

// ---- Server Proxy Call ----

/**
 * Call the local server's /api/enrich endpoint.
 * The server handles DeepSeek API authentication and model routing.
 *
 * @param {string} keyword
 * @returns {Promise<{ components: string[], model: string, tier: string }>}
 */
async function callDeepSeekProxy(keyword) {
  const response = await fetch(ENRICH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.json();
      detail = errBody.detail || errBody.error || '';
    } catch { /* ignore */ }
    throw new Error(`Server error ${response.status}${detail ? ': ' + detail : ''}`);
  }

  // Extract model info from response headers
  const model = response.headers.get('X-DeepSeek-Model') || 'deepseek-chat';
  const tier = response.headers.get('X-DeepSeek-Tier') || 'STANDARD';

  const data = await response.json();
  if (!data.components || !Array.isArray(data.components)) {
    throw new Error('Invalid response: missing components array');
  }

  return { components: data.components, model, tier };
}

// ---- API Key Management (simplified — key is server-side now) ----

/**
 * Check if enrichment is available.
 * Always returns true when the server is running (key is server-side).
 * The server will return 500 if DEEPSEEK_API_KEY is not configured.
 */
export function hasApiKey() {
  return true; // Server handles authentication
}

/**
 * Set the AI API key.
 * @deprecated Keys are now managed server-side via DEEPSEEK_API_KEY env var.
 * This method is kept for backward compatibility with the HUD settings dialog.
 */
export function setApiKey(_key, _storage = 'session') {
  // No-op: keys are server-side now
  console.log('[AI-Enrich] API keys are now managed server-side (DEEPSEEK_API_KEY env var).');
}

/**
 * Check if a keyword has been enriched (in cache).
 */
export function isEnriched(keyword) {
  return enrichmentCache.has(keyword.toLowerCase());
}

/**
 * Get cached enrichment data for a keyword.
 */
export function getCachedEnrichment(keyword) {
  return enrichmentCache.get(keyword.toLowerCase()) ?? null;
}

/**
 * Clear all cached enrichments.
 */
export function clearCache() {
  enrichmentCache.clear();
}
