/**
 * Proactive Curiosity Engine
 *
 * Analyzes workspace state every 60s (if idle) and generates
 * AI-powered suggestions: "Try merging X + Y", "Fracture Z", etc.
 *
 * Shows suggestions as floating glassmorphism thought bubbles.
 * Tracks accept/dismiss feedback to improve future suggestions.
 */

const CURIOSITY_ENDPOINT = '/api/curiosity';
const IDLE_THRESHOLD = 15000; // 15s idle required
const CYCLE_INTERVAL = 60000; // 60s between suggestions
const DISPLAY_DURATION = 20000; // 20s auto-dismiss

let lastInputTime = Date.now();
let lastSuggestionTime = 0;
let currentBubble = null;
let feedbackLog = [];

// Load feedback history
try {
  const stored = localStorage.getItem('lse-curiosity-feedback');
  if (stored) feedbackLog = JSON.parse(stored);
} catch {}

// ---- Idle Detection ----

export function touchInput() { lastInputTime = Date.now(); }

function isIdle() { return (Date.now() - lastInputTime) > IDLE_THRESHOLD; }

// ---- Workspace Analysis ----

function analyzeWorkspace(nodesMap) {
  const keywords = [];
  let neverFractured = [];
  let neverMerged = [];
  let enrichedCount = 0;

  for (const [id, el] of nodesMap) {
    const kw = el.textContent?.trim();
    if (!kw || kw.includes('Merging') || kw.includes('Fracturing') || kw.includes('Debating')) continue;
    keywords.push(kw);
    const hasComponents = !!el.dataset.components;
    const hasConfidence = !!el.dataset.confidence;
    if (!hasComponents && !hasConfidence) neverFractured.push(kw);
    if (!el.classList.contains('high-confidence') && !el.classList.contains('merged-flash')) neverMerged.push(kw);
    if (el.classList.contains('enriched')) enrichedCount++;
  }

  return { keywords, neverFractured, neverMerged, enrichedCount };
}

// ---- Fetch Suggestion ----

async function fetchSuggestion(nodesMap) {
  const { keywords, neverFractured, neverMerged } = analyzeWorkspace(nodesMap);
  if (keywords.length < 3) return null;

  try {
    const res = await fetch(CURIOSITY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: keywords.map(k => ({
          keyword: k,
          age: 0,
          connections: 0,
        })),
        neverFractured: neverFractured.slice(0, 5),
        neverMerged: neverMerged.slice(0, 5),
        feedback: feedbackLog.slice(-10), // recent feedback for bias
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ---- Thought Bubble UI ----

function createBubble(suggestion) {
  dismissBubble();

  const bubble = document.createElement('div');
  bubble.className = 'curiosity-bubble';

  const icon = suggestion.type === 'merge' ? '⚗️' :
               suggestion.type === 'fracture' ? '🔬' :
               suggestion.type === 'explore' ? '🔍' : '🪞';

  bubble.innerHTML = `
    <div class="cb-header"><span class="cb-icon">${icon}</span><span class="cb-type">${suggestion.type}</span></div>
    <div class="cb-prompt">${suggestion.prompt}</div>
    <div class="cb-actions">
      <button class="cb-btn cb-dismiss">✕ Dismiss</button>
      <button class="cb-btn cb-try">✓ Try it</button>
    </div>
  `;

  // Style
  bubble.style.cssText = `
    position:fixed; top:16px; left:50%; transform:translateX(-50%);
    z-index:5000; min-width:280px; max-width:420px;
    background:rgba(14,20,38,0.94); backdrop-filter:blur(18px);
    -webkit-backdrop-filter:blur(18px);
    border:1px solid rgba(120,180,255,0.25); border-radius:14px;
    padding:14px 18px;
    box-shadow:0 8px 40px rgba(0,0,0,0.6), 0 0 20px rgba(100,160,255,0.08);
    font-family:'SF Mono',monospace; font-size:11px;
    animation:curiosityIn 0.4s ease-out, curiosityFloat 4s ease-in-out infinite;
  `;
  document.body.appendChild(bubble);

  // Buttons
  bubble.querySelector('.cb-dismiss').onclick = () => {
    recordFeedback(suggestion, 'dismissed');
    dismissBubble();
  };
  bubble.querySelector('.cb-try').onclick = () => {
    recordFeedback(suggestion, 'accepted');
    dismissBubble();
    executeSuggestion(suggestion);
  };

  // Auto-dismiss timer
  const timer = setTimeout(() => {
    recordFeedback(suggestion, 'timed_out');
    dismissBubble();
  }, DISPLAY_DURATION);

  bubble._timer = timer;
  currentBubble = bubble;
  return bubble;
}

function dismissBubble() {
  if (currentBubble) {
    clearTimeout(currentBubble._timer);
    currentBubble.remove();
    currentBubble = null;
  }
}

// ---- Feedback Learning ----

function recordFeedback(suggestion, outcome) {
  feedbackLog.push({
    type: suggestion.type,
    prompt: suggestion.prompt,
    outcome,
    timestamp: Date.now(),
  });
  // Keep last 100 entries
  if (feedbackLog.length > 100) feedbackLog = feedbackLog.slice(-100);
  try { localStorage.setItem('lse-curiosity-feedback', JSON.stringify(feedbackLog)); } catch {}
}

/** Bias: calculate acceptance rate per suggestion type. */
function getTypeBias() {
  const counts = {};
  for (const f of feedbackLog) {
    if (!counts[f.type]) counts[f.type] = { total: 0, accepted: 0 };
    counts[f.type].total++;
    if (f.outcome === 'accepted') counts[f.type].accepted++;
  }
  return counts;
}

// ---- Execute Accepted Suggestion ----

function executeSuggestion(suggestion) {
  // Dispatch custom event for main.js to handle
  window.dispatchEvent(new CustomEvent('lse-curiosity-execute', {
    detail: suggestion,
  }));
}

// ---- Main Loop ----

let curiosityTimer = null;

export function startCuriosityEngine(nodesMap) {
  if (curiosityTimer) return;
  curiosityTimer = setInterval(async () => {
    if (!isIdle() || nodesMap.size < 5) return;
    if (Date.now() - lastSuggestionTime < CYCLE_INTERVAL) return;

    lastSuggestionTime = Date.now();
    const suggestion = await fetchSuggestion(nodesMap);
    if (suggestion && suggestion.prompt) {
      createBubble(suggestion);
    }
  }, CYCLE_INTERVAL);
}

export function stopCuriosityEngine() {
  if (curiosityTimer) { clearInterval(curiosityTimer); curiosityTimer = null; }
  dismissBubble();
}

export function dismissCurrent() { dismissBubble(); }
