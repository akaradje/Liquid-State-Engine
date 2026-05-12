/**
 * Semantic Memory System for Liquid-State Engine
 *
 * Maintains a persistent knowledge graph of all nodes ever created.
 * Records fracture (parent → children) and merge (A + B → C) relationships.
 * Provides graph-aware context for AI enrichment prompts.
 *
 * Persisted to localStorage under key "lse-semantic-memory".
 */

const STORAGE_KEY = 'lse-semantic-memory';

export class SemanticMemory {
  constructor() {
    /** @type {Map<string, { components: string[], relations: Set<string>,
     *   createdAt: number, mergeHistory: Array, fractureHistory: Array,
     *   parentOf: Set<string>, mergedInto: Set<string>, occurrenceCount: number }>} */
    this.nodes = new Map();
    this._load();
  }

  // ---- Persistence ----

  _save() {
    try {
      const data = {};
      for (const [key, node] of this.nodes) {
        data[key] = {
          components: node.components,
          relations: [...node.relations],
          createdAt: node.createdAt,
          mergeHistory: node.mergeHistory,
          fractureHistory: node.fractureHistory,
          parentOf: [...node.parentOf],
          mergedInto: [...node.mergedInto],
          occurrenceCount: node.occurrenceCount,
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch { /* localStorage unavailable */ }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const [key, node] of Object.entries(data)) {
        this.nodes.set(key, {
          components: node.components || [],
          relations: new Set(node.relations || []),
          createdAt: node.createdAt || Date.now(),
          mergeHistory: node.mergeHistory || [],
          fractureHistory: node.fractureHistory || [],
          parentOf: new Set(node.parentOf || []),
          mergedInto: new Set(node.mergedInto || []),
          occurrenceCount: node.occurrenceCount || 1,
        });
      }
    } catch { /* corrupted or empty */ }
  }

  // ---- Ensure a node exists in the graph ----

  _ensure(keyword) {
    const key = keyword.toLowerCase().trim();
    if (!key) return null;
    if (!this.nodes.has(key)) {
      this.nodes.set(key, {
        components: [],
        relations: new Set(),
        createdAt: Date.now(),
        mergeHistory: [],
        fractureHistory: [],
        parentOf: new Set(),
        mergedInto: new Set(),
        occurrenceCount: 1,
      });
    } else {
      this.nodes.get(key).occurrenceCount++;
    }
    return this.nodes.get(key);
  }

  // ---- Event Recording ----

  /** Record that a keyword was created as a node. */
  recordCreate(keyword) {
    this._ensure(keyword);
    this._save();
  }

  /** Record a fracture: parent → [child1, child2, ...] */
  recordFracture(parentKeyword, childKeywords) {
    const parent = this._ensure(parentKeyword);
    if (!parent) return;
    parent.fractureHistory.push({ children: childKeywords, timestamp: Date.now() });
    parent.components = childKeywords;

    for (const child of childKeywords) {
      const childNode = this._ensure(child);
      if (!childNode) continue;
      childNode.parentOf.add(parentKeyword.toLowerCase());
      parent.relations.add(child.toLowerCase());
      childNode.relations.add(parentKeyword.toLowerCase());
    }
    this._save();
  }

  /** Record a merge: A + B → result */
  recordMerge(keywordA, keywordB, resultKeyword) {
    const a = this._ensure(keywordA);
    const b = this._ensure(keywordB);
    const result = this._ensure(resultKeyword);
    if (!a || !b || !result) return;

    const timestamp = Date.now();
    a.mergeHistory.push({ with: keywordB, result: resultKeyword, timestamp });
    b.mergeHistory.push({ with: keywordA, result: resultKeyword, timestamp });

    a.relations.add(keywordB.toLowerCase());
    a.relations.add(resultKeyword.toLowerCase());
    b.relations.add(keywordA.toLowerCase());
    b.relations.add(resultKeyword.toLowerCase());
    result.mergedInto.add(keywordA.toLowerCase());
    result.mergedInto.add(keywordB.toLowerCase());
    result.relations.add(keywordA.toLowerCase());
    result.relations.add(keywordB.toLowerCase());
    this._save();
  }

  // ---- Graph Queries ----

  /**
   * Get a context string for a keyword — what it was fractured into,
   * what it was merged with, and its place in the knowledge graph.
   */
  getContext(keyword) {
    const key = keyword.toLowerCase().trim();
    const node = this.nodes.get(key);
    if (!node) return '';

    const parts = [];

    if (node.components.length > 0) {
      parts.push(`Previously fractured into: ${node.components.join(', ')}.`);
    }
    if (node.mergeHistory.length > 0) {
      const lastMerge = node.mergeHistory[node.mergeHistory.length - 1];
      parts.push(`Previously merged with "${lastMerge.with}" to form "${lastMerge.result}".`);
    }
    if (node.parentOf.size > 0) {
      parts.push(`This was created by fracturing: ${[...node.parentOf].join(', ')}.`);
    }
    if (node.mergedInto.size > 0) {
      parts.push(`This was created by merging: ${[...node.mergedInto].join(' + ')}.`);
    }
    const related = [...node.relations].filter(r => r !== key).slice(0, 5);
    if (related.length > 0) {
      parts.push(`Related concepts: ${related.join(', ')}.`);
    }

    return parts.join(' ');
  }

  /**
   * Get an array of related keywords based on graph proximity (BFS up to depth 2).
   */
  getSuggestions(keyword) {
    const key = keyword.toLowerCase().trim();
    const visited = new Set([key]);
    const suggestions = [];
    const queue = [{ keyword: key, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      const node = this.nodes.get(current.keyword);
      if (!node) continue;

      for (const rel of node.relations) {
        if (visited.has(rel)) continue;
        visited.add(rel);
        if (current.depth < 2) {
          suggestions.push(rel);
          queue.push({ keyword: rel, depth: current.depth + 1 });
        }
      }

      // Also follow parentOf edges
      for (const parent of node.parentOf) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        suggestions.push(parent);
        queue.push({ keyword: parent, depth: current.depth + 1 });
      }

      // And mergedInto edges
      for (const merged of node.mergedInto) {
        if (visited.has(merged)) continue;
        visited.add(merged);
        suggestions.push(merged);
        queue.push({ keyword: merged, depth: current.depth + 1 });
      }
    }

    return suggestions;
  }

  /**
   * Get the full memory context for injection into AI prompts.
   * Returns a compact summary of what the system knows about the given keywords.
   */
  getEnrichContext(keyword) {
    const ctx = this.getContext(keyword);
    const suggestions = this.getSuggestions(keyword).slice(0, 5);
    let result = '';
    if (ctx) result += `Context: ${ctx} `;
    if (suggestions.length > 0) {
      result += `Related concepts in graph: ${suggestions.join(', ')}.`;
    }
    return result.trim();
  }

  /** Get all stored keywords. */
  getAllKeywords() {
    return [...this.nodes.keys()];
  }

  /** Number of unique concepts in memory. */
  get size() {
    return this.nodes.size;
  }

  /** Clear all memory. */
  clear() {
    this.nodes.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }
}
