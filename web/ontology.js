/**
 * Ontology — Automatic Hierarchy Learning
 *
 * Classifies concepts into IS-A taxonomic chains, builds a tree structure,
 * and provides LCA (Lowest Common Ancestor) for smarter merges.
 *
 * Persisted to localStorage "lse-ontology".
 */

const CLASSIFY_ENDPOINT = '/api/classify';
const STORAGE_KEY = 'lse-ontology';

export class Ontology {
  constructor() {
    /** @type {Map<string, { parent: string|null, children: Set<string>, level: number, chain: string[] }>} */
    this.tree = new Map();
    this._load();
  }

  _save() {
    try {
      const data = {};
      for (const [key, node] of this.tree) {
        data[key] = { parent: node.parent, children: [...node.children], level: node.level, chain: node.chain };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const [key, node] of Object.entries(data)) {
        this.tree.set(key, { parent: node.parent, children: new Set(node.children || []), level: node.level, chain: node.chain || [] });
      }
    } catch {}
  }

  /**
   * Classify a keyword into its taxonomic chain and merge into the tree.
   * Returns the chain [most specific, ..., most general].
   */
  async classify(keyword) {
    const key = keyword.toLowerCase().trim();
    if (this.tree.has(key)) return this.tree.get(key).chain;

    try {
      const res = await fetch(CLASSIFY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword }),
      });
      if (!res.ok) return [keyword];
      const data = await res.json();
      const chain = data.chain?.length > 1 ? data.chain : [keyword];

      // Insert into tree
      for (let i = 0; i < chain.length; i++) {
        const nodeKey = chain[i].toLowerCase();
        if (!this.tree.has(nodeKey)) {
          const parent = i + 1 < chain.length ? chain[i + 1].toLowerCase() : null;
          this.tree.set(nodeKey, { parent, children: new Set(), level: chain.length - i, chain: chain.slice(i) });
        }
        // Link child → parent
        if (i > 0) {
          const childKey = chain[i - 1].toLowerCase();
          const node = this.tree.get(nodeKey);
          if (node && !node.children.has(childKey)) {
            node.children.add(childKey);
          }
        }
      }
      this._save();
      return chain;
    } catch {
      return [keyword];
    }
  }

  /** Get the full ancestor chain for a keyword. */
  getParentChain(keyword) {
    const key = keyword.toLowerCase().trim();
    const node = this.tree.get(key);
    if (!node?.chain) return [keyword];
    return node.chain;
  }

  /** Get sibling concepts (share same immediate parent). */
  getSiblings(keyword) {
    const key = keyword.toLowerCase().trim();
    const node = this.tree.get(key);
    if (!node?.parent) return [];
    const parent = this.tree.get(node.parent);
    if (!parent) return [];
    return [...parent.children].filter(c => c !== key).slice(0, 8);
  }

  /** Find Lowest Common Ancestor of two keywords. */
  getLCA(keywordA, keywordB) {
    const chainA = this.getParentChain(keywordA);
    const chainB = this.getParentChain(keywordB);
    // Reverse to most-general-first order
    const setB = new Set(chainB.map(c => c.toLowerCase()));
    for (const item of chainA) {
      if (setB.has(item.toLowerCase())) return item;
    }
    return null;
  }

  /** Get the abstraction level (number of steps from most specific). */
  getLevel(keyword) {
    const key = keyword.toLowerCase().trim();
    return this.tree.get(key)?.level ?? 0;
  }

  /** Get all stored concepts. */
  get size() { return this.tree.size; }
}
