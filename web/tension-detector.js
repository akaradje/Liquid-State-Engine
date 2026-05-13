/**
 * Tension Detector — Contradiction & Dialectical Opposition
 *
 * Detects semantic tensions between concepts and draws wavy red SVG lines.
 * Click on a tension line → AI suggests a synthesis resolution.
 */

const TENSION_ENDPOINT = '/api/detect-tension';

/** @type {Array<{ a:string, b:string, type:string, intensity:number, explanation:string }>} */
let tensions = [];
let tensionLines = []; // SVG line elements
let analysisTimer = null;

// ---- Public API ----

export function getTensions() { return tensions; }
export function getTensionCount() { return tensions.length; }

/** Analyze workspace for tensions (debounced 2s). */
export function scheduleTensionAnalysis(nodesMap) {
  if (analysisTimer) clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => analyzeTensions(nodesMap), 2000);
}

async function analyzeTensions(nodesMap) {
  const keywords = [];
  for (const [, el] of nodesMap) {
    const kw = el.textContent?.trim();
    if (kw && !kw.includes('Merging') && !kw.includes('Fracturing') && !kw.includes('Debating')) {
      keywords.push(kw);
    }
  }
  if (keywords.length < 4) { tensions = []; renderLines(nodesMap); return; }

  try {
    const res = await fetch(TENSION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords }),
    });
    if (!res.ok) return;
    const data = await res.json();
    tensions = data.tensions || [];
    renderLines(nodesMap);
    updateHUD();
  } catch {}
}

// ---- SVG Lines ----

function getSVG() {
  let svg = document.getElementById('tension-svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'tension-svg';
    svg.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:55;pointer-events:none;';
    document.body.appendChild(svg);
  }
  return svg;
}

function renderLines(nodesMap) {
  const svg = getSVG();
  // Clear old lines
  for (const line of tensionLines) line.remove();
  tensionLines = [];

  for (const t of tensions) {
    // Find DOM elements matching tension keywords
    let elA, elB;
    for (const [, el] of nodesMap) {
      const kw = el.textContent?.trim() || '';
      if (!elA && kw.toLowerCase() === t.a.toLowerCase()) elA = el;
      else if (!elB && kw.toLowerCase() === t.b.toLowerCase()) elB = el;
    }
    if (!elA || !elB) continue;

    const ax = parseFloat(elA.style.left) || 0;
    const ay = parseFloat(elA.style.top) || 0;
    const bx = parseFloat(elB.style.left) || 0;
    const by = parseFloat(elB.style.top) || 0;

    // Create wavy path between A and B
    const midX = (ax + bx) / 2;
    const midY = (ay + by) / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const perpX = -dy * 0.15;
    const perpY = dx * 0.15;
    const waveAmp = 20 * t.intensity;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M${ax},${ay} Q${midX + perpX + waveAmp},${midY + perpY} ${midX + perpX},${midY} T${bx},${by}`;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', `rgba(255,80,80,${0.3 + t.intensity * 0.4})`);
    path.setAttribute('stroke-width', String(1 + t.intensity * 2));
    path.setAttribute('stroke-dasharray', t.type === 'paradox' ? '8,4' : t.type === 'dialectic' ? '4,2' : 'none');
    path.style.cursor = 'pointer';
    path.style.pointerEvents = 'stroke';

    // Tooltip on hover
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${t.a} ↔ ${t.b} (${t.type}, ${(t.intensity*100).toFixed(0)}%)\n${t.explanation}`;
    path.appendChild(title);

    // Click to resolve
    path.onclick = () => resolveTension(t, midX, midY);

    svg.appendChild(path);
    tensionLines.push(path);
  }
}

// ---- Resolution ----

async function resolveTension(tension, x, y) {
  try {
    const res = await fetch(TENSION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: [tension.a, tension.b],
        resolve: true,
        a: tension.a,
        b: tension.b,
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const synthesis = data.synthesis || 'Synthesis';

    // Dispatch to main.js to spawn synthesis node
    window.dispatchEvent(new CustomEvent('lse-tension-resolved', {
      detail: { synthesis, x, y, tension, explanation: data.explanation, confidence: data.confidence },
    }));
  } catch {}
}

function updateHUD() {
  const el = document.getElementById('tension-count');
  if (el) {
    el.textContent = tensions.length > 0 ? String(tensions.length) : '—';
    el.style.color = tensions.length >= 3 ? 'rgba(255,100,100,0.9)' : tensions.length > 0 ? 'rgba(255,160,100,0.8)' : '';
  }
}

/** Draw an animation pulse along existing tension lines. */
export function startPulseLoop() {
  let phase = 0;
  setInterval(() => {
    phase += 0.05;
    for (let i = 0; i < tensionLines.length; i++) {
      const t = tensions[i];
      if (!t) continue;
      const opacity = 0.3 + t.intensity * 0.4 + Math.sin(phase + i) * 0.15;
      tensionLines[i].setAttribute('stroke', `rgba(255,80,80,${Math.max(0.15, Math.min(0.9, opacity))})`);
    }
  }, 50);
}
