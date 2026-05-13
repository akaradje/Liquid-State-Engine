/**
 * Auto-Suggestion System
 *
 * Periodically polls the server for interesting keyword suggestions
 * based on what's currently on the workspace.
 */

const SUGGEST_ENDPOINT = '/api/suggest';

/** Cached suggestions to avoid repeated identical calls. */
let lastKeywords = '';
let cachedSuggestions = [];

/**
 * Get suggested keywords based on what's currently on the workspace.
 * @param {string[]} existingKeywords
 * @returns {Promise<string[]>}
 */
export async function getSuggestions(existingKeywords) {
  const key = existingKeywords.sort().join('|');
  if (key === lastKeywords && cachedSuggestions.length > 0) {
    return [...cachedSuggestions];
  }

  try {
    const response = await fetch(SUGGEST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: existingKeywords }),
    });

    if (!response.ok) return [];

    const data = await response.json();
    const suggestions = (data.suggestions || []).map(String).filter(Boolean);

    lastKeywords = key;
    cachedSuggestions = [...suggestions];
    return suggestions;
  } catch {
    return [];
  }
}

/** Clear the suggestion cache. */
export function clearCache() {
  lastKeywords = '';
  cachedSuggestions = [];
}
