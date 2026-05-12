/**
 * Generic Rule Engine — merge & fracture semantics per data type.
 *
 * All functions are pure — they take payloads and return new payloads.
 * Payload format: { type: string, value: any, label?: string }
 */

/** Configurable numeric reducer. */
let numericReducer = 'sum'; // 'sum' | 'avg' | 'product'

export function setNumericReducer(mode) {
  numericReducer = mode;
}

export function getNumericReducer() {
  return numericReducer;
}

// ---- Type Detection ----

function detectType(value) {
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'text';
  if (value && typeof value === 'object') return 'json';
  return 'text';
}

function normalizePayload(p) {
  if (!p || !p.type) return { type: detectType(p?.value), value: p?.value ?? p, label: p?.label };
  // Preserve enrichment metadata through normalization
  const normalized = { type: p.type, value: p.value, label: p.label };
  if (p._enrichment) normalized._enrichment = { ...p._enrichment };
  return normalized;
}

// ---- Merge Rules ----

function mergeText(a, b) {
  return {
    type: 'text',
    value: (a.value ?? '') + '\n' + (b.value ?? ''),
    label: a.label || b.label || 'merged text',
  };
}

function mergeNumber(a, b) {
  const va = Number(a.value) || 0;
  const vb = Number(b.value) || 0;
  let result;
  switch (numericReducer) {
    case 'avg': result = (va + vb) / 2; break;
    case 'product': result = va * vb; break;
    default: result = va + vb; break;
  }
  return {
    type: 'number',
    value: result,
    label: a.label || b.label || `merged (${numericReducer})`,
  };
}

function mergeJson(a, b) {
  const result = { ...(a.value || {}) };
  const bv = b.value || {};
  for (const key of Object.keys(bv)) {
    if (key in result) {
      // Conflict: wrap as composite
      const existing = result[key];
      if (existing && typeof existing === 'object' && !Array.isArray(existing) && existing.__composite) {
        existing.items.push(bv[key]);
      } else {
        result[key] = { __composite: true, items: [existing, bv[key]] };
      }
    } else {
      result[key] = bv[key];
    }
  }
  return {
    type: 'json',
    value: result,
    label: a.label || b.label || 'merged JSON',
  };
}

function mergeArray(a, b) {
  const va = Array.isArray(a.value) ? a.value : [a.value];
  const vb = Array.isArray(b.value) ? b.value : [b.value];
  return {
    type: 'array',
    value: [...va, ...vb],
    label: a.label || b.label || 'merged array',
  };
}

function mergeComposite(items) {
  // Inherit enrichment from the first enriched parent
  const enriched = items.find(p => p._enrichment);
  const result = {
    type: 'composite',
    value: { items: items.map(normalizePayload) },
    label: 'composite (' + items.length + ' items)',
  };
  if (enriched?._enrichment) {
    result._enrichment = { ...enriched._enrichment, trustLevel: 'medium' };
  }
  return result;
}

/**
 * Merge an array of payloads into one.
 */
export function merge(payloads) {
  if (!payloads || payloads.length === 0) return { type: 'text', value: '' };
  if (payloads.length === 1) return normalizePayload(payloads[0]);

  const normalized = payloads.map(normalizePayload);
  const types = new Set(normalized.map(p => p.type));

  // Mixed types → composite
  if (types.size > 1) return mergeComposite(normalized);

  const t = [...types][0];
  // Same type: reduce pairwise
  let acc = normalized[0];
  for (let i = 1; i < normalized.length; i++) {
    switch (t) {
      case 'text': acc = mergeText(acc, normalized[i]); break;
      case 'number': acc = mergeNumber(acc, normalized[i]); break;
      case 'json': acc = mergeJson(acc, normalized[i]); break;
      case 'array': acc = mergeArray(acc, normalized[i]); break;
      default: return mergeComposite(normalized);
    }
  }
  return acc;
}

// ---- Fracture Rules ----

