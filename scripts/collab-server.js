/**
 * Collaboration WebSocket Relay Server
 *
 * Broadcasts all messages to all connected clients except the sender.
 * Maintains room state for late joiners.
 *
 * Usage: node scripts/collab-server.js [port]
 */

const { WebSocketServer } = require('ws');

const PORT = process.argv[2] || 8081;
const HEARTBEAT_INTERVAL = 15000;

/** @type {Map<string, { ws: WebSocket, color: string, name: string }>} */
const clients = new Map();

/** Current room state: all nodes on the workspace */
let roomState = { nodes: [] };

// Predefined cursor colors
const COLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A78BFA','#F472B6','#60A5FA','#34D399','#FB923C'];
let colorIndex = 0;

const wss = new WebSocketServer({ port: PORT });

console.log(`🔗 Collab server running on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  const name = `User ${clients.size + 1}`;

  clients.set(userId, { ws, color, name });

  // Send welcome + full state
  ws.send(JSON.stringify({
    type: 'welcome',
    userId,
    color,
    name,
    state: roomState,
    onlineCount: clients.size,
  }));

  // Notify others
  broadcast({ type: 'user-joined', userId, color, name, onlineCount: clients.size }, ws);
  console.log(`[+] ${name} (${userId}) — ${clients.size} online`);

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Update room state for node events
    switch (msg.type) {
      case 'node-created':
        roomState.nodes.push({ id: msg.id, text: msg.text, x: msg.x, y: msg.y, userId });
        break;
      case 'node-moved':
        roomState.nodes = roomState.nodes.map(n =>
          n.id === msg.id ? { ...n, x: msg.x, y: msg.y } : n
        );
        break;
      case 'node-deleted':
        roomState.nodes = roomState.nodes.filter(n => n.id !== msg.id);
        break;
      case 'node-fractured':
        roomState.nodes = roomState.nodes.filter(n => n.id !== msg.parentId);
        if (msg.children) {
          for (const c of msg.children) {
            roomState.nodes.push({ id: c.id, text: c.text, x: c.x, y: c.y, userId });
          }
        }
        break;
      case 'node-merged':
        roomState.nodes = roomState.nodes.filter(n => n.id !== msg.idA && n.id !== msg.idB);
        roomState.nodes.push({ id: msg.resultId, text: msg.result, x: msg.x, y: msg.y, userId });
        break;
    }

    // Attach sender userId to all messages
    msg.userId = userId;
    msg.color = color;
    msg.name = name;
    broadcast(msg, ws);
  });

  ws.on('close', () => {
    clients.delete(userId);
    broadcast({ type: 'user-left', userId, onlineCount: clients.size }, ws);
    console.log(`[-] ${name} — ${clients.size} online`);
  });
});

function broadcast(msg, excludeWs) {
  const data = JSON.stringify(msg);
  for (const [, client] of clients) {
    if (client.ws !== excludeWs && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

// Heartbeat pings
setInterval(() => {
  for (const [, client] of clients) {
    if (!client.ws.isAlive) {
      client.ws.terminate();
      continue;
    }
    client.ws.isAlive = false;
    client.ws.ping();
  }
}, HEARTBEAT_INTERVAL);

console.log('  Auto-assigns colors + names');
console.log('  Maintains room state for late joiners');
