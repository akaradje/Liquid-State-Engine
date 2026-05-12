/**
 * Relationship Visualization System
 *
 * Draws SVG lines between related nodes on the workspace.
 * Toggle visibility with the 'R' key.
 *
 * Line types:
 *   parent → child: purple, dashed  (fracture relationships)
 *   merged:         gold, solid    (merge relationships)
 *   sibling:        cyan, dotted   (shared parent)
 */

const svg = document.getElementById('relations-svg');

/** @type {Array<{ from: number, to: number, type: 'parent'|'sibling'|'merged', strength: number, createdAt: number }>} */
const relations = [];

let visible = true;
let animFrameId = null;

// ---- Public API ----

/** Add a parent→child fracture relationship. */
export function addParentRelation(parentId, childIds) {
  const now = Date.now();
  for (const childId of childIds) {
    relations.push({ from: parentId, to: childId, type: 'parent', strength: 1.0, createdAt: now });
  }
  // Add sibling edges between all children
  for (let i = 0; i < childIds.length; i++) {
    for (let j = i + 1; j < childIds.length; j++) {
      relations.push({ from: childIds[i], to: childIds[j], type: 'sibling', strength: 0.6, createdAt: now });
    }
  }
}

/** Add a merge relationship (A + B → result). */
export function addMergeRelation(resultId, sourceIds) {
  const now = Date.now();
  for (const srcId of sourceIds) {
    relations.push({ from: srcId, to: resultId, type: 'merged', strength: 1.0, createdAt: now });
  }
}

/** Get all currently tracked relations. */
export function getRelations() { return relations; }

/** Clear all relations. */
export function clearRelations() { relations.length = 0; }

// ---- Rendering ----

const LINE_STYLES = {
  parent:  { stroke: 'rgba(160, 120, 255, VAR)', dash: '6,3', width: 1.2 },
  sibling: { stroke: 'rgba(80, 200, 220, VAR)', dash: '2,4', width: 0.8 },
  merged:  { stroke: 'rgba(255, 200, 60, VAR)', dash: 'none', width: 1.5 },
};

/** Decay strength: older relations get more transparent. */
function decayStrength(createdAt) {
  const age = (Date.now() - createdAt) / 1000;
  return Math.max(0.15, 1.0 - age / 120); // Full opacity → 0.15 over 2 minutes
}

/** Render all relationship lines into the SVG. Called by animation loop. */
function drawLines() {
  if (!visible) { svg.innerHTML = ''; return; }

  const nodePositions = {};
  // Gather positions of all currently visible data-boxes
  for (const el of document.querySelectorAll('.data-box')) {
    const id = Number(el.dataset.id);
    if (!id) continue;
    // Get center position from CSS left/top
    const left = parseFloat(el.style.left) || 0;
    const top = parseFloat(el.style.top) || 0;
    nodePositions[id] = { x: left, y: top };
  }

  let html = '';
  for (const rel of relations) {
    const a = nodePositions[rel.from];
    const b = nodePositions[rel.to];
    if (!a || !b) continue;

    const strength = rel.strength * decayStrength(rel.createdAt);
    const style = LINE_STYLES[rel.type];
    const opacity = Math.max(0.08, strength);
    const stroke = style.stroke.replace('VAR', String(opacity));

    html += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
      stroke="${stroke}" stroke-width="${style.width}"
      stroke-dasharray="${style.dash === 'none' ? '' : style.dash}"
      stroke-linecap="round" />`;
  }

  svg.innerHTML = html;
}

/** Start the animation loop. */
export function startLoop() {
  if (animFrameId) return;
  const tick = () => {
    drawLines();
    animFrameId = requestAnimationFrame(tick);
  };
  animFrameId = requestAnimationFrame(tick);
}

/** Stop the animation loop. */
export function stopLoop() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
}

/** Toggle visibility. Returns the new state. */
export function toggleVisibility() {
  visible = !visible;
  if (!visible) svg.innerHTML = '';
  return visible;
}

export function isVisible() { return visible; }

// Auto-start
startLoop();
