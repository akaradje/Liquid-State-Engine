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
    this.setState({ nodeCount: count });
  }

  render(_, state) {
    return html`
      <div class="hud-root">
        <${StatsPanel} nodes=${state.nodeCount} />
        <${InfoPanel} />
      </div>
    `;
  }
}

// ---- Stats Panel (top-left) ----

const StatsPanel = ({ nodes }) => html`
  <div class="hud-panel hud-top-left">
    <div class="hud-stat"><span class="hud-label">NODES</span> <span class="hud-val">${nodes}</span></div>
    <div class="hud-stat"><span class="hud-label">ENGINE</span> <span class="hud-val hud-ok">DOM Lite</span></div>
  </div>
`;

// ---- Info Panel (top-right) ----

const InfoPanel = () => html`
  <div class="hud-panel hud-top-right" style="font-size:10px;gap:8px;display:flex;align-items:center;">
    <span style="color:rgba(140,200,255,0.6)">Double-click empty space → Create</span>
    <span style="color:rgba(100,160,220,0.4)">|</span>
    <span style="color:rgba(140,200,255,0.6)">Double-click node → Fracture</span>
    <span style="color:rgba(100,160,220,0.4)">|</span>
    <span style="color:rgba(100,200,160,0.6)">Drag → Move</span>
  </div>
`;

// ---- Mount ----

const container = document.getElementById('hud-app');
if (container) {
  render(html`<${HUDApp} />`, container);
}
