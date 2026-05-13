/**
 * Workspace Persistence — Save, Load, Export, Import
 *
 * Auto-saves every 10 seconds to localStorage.
 * Press S to save, L to load, X to clear.
 */

const STORAGE_KEY = 'lse-workspace-autosave';

/** Collect current workspace state from all DOM nodes. */
export function collectWorkspaceState() {
  const nodes = [];
  for (const el of document.querySelectorAll('.data-box')) {
    const id = Number(el.dataset.id) || 0;
    nodes.push({
      id,
      text: el.textContent?.trim() || '',
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
      components: el.dataset.components || null,
      enriched: el.classList.contains('enriched'),
      confidence: el.dataset.confidence || null,
      emergentProperty: el.dataset.emergentProperty || null,
      depth: el.dataset.depth || null,
      created: el.dataset.created || null,
    });
  }
  return { nodes, savedAt: Date.now(), version: 1 };
}

/** Save workspace to localStorage. */
export function saveWorkspace() {
  try {
    const state = collectWorkspaceState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state.nodes.length;
  } catch { return 0; }
}

/** Restore workspace from stored data. Returns node count. */
export function loadWorkspace(data, createFn) {
  const state = typeof data === 'string' ? JSON.parse(data) : data;
  if (!state || !Array.isArray(state.nodes)) return 0;

  // Clear all existing nodes
  for (const el of document.querySelectorAll('.data-box')) el.remove();

  let count = 0;
  for (const n of state.nodes) {
    if (!n.text) continue;
    const id = createFn(n.text, n.x, n.y);
    const el = document.getElementById ? null : null; // we need to get the element
    // Find the created element by position + text
    for (const box of document.querySelectorAll('.data-box')) {
      if (box.textContent?.trim() === n.text
          && Math.abs((parseFloat(box.style.left) || 0) - n.x) < 2
          && Math.abs((parseFloat(box.style.top) || 0) - n.y) < 2) {
        // Restore saved state
        if (n.components) box.dataset.components = n.components;
        if (n.enriched) box.classList.add('enriched');
        if (n.confidence) {
          box.dataset.confidence = n.confidence;
          box.style.setProperty('--conf-width', `${(parseFloat(n.confidence) * 100).toFixed(0)}%`);
        }
        if (n.emergentProperty) box.dataset.emergentProperty = n.emergentProperty;
        if (n.depth) box.dataset.depth = n.depth;
        if (n.created) box.dataset.created = n.created;
        // Re-trigger AI enrichment
        const evt = new CustomEvent('lse-restore-enrich', { detail: { id, keyword: n.text } });
        window.dispatchEvent(evt);
        break;
      }
    }
    count++;
  }
  return count;
}

/** Check if autosave exists and return node count, or 0. */
export function checkAutosave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const state = JSON.parse(raw);
    return state?.nodes?.length || 0;
  } catch { return 0; }
}

/** Export workspace as downloadable .json file. */
export function exportAsJSON() {
  const state = collectWorkspaceState();
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  a.download = `lse-workspace-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return state.nodes.length;
}

/** Import workspace from a File object. Returns parsed data or null. */
export function importFromJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.nodes)) {
          reject(new Error('Invalid workspace file: missing "nodes" array'));
          return;
        }
        resolve(data);
      } catch (e) {
        reject(new Error('Invalid JSON file: ' + e.message));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

/** Show a brief toast notification. */
export function showToast(message) {
  const existing = document.querySelector('.lse-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'lse-toast';
  toast.textContent = message;
  toast.style.cssText = `
    position:fixed; bottom:100px; left:50%; transform:translateX(-50%);
    z-index:9999; pointer-events:none;
    background:rgba(18,22,36,0.9); backdrop-filter:blur(12px);
    border:1px solid rgba(100,180,255,0.25); border-radius:8px;
    padding:8px 18px; color:rgba(200,225,255,0.9);
    font-family:'SF Mono',monospace; font-size:11px;
    animation:toastIn 0.3s ease-out, toastOut 0.3s 2s ease-in forwards;
  `;
  document.body.appendChild(toast);

  // Add keyframes if not present
  if (!document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      @keyframes toastIn { from{opacity:0;transform:translateX(-50%) translateY(10px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
      @keyframes toastOut { from{opacity:1} to{opacity:0} }
    `;
    document.head.appendChild(style);
  }

  setTimeout(() => toast.remove(), 2500);
}
