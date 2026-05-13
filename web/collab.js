/**
 * Real-Time Collaboration Client
 *
 * Connects to collab-server.js via WebSocket.
 * Broadcasts local events and applies remote events.
 * Shows remote user cursors and user-colored node borders.
 */

const WS_URL = window.__LSE_CONFIG__?.collabServer || `ws://localhost:8081`;

let ws = null;
let myUserId = null;
let myColor = null;
let myName = null;
let onlineCount = 0;

/** @type {Map<string, { x: number, y: number, color: string, name: string }>} */
const remoteCursors = new Map();
const cursorEls = new Map();

/** Callbacks for applying remote events locally */
let onCreateNode = null;
let onDeleteNode = null;
let onFractureNode = null;
let onMergeNodes = null;
let onMoveNode = null;

// ---- Public API ----

export function connect() {
  return new Promise((resolve) => {
    try {
      ws = new WebSocket(WS_URL);
    } catch { resolve(false); return; }

    ws.onopen = () => {
      console.log(`[Collab] Connected to ${WS_URL}`);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'welcome':
          myUserId = msg.userId;
          myColor = msg.color;
          myName = msg.name;
          onlineCount = msg.onlineCount;
          resolve(true);
          // Apply full room state for late join sync
          if (msg.state?.nodes?.length > 0) {
            applyRoomState(msg.state);
          }
          break;

        case 'user-joined':
          onlineCount = msg.onlineCount;
          updateHUDCount();
          break;

        case 'user-left':
          onlineCount = msg.onlineCount;
          updateHUDCount();
          removeRemoteCursor(msg.userId);
          break;

        case 'cursor-move':
          updateRemoteCursor(msg.userId, msg.x, msg.y, msg.color, msg.name);
          break;

        case 'node-created':
          if (onCreateNode) onCreateNode(msg.text, msg.x, msg.y, msg.userId, msg.color);
          break;

        case 'node-deleted':
          if (onDeleteNode) onDeleteNode(msg.id);
          break;

        case 'node-fractured':
          if (onFractureNode) onFractureNode(msg.parentId, msg.children, msg.userId);
          break;

        case 'node-merged':
          if (onMergeNodes) onMergeNodes(msg.idA, msg.idB, msg.result, msg.resultId, msg.x, msg.y, msg.userId);
          break;

        case 'node-moved':
          if (onMoveNode) onMoveNode(msg.id, msg.x, msg.y);
          break;

        case 'conflict':
          showConflictToast(msg.reason);
          break;
      }
    };

    ws.onclose = () => {
      onlineCount = 0;
      updateHUDCount();
      console.log('[Collab] Disconnected');
    };

    ws.onerror = () => resolve(false);

    // Timeout after 3 seconds
    setTimeout(() => resolve(false), 3000);
  });
}

export function isConnected() { return ws?.readyState === 1; }
export function getMyUserId() { return myUserId; }
export function getMyColor() { return myColor; }
export function getOnlineCount() { return onlineCount; }

// ---- Setup callbacks for applying remote events ----

export function onRemoteCreate(fn) { onCreateNode = fn; }
export function onRemoteDelete(fn) { onDeleteNode = fn; }
export function onRemoteFracture(fn) { onFractureNode = fn; }
export function onRemoteMerge(fn) { onMergeNodes = fn; }
export function onRemoteMove(fn) { onMoveNode = fn; }

// ---- Sending events ----

function send(msg) {
  if (!isConnected()) return;
  ws.send(JSON.stringify(msg));
}

export function broadcastCreate(id, text, x, y) {
  send({ type: 'node-created', id, text, x, y });
}

export function broadcastDelete(id) {
  send({ type: 'node-deleted', id });
}

export function broadcastFracture(parentId, children) {
  send({ type: 'node-fractured', parentId, children });
}

export function broadcastMerge(idA, idB, result, resultId, x, y) {
  send({ type: 'node-merged', idA, idB, result, resultId, x, y });
}

export function broadcastMove(id, x, y) {
  send({ type: 'node-moved', id, x, y });
}

export function broadcastCursor(x, y) {
  send({ type: 'cursor-move', x, y });
}

// ---- Remote Cursors ----

function updateRemoteCursor(userId, x, y, color, name) {
  remoteCursors.set(userId, { x, y, color, name });

  let el = cursorEls.get(userId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'remote-cursor';
    el.style.position = 'fixed';
    el.style.zIndex = '9999';
    el.style.pointerEvents = 'none';
    el.style.width = '12px';
    el.style.height = '12px';
    el.style.borderRadius = '50%';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.boxShadow = `0 0 8px ${color}`;
    el.innerHTML = `<span style="position:absolute;top:14px;left:8px;font-size:9px;color:${color};white-space:nowrap;font-family:monospace;">${name}</span>`;
    document.body.appendChild(el);
    cursorEls.set(userId, el);
  }
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.background = color;

  // Auto-remove after 5 seconds of no updates
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => removeRemoteCursor(userId), 5000);
}

function removeRemoteCursor(userId) {
  const el = cursorEls.get(userId);
  if (el) { el.remove(); cursorEls.delete(userId); }
  remoteCursors.delete(userId);
}

// ---- Room State Sync ----

function applyRoomState(state) {
  if (!state?.nodes?.length) return;
  for (const n of state.nodes) {
    if (onCreateNode) onCreateNode(n.text, n.x, n.y, n.userId || 'remote', null);
  }
}

// ---- Conflict Toast ----

function showConflictToast(reason) {
  const toast = document.createElement('div');
  toast.className = 'lse-toast';
  toast.textContent = `⚠️ ${reason}`;
  toast.style.cssText = `
    position:fixed; bottom:100px; left:50%; transform:translateX(-50%);
    z-index:9999; pointer-events:none;
    background:rgba(40,10,10,0.9); backdrop-filter:blur(12px);
    border:1px solid rgba(255,100,100,0.4); border-radius:8px;
    padding:8px 18px; color:rgba(255,180,180,0.9);
    font-family:monospace; font-size:11px;
    animation:toastIn 0.3s ease-out, toastOut 0.3s 2s ease-in forwards;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

function updateHUDCount() {
  const el = document.getElementById('collab-count');
  if (el) el.textContent = String(onlineCount);
}
