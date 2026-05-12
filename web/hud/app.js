/**
 * Liquid-State Engine — Glassmorphism HUD
 *
 * Built with Preact + htm via CDN (zero build step).
 * Renders ABOVE the canvas, pointer-events: none by default.
 */

import { h, Component, render } from 'https://esm.sh/preact@10.19.6';
import htm from 'https://esm.sh/htm@3.1.1';
const html = htm.bind(h);

// ---- HUD Shell (glassmorphism container) ----

class HUDApp extends Component {
  constructor() {
    super();
    this.state = {
      fps: 0,
      nodeCount: 0,
      dirtySize: '0x0',
      engineStatus: 'loading...',
      mode: 'select',   // 'select' | 'draw' | 'fracture'
      pickedNode: null, // { id, payload } or null
      showPayloadDialog: false,
      drawNodeId: null,
      numericReducer: 'sum',
      gravityEnabled: false,
      viscosity: 0.02,
      labelInput: '',
      valueInput: '',
    };

    this._tick = this._tick.bind(this);
    this._onPick = this._onPick.bind(this);
    this._onDrawNode = this._onDrawNode.bind(this);
  }

  componentDidMount() {
    this._interval = setInterval(this._tick, 200);
    window.addEventListener('lse-pick', this._onPick);
    window.addEventListener('lse-drawnode', this._onDrawNode);
  }

  componentWillUnmount() {
    clearInterval(this._interval);
    window.removeEventListener('lse-pick', this._onPick);
    window.removeEventListener('lse-drawnode', this._onDrawNode);
  }

  _tick() {
    const fpsEl = document.getElementById('fps');
    const nodesEl = document.getElementById('nodes');
    const dirtyEl = document.getElementById('dirty');
    const statusEl = document.getElementById('status');
    this.setState({
      fps: fpsEl?.textContent || '0',
      nodeCount: nodesEl?.textContent || '0',
      dirtySize: dirtyEl?.textContent || '0x0',
      engineStatus: statusEl?.textContent || 'ACTIVE',
    });
  }

  _onPick(e) {
    this.setState({ pickedNode: e.detail.payload ? e.detail : null });
  }

  _onDrawNode(e) {
    this.setState({ showPayloadDialog: true, drawNodeId: e.detail.id, labelInput: '', valueInput: '' });
  }

  _setMode(mode) {
    this.setState({ mode });
    if (window.lse) window.lse.setDrawMode(mode === 'draw');
  }

  _submitPayload() {
    const { drawNodeId, labelInput, valueInput } = this.state;
    if (drawNodeId == null) return;
    const raw = valueInput.trim();
    let payload;
    if (!raw) {
      payload = { type: 'text', value: labelInput || 'empty', label: labelInput || 'untitled' };
    } else {
      payload = window.lse?.getRules().detectPayload(raw);
      payload.label = labelInput || payload.type;
    }
    window.lse?.getPayloads().register(drawNodeId, payload);
    this.setState({ showPayloadDialog: false, drawNodeId: null, labelInput: '', valueInput: '' });
  }

  _setReducer(mode) {
    this.setState({ numericReducer: mode });
    window.lse?.getRules().setNumericReducer(mode);
  }

  _toggleGravity() {
    const on = !this.state.gravityEnabled;
    this.setState({ gravityEnabled: on });
    window.lse?.setGravity(on ? 200 : 0);
  }

  _setViscosity(v) {
    this.setState({ viscosity: v });
    window.lse?.setViscosity(v);
  }

  render(_, state) {
    return html`
      <div class="hud-root">
        <${StatsPanel} fps=${state.fps} nodes=${state.nodeCount} dirty=${state.dirtySize} status=${state.engineStatus} />
        <${ModeSwitcher} mode=${state.mode} onSetMode=${m => this._setMode(m)} />
        <${InspectorPanel} node=${state.pickedNode} />
        <${Toolbar}
          reducer=${state.numericReducer}
          gravity=${state.gravityEnabled}
          viscosity=${state.viscosity}
          onSetReducer=${m => this._setReducer(m)}
          onToggleGravity=${() => this._toggleGravity()}
          onSetViscosity=${v => this._setViscosity(v)}
        />
        ${state.showPayloadDialog && html`
          <${PayloadDialog}
            label=${state.labelInput}
            value=${state.valueInput}
            onLabel=${v => this.setState({ labelInput: v })}
            onValue=${v => this.setState({ valueInput: v })}
            onSubmit=${() => this._submitPayload()}
            onCancel=${() => this.setState({ showPayloadDialog: false, drawNodeId: null })}
          />
        `}
      </div>
    `;
  }
}

// ---- Stats Panel (top-left) ----

