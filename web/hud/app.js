/**
 * Liquid-State Engine — Glassmorphism HUD (Ultra-Lite Edition)
 *
 * Built with Preact + htm via CDN. Renders ABOVE the workspace.
 * Displays node count and AI enrichment status.
 */

import { h, Component, render } from 'https://esm.sh/preact@10.19.6';
import htm from 'https://esm.sh/htm@3.1.1';
const html = htm.bind(h);

// ---- HUD Shell ----

class HUDApp extends Component {
  constructor() {
    super();
    this.state = {
      nodeCount: 0,
      avgConfidence: 0,
      audioMuted: false,
    };
    this._tick = this._tick.bind(this);
  }

  componentDidMount() {
    this._interval = setInterval(this._tick, 500);
  }

  componentWillUnmount() {
    clearInterval(this._interval);
  }

  _tick() {
    const count = window.lse?.getNodeCount?.() ?? 0;
    let avgConf = 0;
    const els = document.querySelectorAll('.data-box[data-confidence]');
    if (els.length > 0) {
      let sum = 0;
      for (const el of els) {
        sum += parseFloat(el.dataset.confidence) || 0;
      }
      avgConf = Math.round((sum / els.length) * 100);
    }
    const muted = (() => { try { return localStorage.getItem('lse-audio-muted') === 'true'; } catch { return false; } })();
    this.setState({ nodeCount: count, avgConfidence: avgConf, audioMuted: muted });
  }

  _trustBar(pct) {
    const filled = Math.round(pct / 10);
    return '█'.repeat(Math.max(0, Math.min(10, filled))) +
           '░'.repeat(Math.max(0, 10 - filled));
  }

  render(_, state) {
    return html`
      <div class="hud-root">
        <${StatsPanel} nodes=${state.nodeCount} trust=${state.avgConfidence} trustBar=${this._trustBar(state.avgConfidence)} />
        <${InfoPanel} muted=${state.audioMuted} />
      </div>
    `;
  }
}

// ---- Stats Panel (top-left) ----

const StatsPanel = ({ nodes, trust, trustBar }) => html`
  <div class="hud-panel hud-top-left">
    <div class="hud-stat"><span class="hud-label">NODES</span> <span class="hud-val">${nodes}</span></div>
    <div class="hud-stat">
      <span class="hud-label">TRUST</span>
      <span class="hud-val hud-trust">
        <span class="hud-trust-bar">${trustBar}</span>
        <span>${trust}%</span>
      </span>
    </div>
    <div class="hud-stat"><span class="hud-label">ONLINE</span> <span id="collab-count" class="hud-val">1</span></div>
    <div class="hud-stat"><span class="hud-label">SIMILAR</span> <span id="sem-sim-count" class="hud-val">—</span></div>
    <div class="hud-stat"><span class="hud-label">TENSIONS</span> <span id="tension-count" class="hud-val">—</span></div>
    <div class="hud-stat"><span class="hud-label">LEARNER</span> <span id="learner-status" class="hud-val">—</span></div>
    <div class="hud-stat"><span class="hud-label">ENGINE</span> <span class="hud-val hud-ok">DOM Lite</span></div>
  </div>
`;

// ---- Info Panel (top-right) ----

const InfoPanel = ({ muted }) => html`
  <div class="hud-panel hud-top-right" style="font-size:10px;gap:6px;display:flex;align-items:center;flex-wrap:wrap;">
    <span style="color:rgba(140,200,255,0.55)">DblClick→Create</span>
    <span style="color:rgba(100,160,220,0.3)">|</span>
    <span style="color:rgba(140,200,255,0.55)">DblClick node→Fracture</span>
    <span style="color:rgba(100,160,220,0.3)">|</span>
    <span style="color:rgba(100,200,160,0.55)">Drag→Merge</span>
    <span style="color:rgba(100,160,220,0.3)">|</span>
    <span style="color:${muted ? 'rgba(255,120,120,0.55)' : 'rgba(120,220,160,0.55)'}">${muted ? '🔇M' : '🔊M'}</span>
    <span style="color:rgba(100,160,220,0.3)">|</span>
    <span style="color:rgba(180,200,140,0.5)">S:Save</span>
    <span style="color:rgba(180,200,140,0.5)">L:Load</span>
    <span style="color:rgba(200,140,140,0.5)">X:Clear</span>
  </div>
`;

// ---- Mount ----

const container = document.getElementById('hud-app');
if (container) {
  render(html`<${HUDApp} />`, container);
}
