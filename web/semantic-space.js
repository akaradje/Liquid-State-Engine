/**
 * Semantic Space — Embedding-based Similarity Engine
 *
 * Computes vector embeddings for node keywords via /api/embed,
 * finds nearest neighbors, detects clusters, and flags duplicates.
 */

const EMBED_ENDPOINT = '/api/embed';

export class SemanticSpace {
  constructor() {
    /** @type {Map<number, number[]>} nodeId → embedding vector */
    this.vectors = new Map();
    /** @type {Map<number, string>} nodeId → keyword text */
    this.labels = new Map();
  }

  /** Add or update a node's embedding. */
  async addNode(id, text) {
    const keyword = (text || '').trim();
    if (!keyword) return;
    this.labels.set(id, keyword);

    try {
      const res = await fetch(EMBED_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: [keyword] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.embeddings?.[0]) {
        this.vectors.set(id, data.embeddings[0]);
      }
    } catch { /* network error */ }
  }

  /** Remove a node. */
  removeNode(id) {
    this.vectors.delete(id);
    this.labels.delete(id);
  }

  /** Cosine similarity between two vectors. */
  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** Find top-K most similar nodes to the given node. */
  findNearest(nodeId, topK = 5) {
    const vec = this.vectors.get(nodeId);
    if (!vec) return [];

    const scores = [];
    for (const [id, otherVec] of this.vectors) {
      if (id === nodeId) continue;
      scores.push({ id, similarity: this.cosineSimilarity(vec, otherVec), label: this.labels.get(id) });
    }
    scores.sort((a, b) => b.similarity - a.similarity);
    return scores.slice(0, topK);
  }

  /** Find clusters using simple threshold-based grouping. */
  findClusters(threshold = 0.75) {
    const visited = new Set();
    const clusters = [];

    for (const [id] of this.vectors) {
      if (visited.has(id)) continue;
      const cluster = [id];
      visited.add(id);

      // Expand: find all nodes within threshold similarity
      const vec = this.vectors.get(id);
      const stack = [id];
      while (stack.length > 0) {
        const current = stack.pop();
        for (const [otherId, otherVec] of this.vectors) {
          if (visited.has(otherId)) continue;
          if (this.cosineSimilarity(this.vectors.get(current), otherVec) >= threshold) {
            visited.add(otherId);
            cluster.push(otherId);
            stack.push(otherId);
          }
        }
      }

      if (cluster.length >= 2) clusters.push(cluster);
    }

    return clusters;
  }

  /** Detect near-duplicate pairs with very high similarity. */
  detectDuplicates(threshold = 0.92) {
    const pairs = [];
    const checked = new Set();

    for (const [idA, vecA] of this.vectors) {
      for (const [idB, vecB] of this.vectors) {
        if (idA >= idB) continue;
        const key = `${Math.min(idA, idB)}-${Math.max(idA, idB)}`;
        if (checked.has(key)) continue;
        checked.add(key);

        const sim = this.cosineSimilarity(vecA, vecB);
        if (sim >= threshold) {
          pairs.push({ idA, idB, labelA: this.labels.get(idA), labelB: this.labels.get(idB), similarity: sim });
        }
      }
    }
    return pairs;
  }

  /** Get the number of stored vectors. */
  get size() { return this.vectors.size; }
}
