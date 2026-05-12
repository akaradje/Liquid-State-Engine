# Development Log — Ultra-Lite DOM Architecture

**Date**: 2026-05-12
**Branch**: `feat/phase6-perf-max`
**Architecture**: Pure HTML/JS/CSS — no Wasm, no canvas, no GPU

---

## 1. Architecture Decision

The Rust/WebAssembly engine was replaced with a pure DOM-based system. Rationale:

- **Complexity**: The Wasm engine required `wasm-pack` build toolchain, SIMD intrinsics, double-buffering, bitmap font rendering, ECS with SoA layout, quadtree/spatial grid, and a 2000-line renderer. For an interactive knowledge workspace handling dozens to hundreds of nodes (not thousands), this was over-engineered.
- **Deployment**: Wasm required COOP/COEP headers and SharedArrayBuffer for the worker path. The DOM system runs on any static file server with zero configuration.
- **Maintainability**: The DOM system is ~150 lines of JS vs ~2000 lines of Rust + ~500 lines of JS glue. Adding features like text editing, context menus, or animations is trivial with DOM.

---

## 2. New Architecture

```
┌──────────────────────────────────────────────────┐
│                  index.html                       │
│  ┌────────────────────────────────────────────┐  │
│  │  #workspace (full-screen div)              │  │
│  │                                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐ │  │
│  │  │ .data-box│  │ .data-box│  │ .data-box│ │  │
│  │  │ "Rainbow"│  │ "Engine" │  │ "Wheels" │ │  │
│  │  └──────────┘  └──────────┘  └──────────┘ │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│  ┌──────────┐  ┌──────────────────────────────┐  │
│  │ #hud-app │  │ #create-btn (+ New Node)     │  │
│  │ (Preact) │  │                              │  │
│  └──────────┘  └──────────────────────────────┘  │
└──────────────────────────────────────────────────┘
         │
         │ POST /api/enrich
         ▼
┌──────────────────────────────────────────────────┐
│              scripts/serve.js                     │
│  DeepSeek V4 Proxy (intelligent model routing)    │
│  LITE → deepseek-chat                            │
│  STANDARD → deepseek-chat                        │
│  ULTRA → deepseek-reasoner                       │
└──────────────────────────────────────────────────┘
```

---

## 3. File Map

| File | Role |
|------|------|
| `web/index.html` | Entry point — workspace div, create button, HUD mount |
| `web/style.css` | Glassmorphism styles for `.data-box`, `.input-overlay`, `#create-btn` |
| `web/main.js` | Core logic — `createNode()`, drag system, `fractureNode()`, input dialog |
| `web/ai-enrich.js` | DeepSeek API proxy client (unchanged from Phase 5) |
| `web/hud/app.js` | Simplified Preact HUD — node count + usage hints |
| `web/hud/style.css` | Glassmorphism panel styles (unchanged) |
| `scripts/serve.js` | Dev server with `/api/enrich` proxy + COOP/COEP headers |
| `DEVELOPMENT_LOG_LITE.md` | This document |

---

## 4. Interaction Model

| Gesture | Action |
|---------|--------|
| **Double-click empty space** | Opens input dialog → creates node at click position |
| **Click "+ New Node" button** | Opens input dialog at screen center |
| **Drag data box** | Moves freely anywhere on screen |
| **Drag box onto another box** | Collision detection → gold glow → release to **AI merge** (combine keywords) |
| **Double-click data box** | Calls DeepSeek API → deletes parent → spawns child nodes in circular burst |
| **Type keyword + Enter** | Creates node → auto-triggers AI enrichment in background |

---

## 5. AI Enrichment Flow

```
1. User creates node with keyword "Rainbow"
2. ai-enrich.js calls POST /api/enrich { keyword: "Rainbow" }
3. Server routes to DeepSeek (STANDARD tier → deepseek-chat)
4. DeepSeek returns ["Refraction", "Water Vapor", "Visible Light", ...]
5. Node gets .enriched class (✦ indicator) + data-components cache
6. User double-clicks the node
7. fractureNode() reads cached components, deletes parent,
   spawns 3-7 child nodes in circular burst pattern
8. Each child: "Refraction", "Water Vapor", "Visible Light"
```