const StatsPanel = ({ fps, nodes, dirty, status }) => html`
  <div class="hud-panel hud-top-left">
    <div class="hud-stat"><span class="hud-label">FPS</span> <span class="hud-val">${fps}</span></div>
    <div class="hud-stat"><span class="hud-label">NODES</span> <span class="hud-val">${nodes}</span></div>
    <div class="hud-stat"><span class="hud-label">DIRTY</span> <span class="hud-val">${dirty}</span></div>
    <div class="hud-stat"><span class="hud-label">ENGINE</span> <span class="hud-val ${status === 'ACTIVE' ? 'hud-ok' : ''}">${status}</span></div>
  </div>
`;

// ---- Mode Switcher (top-right) ----

const modes = [
  { id: 'select', label: 'Select', icon: '⊙' },
  { id: 'draw', label: 'Draw', icon: '✎' },
  { id: 'fracture', label: 'Fracture', icon: '⟐' },
];

const ModeSwitcher = ({ mode, onSetMode }) => html`
  <div class="hud-panel hud-top-right">
    ${modes.map(m => html`
      <button
        key=${m.id}
        class="hud-mode-btn ${mode === m.id ? 'hud-mode-active' : ''}"
        onClick=${() => onSetMode(m.id)}
        title=${m.label}
      >${m.icon}</button>
    `)}
  </div>
`;

// ---- Inspector Panel (floating, shown when node picked) ----

const InspectorPanel = ({ node }) => html`
  ${node ? html`
    <div class="hud-panel hud-inspector">
      <div class="hud-inspector-title">Node #${node.id}</div>
      <div class="hud-stat"><span class="hud-label">TYPE</span> <span class="hud-val">${node.payload?.type || '—'}</span></div>
      <div class="hud-stat"><span class="hud-label">LABEL</span> <span class="hud-val">${node.payload?.label || '—'}</span></div>
      <div class="hud-stat"><span class="hud-label">VALUE</span> <span class="hud-val hud-val-sm">${truncate(displayValue(node.payload), 60)}</span></div>
    </div>
  ` : null}
`;

function displayValue(payload) {
  if (!payload) return '—';
  if (payload.type === 'json' || payload.type === 'composite') {
    try { return JSON.stringify(payload.value); } catch { return String(payload.value); }
  }
  return String(payload.value ?? '—');
}

function truncate(s, max) {
  return s && s.length > max ? s.slice(0, max) + '…' : s;
}

// ---- Bottom Toolbar ----

const reducers = [
  { id: 'sum', label: 'Σ Sum' },
  { id: 'avg', label: 'μ Avg' },
  { id: 'product', label: 'Π Prod' },
];

const Toolbar = ({ reducer, gravity, viscosity, onSetReducer, onToggleGravity, onSetViscosity }) => html`
  <div class="hud-panel hud-toolbar">
    <div class="hud-toolbar-group">
      <span class="hud-toolbar-label">Numeric Merge</span>
      <div class="hud-toolbar-btns">
        ${reducers.map(r => html`
          <button
            key=${r.id}
            class="hud-tb-btn ${reducer === r.id ? 'hud-tb-active' : ''}"
            onClick=${() => onSetReducer(r.id)}
          >${r.label}</button>
        `)}
      </div>
    </div>
    <div class="hud-toolbar-group">
      <span class="hud-toolbar-label">Gravity</span>
      <button
        class="hud-tb-btn hud-toggle ${gravity ? 'hud-tb-active' : ''}"
        onClick=${onToggleGravity}
      >${gravity ? 'ON ▼' : 'OFF'}</button>
    </div>
    <div class="hud-toolbar-group">
      <span class="hud-toolbar-label">Viscosity</span>
      <input
        type="range"
        min="0"
        max="0.5"
        step="0.005"
        value=${viscosity}
        class="hud-slider"
        onInput=${e => onSetViscosity(parseFloat(e.target.value))}
      />
      <span class="hud-tb-val">${viscosity.toFixed(3)}</span>
    </div>
  </div>
`;

// ---- Payload Input Dialog ----

const PayloadDialog = ({ label, value, onLabel, onValue, onSubmit, onCancel }) => html`
  <div class="hud-overlay">
    <div class="hud-dialog">
      <div class="hud-dialog-title">New Node Payload</div>
      <input
        class="hud-input"
        type="text"
        placeholder="Label (optional)"
        value=${label}
        onInput=${e => onLabel(e.target.value)}
        autofocus
      />
      <textarea
        class="hud-input hud-textarea"
        placeholder="Paste data (JSON, number, or text)..."
        value=${value}
        onInput=${e => onValue(e.target.value)}
        rows=${4}
      />
      <div class="hud-dialog-actions">
        <button class="hud-tb-btn" onClick=${onCancel}>Cancel</button>
        <button class="hud-tb-btn hud-tb-active" onClick=${onSubmit}>Create</button>
      </div>
    </div>
  </div>
`;

// ---- Mount ----

const container = document.getElementById('hud-app');
if (container) {
  render(html`<${HUDApp} />`, container);
}
