# Liquid-State Engine

**Interactive Visual Computing Platform** — CPU-only, DOM-free rendering engine.

A holographic-like workspace that bypasses the browser's normal rendering pipeline entirely. Uses a single `<canvas>` element as the display surface, with all logic, physics, and pixel rendering handled by Rust compiled to WebAssembly.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  JavaScript Host                 │
│  Canvas 2D │ Input Events │ requestAnimationFrame│
└──────────────────────┬──────────────────────────┘
                       │ SharedArrayBuffer / Wasm Memory
┌──────────────────────▼──────────────────────────┐
│              Rust / WebAssembly Core             │
│                                                 │
│  ┌─────────┐  ┌──────────┐  ┌──────────────┐   │
│  │   ECS   │  │ Quadtree │  │  Pixel Buffer│   │
│  │  (SoA)  │  │ Spatial  │  │  Renderer    │   │
│  └────┬────┘  └────┬─────┘  └──────┬───────┘   │
│       │             │               │           │
│  ┌────▼─────────────▼───────────────▼───────┐   │
│  │         Physics & Relations System       │   │
│  │   Viscosity │ Collision │ Merge/Fracture │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Key Features

- **Zero DOM** — No HTML elements, no CSS layout. Pure pixel control.
- **CPU-only** — No WebGL/GPU dependency. Runs on any machine.
- **ECS + SoA** — Cache-friendly data layout for max CPU throughput.
- **Quadtree** — Spatial partitioning reduces collision from O(N²) to ~O(N log N).
- **Dirty Rectangles** — Only redraws changed screen regions.
- **Bitwise Logic** — Merge (OR) and Fracture (decompose) in 1 CPU clock cycle.
- **Liquid Physics** — Viscosity, momentum, boundary reflection for fluid motion.

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

# Start dev server
npm run serve

# Open http://localhost:8080/web/
```

### Interactions

- **Click empty space** — Spawn new nodes (burst pattern)
- **Click + Drag node** — Apply force (fluid drag)
- **Double-click node** — Fracture into components

## Project Structure

```
├── Cargo.toml          # Rust project config (wasm-bindgen)
├── package.json        # Build scripts
├── src/
│   ├── lib.rs          # Engine entry point (exposed to JS)
│   ├── ecs.rs          # Entity Component System (SoA arrays)
│   ├── quadtree.rs     # Spatial partitioning
│   ├── renderer.rs     # CPU pixel buffer + dirty rectangles
│   ├── physics.rs      # Kinematics (viscosity, velocity, bounds)
│   └── relations.rs    # Bitwise merge/fracture logic
├── web/
│   ├── index.html      # Single-page canvas host
│   └── main.js         # JS host layer (canvas, input, render loop)
└── .cargo/
    └── config.toml     # Wasm target + SIMD flags
```

## Development Phases

- [x] Phase 1: Foundation & Memory (ECS, Cargo setup)
- [x] Phase 2: Space & Rendering (Quadtree, Software Renderer, Dirty Rects)
- [x] Phase 3: Interaction (Input, Physics, Fracture gestures)
- [x] Phase 4: Relational Logic (Bitmask collision, Merge/Fracture)
- [ ] Phase 5: Web Workers (offload physics to background thread)
- [ ] Phase 6: Visual Effects (Glassmorphism, glow, trails)

## License

MIT
