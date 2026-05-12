# Liquid-State Engine

**Interactive Visual Computing Platform** — CPU-only, DOM-free rendering engine.

A holographic-like workspace that bypasses the browser's normal rendering pipeline entirely. Uses a single `<canvas>` element as the display surface, with all logic, physics, and pixel rendering handled by Rust compiled to WebAssembly.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      JavaScript Host (Main Thread)           │
│  Canvas 2D │ Input Events │ HUD (Preact) │ Payload Registry │
└────────┬──────────────────────────────┬─────────────────────┘
         │ SharedArrayBuffer             │ postMessage
         │ (COOP/COEP required)          │ (fallback)
┌────────▼──────────────────────────────▼─────────────────────┐
│                   Web Worker (optional)                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │               Rust / WebAssembly Core                 │    │
│  │                                                      │    │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │    │
│  │  │ ECS(SoA) │  │ Quadtree │  │ Software Renderer │  │    │
│  │  └────┬─────┘  └────┬─────┘  │ + Dirty Rects     │  │    │
│  │       │              │        └────────┬──────────┘  │    │
│  │  ┌────▼──────────────▼─────────────────▼─────────┐   │    │
│  │  │   Physics (Symplectic Euler + Spring Drag)    │   │    │
│  │  │   Relations (Merge OR / Fracture decompose)   │   │    │
│  │  │   Event Queue (spawn/despawn/merge/fracture)  │   │    │
│  │  └───────────────────────────────────────────────┘   │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

## Key Features

- **Zero DOM** — No HTML elements, no CSS layout. Pure pixel control.
- **CPU-only** — No WebGL/GPU dependency. Runs on any machine.
- **ECS + SoA** — Cache-friendly data layout for max CPU throughput.
- **Quadtree** — Spatial partitioning reduces collision from O(N²) to ~O(N log N).
- **Dirty Rectangles** — Only redraws changed screen regions.
- **Bitwise Logic** — Merge (OR) and Fracture (decompose) in 1 CPU clock cycle.
- **Liquid Physics** — Viscosity, momentum, boundary reflection for fluid motion.
- **Data Payload System** — Each node carries an opaque payload (text, number, JSON, array). Rules determine how payloads combine on merge or split on fracture.
- **Draw Mode** — Drag a path on canvas to create nodes with custom payloads.
- **Spring-Damped Drag** — Pin nodes to cursor via Hooke's law spring + damping.
- **Glassmorphism HUD** — Preact overlay with translucent panels, blur, mode switcher, inspector, and physics config.
- **Web Worker** — Offload physics/rendering to a background thread via SharedArrayBuffer + Atomics or transfer-based postMessage fallback.
- **Drag & Drop** — Drop files/text onto canvas to create nodes with detected payloads.

## Data Payload System

Each node in the engine is a "shell" — a physical entity with position, velocity, and radius. The payload system (`web/payload.js`) maintains a separate `Map<entityId, payload>` on the JS side. Payloads are arbitrary:

```js
{ type: 'text',    value: 'hello world',        label: 'greeting' }
{ type: 'number',  value: 42,                   label: 'answer'   }
{ type: 'json',    value: { x: 10, y: 20 },     label: 'point'    }
{ type: 'array',   value: [1, 2, 3],            label: 'list'     }
{ type: 'composite', value: { items: [...] },    label: 'mixed'    }
```

Events emitted from Wasm (`merge`, `fracture`, `spawn`, `despawn`) are decoded and applied to the payload registry automatically.

### Rule Engine (`web/rules.js`)

Pure functions that determine how payloads combine or split:

| Operation | text | number | json | array | mixed |
|-----------|------|--------|------|-------|-------|
| **Merge** | Concatenate with `\n` | Sum (configurable) | Shallow merge, conflict → composite | Concatenate items | Wrap in composite |
| **Fracture** | Split by word/token | Divide equally | Each key/value → node | Each element → node | Generic split |

Numeric merge reducer is configurable at runtime: sum (default), average, or product.

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- Node.js (for dev server)

### Build & Run

```bash
# Install wasm-pack if needed
cargo install wasm-pack

# Build WebAssembly module
npm run build:wasm

# Start dev server (with COOP/COEP headers for SharedArrayBuffer)
npm run serve

# Open http://localhost:8080/web/
# Example page: http://localhost:8080/examples/data-workflow.html
```

### COOP/COEP Headers

For the Web Worker SharedArrayBuffer path to work, the server must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The included `scripts/serve.js` sets these automatically. If you use another server, ensure these headers are present. Without them, the engine falls back to transfer-based postMessage or single-threaded mode.

## Project Structure

```
├── Cargo.toml              # Rust project config (wasm-bindgen)
├── package.json            # Build & test scripts
├── src/
│   ├── lib.rs              # Engine entry point + event queue (exposed to JS)
│   ├── ecs.rs              # Entity Component System (SoA arrays, free-list)
│   ├── quadtree.rs         # Spatial partitioning (recursive quadrant)
│   ├── renderer.rs         # CPU pixel buffer + dirty rectangles
│   ├── physics.rs          # Symplectic Euler, spring drag, viscosity, bounds
│   └── relations.rs        # Bitwise merge/fracture logic + events
├── web/
│   ├── index.html          # Single-page canvas host + HUD mount
│   ├── main.js             # JS host (canvas, input, render loop, payload)
│   ├── payload.js          # Payload registry (Map<entityId, payload>)
│   ├── rules.js            # Generic rule engine (merge/fracture per type)
│   ├── worker.js           # Web Worker (owns Wasm engine)
│   ├── worker-engine.js    # Worker adapter (SharedArrayBuffer + fallback)
│   └── hud/
│       ├── app.js          # Preact + htm glassmorphism HUD
│       └── style.css       # Glassmorphism panel styles
├── examples/
│   └── data-workflow.html  # Demo: JSON/number/text datasets
├── scripts/
│   └── serve.js            # Dev server with COOP/COEP headers
└── .cargo/
    └── config.toml         # Wasm target + SIMD flags
```

## Interactions

- **Click empty space** — Burst-spawn 50 new nodes
- **Click + Drag node** — Spring-damped drag (pin to cursor)
- **Double-click node** — Fracture into components
- **Draw mode** — Drag path on empty canvas, then enter label/payload for new node
- **Drag-and-drop** — Drop files or text onto canvas to create payload nodes
- **HUD mode buttons** — Switch between Select / Draw modes
- **HUD toolbar** — Configure numeric merge reducer, toggle gravity, adjust viscosity

## Development Phases

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Foundation & Memory (ECS, Cargo setup) | Done |
| 2 | Space & Rendering (Quadtree, Software Renderer, Dirty Rects) | Done |
| 3 | Interaction (Input, Physics, Fracture gestures) | Done |
| 4 | Relational Logic (Bitmask collision, Merge/Fracture) | Done |
| 5 | Holographic Core (Payload system, Rule engine, HUD, Worker, Spring drag, Tests) | Done |
| 6 | Visual Effects (Glassmorphism trails, glow, particle FX) | Next |

## License

MIT