export function fracture(payload, fragmentCount) {
  const p = normalizePayload(payload);
  switch (p.type) {
    case 'text': return fractureText(p, fragmentCount);
    case 'number': return fractureNumber(p, fragmentCount);
    case 'json': return fractureJson(p, fragmentCount);
    case 'array': return fractureArray(p, fragmentCount);
    default: return fractureGeneric(p, fragmentCount);
  }
}

function fractureText(p, count) {
  const value = String(p.value ?? '');
  const parts = value.split(/[\s\n,;]+/).filter(Boolean);
  const fragments = [];
  const perNode = Math.max(1, Math.ceil(parts.length / count));
  for (let i = 0; i < count; i++) {
    const slice = parts.slice(i * perNode, (i + 1) * perNode);
    fragments.push({
      type: 'text',
      value: slice.join(' ') || value.charAt(i % value.length) || '·',
      label: (p.label || 'text') + '.' + (i + 1),
    });
  }
  return fragments;
}

function fractureNumber(p, count) {
  const value = Number(p.value) || 0;
  const part = value / count;
  const fragments = [];
  for (let i = 0; i < count; i++) {
    fragments.push({
      type: 'number',
      value: part,
      label: (p.label || 'num') + '.' + (i + 1),
    });
  }
  return fragments;
}

function fractureJson(p, count) {
  const entries = Object.entries(p.value || {});
  const perNode = Math.max(1, Math.ceil(entries.length / count));
  const fragments = [];
  for (let i = 0; i < count; i++) {
    const slice = entries.slice(i * perNode, (i + 1) * perNode);
    const obj = Object.fromEntries(slice);
    fragments.push({
      type: 'json',
      value: obj,
      label: (p.label || 'json') + '.' + (i + 1),
    });
  }
  return fragments;
}

/**
 * Fracture an array payload into individual components.
 * For AI-enriched arrays, each element becomes its own text node
 * (allowing individual labeling, further enrichment, and recombination).
 */
function fractureArray(p, count) {
  const arr = Array.isArray(p.value) ? p.value : [p.value];
  const enrichment = p._enrichment;

  // For AI-enriched arrays: each element gets its own node if we have enough slots
  if (enrichment && count >= arr.length) {
    const fragments = [];
    for (let i = 0; i < arr.length; i++) {
      fragments.push({
        type: 'text',
        value: String(arr[i]),
        label: String(arr[i]),
        _enrichment: {
          ...enrichment,
          componentIndex: i,
          parentKeyword: enrichment.keyword,
        },
      });
    }
    // Fill remaining slots with empty nodes if needed
    for (let i = arr.length; i < count; i++) {
      fragments.push({
        type: 'text',
        value: '·',
        label: (p.label || 'item') + '.' + (i + 1),
      });
    }
    return fragments;
  }

  // Standard array fracturing: distribute elements across nodes
  const perNode = Math.max(1, Math.ceil(arr.length / count));
  const fragments = [];
  for (let i = 0; i < count; i++) {
    const slice = arr.slice(i * perNode, (i + 1) * perNode);
    fragments.push({
      type: slice.length === 1 ? 'text' : 'array',
      value: slice.length === 1 ? String(slice[0]) : slice,
      label: slice.length === 1 ? String(slice[0]) : ((p.label || 'array') + '.' + (i + 1)),
    });
  }
  return fragments;
}

function fractureGeneric(p, count) {
  const fragments = [];
  for (let i = 0; i < count; i++) {
    fragments.push({
      type: p.type,
      value: p.value,
      label: (p.label || 'item') + '.' + (i + 1),
    });
  }
  return fragments;
}

/**
 * Auto-detect the type of raw input and return a normalized payload.
 */
export function detectPayload(raw) {
  if (raw === undefined || raw === null) return { type: 'text', value: '' };
  if (Array.isArray(raw)) return { type: 'array', value: raw };
  if (typeof raw === 'number') return { type: 'number', value: raw };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return detectPayload(parsed);
    } catch {
      return { type: 'text', value: raw };
    }
  }
  if (typeof raw === 'object') {
    try {
      JSON.stringify(raw);
      return { type: 'json', value: raw };
    } catch {
      return { type: 'text', value: String(raw) };
    }
  }
  return { type: 'text', value: String(raw) };
}