---

## 6. Merge Logic (Drag A onto B → AI Combine)

The merge system allows users to combine two concepts by dragging one data-box onto another.

### Interaction Flow

```
1. User drags box "Hydrogen" over box "Oxygen"
2. During drag: collision detection via getBoundingClientRect()
   → 35% overlap threshold triggers .merge-target class (gold glow)
3. User releases mouse while overlapping
4. Both boxes get .enriching class (dashed pulse)
5. POST /api/enrich { mode: "merge", keywords: ["Hydrogen", "Oxygen"] }
6. Server calls DeepSeek with merge prompt:
   "What is the logical or scientific result of combining 'Hydrogen'
    and 'Oxygen'? Return only 1-2 words."
7. DeepSeek returns "Water"
8. Both source boxes are deleted
9. A new .data-box is created at the midpoint with "Water"
10. New box gets .merged class → flash animation (scale-up + glow fade)
11. Auto-triggers enrichment so "Water" can be fractured later
```

### Collision Detection

```javascript
function boxesOverlap(a, b) {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const overlapX = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
  const overlapY = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
  const overlapArea = overlapX * overlapY;
  const minArea = Math.min(ra.width * ra.height, rb.width * rb.height);
  return overlapArea > minArea * 0.35; // 35% overlap threshold
}
```

### Visual Feedback

| State | CSS Class | Visual |
|-------|-----------|--------|
| Dragging over valid target | `.merge-target` | Gold border glow, pulsing box-shadow |
| During merge API call | `.enriching` | Dashed border, blue pulse |
| Merged result appears | `.merged` | Scale-up flash (1.3→1.0) with gold glow fade |

### Server-Side

The `/api/enrich` endpoint now supports `mode: "merge"`:
```json
POST /api/enrich
{ "mode": "merge", "keywords": ["Hydrogen", "Oxygen"] }

Response:
{ "result": "Water", "model": "deepseek-chat", "tier": "STANDARD" }
```

### Merge Prompt

```
What is the logical or scientific result of combining "[A]" and "[B]"?
Return only 1-2 words.
Examples:
  "Hydrogen" + "Oxygen" → "Water"
  "Carbon" + "Iron" → "Steel"
  "Red" + "Blue" → "Purple"
  "Sun" + "Rain" → "Rainbow"
Do not include explanations or punctuation.
```

---

## 7. CSS Glassmorphism

All data boxes use the same design language:

```css
.data-box {
  background: rgba(18, 22, 36, 0.82);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(100, 180, 255, 0.22);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.45);
}
```

States:
- **Default**: Subtle cyan border, dark translucent fill
- **Hover**: Brighter border, subtle glow
- **Dragging**: Stronger border, elevated shadow, grabbing cursor
- **Enriched** (✦): Green-tinted border, star indicator
- **Child** (fractured): Purple-tinted border, spawn-in animation

---

## 7. Constraints Maintained

- **No canvas** — everything is pure DOM
- **No WebGL/GPU** — CSS rendering only
- **No SharedArrayBuffer required** — no COOP/COEP headers needed for core functionality
- **Runs on any browser** — no Wasm, no workers, no special features
- **Minimal dependencies** — Preact+htm via CDN for the HUD only
- **AI enrichment** — same DeepSeek V4 proxy, now called directly from DOM event handlers

---

## 8. Deleted Files

The following were part of the Wasm architecture and are no longer needed:

- `src/` — entire Rust source tree (ecs, quadtree, renderer, physics, relations, spatial_grid)
- `web/pkg/` — compiled Wasm output
- `web/worker.js` — Web Worker
- `web/worker-engine.js` — Worker adapter
- `web/payload.js` — Wasm event-driven payload registry
- `web/rules.js` — merge/fracture rules (logic moved inline)
- `Cargo.toml`, `Cargo.lock`, `.cargo/` — Rust build config

---

## 9. Startup

```bash
# Start the server (with or without AI key)
npm run serve

# Open http://localhost:8080/web/
# Double-click empty space to create your first node
```
