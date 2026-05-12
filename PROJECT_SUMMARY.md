# Liquid-State Engine — Complete Project Summary

## What It Is

The Liquid-State Engine is a **CPU-only, DOM-free visual computing platform** written in Rust compiled to WebAssembly. It renders interactive particle/node simulations directly to a single HTML `<canvas>` element by writing raw RGBA pixels, bypassing the browser's entire normal rendering pipeline (no HTML DOM nodes, no CSS, no WebGL/GPU). All computation — physics, collision detection, spatial indexing, and pixel rasterization — runs on the CPU with aggressive SIMD optimization.

The project positions itself as a "holographic liquid workspace" where datasets behave like physical objects: nodes float with momentum and viscosity, collide and bounce off walls, merge on contact, and fracture into components.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│              JavaScript Host Layer (web/)                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ Canvas 2D   │  │ Input Events │  │ Preact HUD (glass) │  │
│  │ putImageData│  │ mouse/touch  │  │ stats/modes/config │  │
│  └──────┬──────┘  └──────┬───────┘  └─────────┬──────────┘  │
│         │                │                     │              │
│  ┌──────┴────────────────┴─────────────────────┴──────────┐  │
│  │  PayloadRegistry (Map<id, payload>)  │  Rule Engine    │  │
│  │  text/number/json/array payloads     │  merge/fracture │  │
│  └────────────────────────────────────────────────────────┘  │
│                              │                                │
│  ┌───────────────────────────┴────────────────────────────┐  │
│  │  WorkerEngine adapter (optional)                        │  │
│  │  SharedArrayBuffer + Atomics  |  postMessage transfer   │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │ Wasm memory / postMessage
┌──────────────────────────┴───────────────────────────────────┐
│               Rust / WebAssembly Core (src/)                  │
│                                                               │
│  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐  │
│  │ ECS World(SoA)│  │ Quadtree/Spatial│  │ SoftwareRenderer│  │
│  │ alive_list    │  │ Grid           │  │ double-buffer   │  │
│  │ free_list     │  │ O(log N)/O(1)  │  │ SIMD clear/fill │  │
│  │ SoA arrays    │  │ zero-alloc     │  │ dirty rects     │  │
│  └───────┬───────┘  └───────┬───────┘  └────────┬────────┘  │
│          │                  │                    │            │
│  ┌───────┴──────────────────┴────────────────────┴────────┐  │
│  │  Physics (Symplectic Euler + f32x4 SIMD)               │  │
│  │  Relations (bitwise OR merge / bit-decompose fracture) │  │
│  │  Event Queue (spawn/despawn/merge/fracture → JS)      │  │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## How It Works (Frame-by-Frame)

Each frame, `LiquidEngine::tick(dt)` executes this sequence:

### 1. Physics Update (`physics.rs`)
- **Integration method**: Symplectic (semi-implicit) Euler — update velocity from forces first, then position from new velocity. More stable than explicit Euler for oscillatory systems.
- **Forces**: Accumulated external forces (user drag, repulsion) become acceleration via `a = F/m`. Mass derives from `bitmask.count_ones()` — composite nodes are heavier.
- **Spring-Damped Pinning**: Nodes "pinned" by the user are pulled toward the cursor via Hooke's law: `F = -k*x - d*v`. Stiffness and damping are configurable.
- **Viscosity**: Velocity-dependent drag: `v *= 1.0 - viscosity`. Produces the "liquid" feel.
- **Boundary Reflection**: Nodes bounce off canvas edges with configurable restitution coefficient.
- **Speed Clamp + Micro-Jitter Removal**: Max speed enforced; velocities below 0.01 px/frame zeroed.
- **SIMD Path**: On wasm32+simd128, loads 4 entities' force, mass, and velocity into `f32x4` lanes and processes them in parallel. Scalar tail handles remainder.
- **Alive-List Iteration**: Instead of scanning `0..max_entities` and skipping dead slots, iterates a compact `Vec<u32>` of active entity IDs. Eliminates ~70% branch-misses at typical 3K/10K capacity ratios.

### 2. Spatial Index Rebuild
The engine picks between two spatial indices based on active node count:
- **Quadtree** (`quadtree.rs`): Used for <2,000 nodes. Pre-allocated arena of up to 8,192 nodes. Each leaf stores up to 8 points inline (no heap allocation), with an overflow linked list for dense cells. `clear()` resets `len` to 1 without deallocation.
- **Spatial Grid** (`spatial_grid.rs`): Used for ≥2,000 nodes. 64px fixed-size cells. Up to 16 entity IDs per cell inline, with overflow pool. O(1) insertion; queries check the 3x3 neighborhood. Hysteresis (switch back at <1,000) prevents oscillation.

### 3. Collision Detection & Relations (`relations.rs`)
- For each alive entity, queries the spatial index for neighbors within `radius * search_radius_mul`.
- **Merge**: If two entities' bitmasks differ AND neither is a subset of the other (i.e., they carry genuinely different data), they merge: `new_mask = a.mask | b.mask`. Position/velocity use center-of-mass and conservation of momentum. Radius preserves total area. Event emitted to JS.
- **Repulsion**: If entities share compatible bitmasks, they receive elastic repulsion proportional to overlap distance.
- **Fracture**: Double-click triggers `fracture_node()`. Each set bit in the entity's bitmask spawns a child node with that single-bit mask, ejected in a circular pattern at 80 px/s. Original entity despawned. Events emitted.

### 4. Rendering (`renderer.rs`)
- **Dirty Rectangles**: Tracks the bounding box of all changed regions (previous positions erased + new positions drawn). Only this region is cleared and redrawn.
- **Viewport Culling**: Nodes entirely off-screen skip rendering.
- **LOD Culling**: Nodes with on-screen radius <2px are drawn as single pixels. Stationary sub-1px nodes are skipped entirely.
- **Y-Sorted Batch Draw**: Entities are sorted by Y coordinate before drawing. This makes pixel buffer access cache-friendly (scanline-ordered writes).
- **SIMD Clear**: Background clear writes 16 bytes (4 RGBA pixels) per `v128_store` instruction.
- **SIMD Opaque Circles**: Each horizontal span writes 4 pixels per store.
- **Alpha Blending**: Integer fixed-point: `(src * alpha + dst * (255-alpha) + 128) / 255`.
- **Double-Buffer**: `render()` writes to back buffer. `swap_buffers()` atomically swaps front↔back. JS always reads the stable front buffer while the next frame is being drawn.

### 5. Event Queue → JS
Events are packed as `[kind, consumed_count, produced_count, consumed_ids..., produced_ids...]` in a pre-allocated `Vec<u32>`. JS drains them after each tick and applies them to the PayloadRegistry.

## Rust Source Files (src/)

### `lib.rs` — Engine Orchestrator
The single entry point exposed to JavaScript via `#[wasm_bindgen]`. Contains the `LiquidEngine` struct holding all subsystems and the complete public API. Key methods:

| Method | Purpose |
|--------|---------|
| `new(w, h, max_nodes)` | Constructor — allocates all memory upfront |
| `spawn_node(x,y,vx,vy,r,g,b,a,bitmask,radius)` | Create entity, return ID |
| `remove_node(id)` | Despawn entity |
| `tick(dt)` | Advance simulation one frame |
| `pick_node_at(x,y)` | Hit-test — return entity ID under cursor |
| `fracture_node(id)` | Decompose entity into bit components |
| `pin_node/unpin_node/update_pin_target` | Spring-damped cursor drag |
| `pixel_buffer_ptr/len` | Access RGBA pixel data from JS |
| `dirty_rect_ptr/has_dirty_region/clear_dirty` | Dirty rectangle API |
| `event_count/event_ptr/drain_events` | Event queue for payload system |
| `swap_buffers` | Double-buffer swap |
| `set_viewport` | Pan/zoom viewport |
| `set_viscosity/set_gravity` | Physics tuning |

### `ecs.rs` — Entity Component System
**Data Layout**: Structure of Arrays (SoA). All entity properties (position, velocity, force, color, bitmask, radius, mass) are stored in separate contiguous `Vec`s. This is cache-friendly — iterating all positions hits sequential memory.

**Lifecycle**: Free-list allocator enables O(1) spawn/despawn. `spawn()` pops from a stack of free indices. `despawn()` pushes the index back and swap-removes from `alive_list`.

**Components**:
- `pos_x, pos_y: Vec<f32>` — position
- `vel_x, vel_y: Vec<f32>` — velocity
- `force_x, force_y: Vec<f32>` — accumulated force (cleared each frame)
- `color_r, color_g, color_b, color_a: Vec<u8>` — RGBA
- `bitmask: Vec<u32>` — relational logic identity (each bit = a fundamental element)
- `radius: Vec<f32>` — visual + collision radius
- `mass: Vec<f32>` — derived from `bitmask.count_ones()` (more bits = heavier)

**alive_list**: A compact `Vec<u32>` of active entity IDs. `alive_iter()` returns `&[u32]`. This enables O(active) iteration in all systems, critical for performance when capacity >> active count.

### `quadtree.rs` — Recursive Spatial Index
**Design**: Recursively subdivides 2D space into quadrants. Each node stores points inline (`[QTPoint; 8]`) with overflow linked list. Maximum depth caps subdivision. Rebuilt from scratch each frame.

**Zero-Allocation**: Arena pre-allocated at 8,192 nodes. `clear()` uses `unsafe { set_len(1) }` to reset without deallocation. Query methods take `&mut Vec<u32>` output — the caller provides and reuses a scratch buffer.

**Operations**:
- `insert(id, x, y)` — traverse tree, store at leaf
- `query(x, y, radius, out)` — bounding-box search → AABB intersection → point-in-range
- `query_neighbors(x, y, radius, out)` — alias for query
- `clear()` — reset to root-only, recycle overflow entries

**Performance**: Reduces collision detection from O(N²) to approximately O(N log N). Degrades with high-density clusters (too many subdivisions).

### `spatial_grid.rs` — Uniform Grid Hash
**Design**: Fixed-size 64px cells spanning the world. O(1) insertion via `col = x/64, row = y/64`. Each cell stores up to 16 entity IDs inline with overflow pool. Query checks 3x3 neighborhood.

**Zero-Allocation**: All cells pre-allocated. `clear()` zeros counts without deallocation. Overflow uses a free-list.

**Auto-Switch**: Engine switches from quadtree to grid at >2,000 nodes (hysteresis prevents oscillation). Grid excels at high density because insertion cost is constant regardless of node distribution.

### `renderer.rs` — Software Pixel Renderer
**Double-Buffer**: Two `Vec<u8>` pixel buffers (front/back). `render()` writes to back. `swap_buffers()` atomically exchanges pointers. JS reads the stable front buffer.

**Dirty Rectangles**: Tracks min/max bounding box of all changes. Previous-frame positions are cleared (drawn in background color), current positions are drawn. Only the dirty region is processed.

**LOD System**:
- On-screen radius ≥2px: Full midpoint-circle algorithm, SIMD-accelerated spans
- On-screen radius 0.8–2px: Single-pixel write (fast path)
- On-screen radius <0.8px AND stationary: Skipped entirely

**SIMD Paths** (`#[cfg(target_feature = "simd128")]`):
- `clear_region`: `v128_store` writes 4 BGRA pixels (16 bytes) per iteration
- `draw_circle_span_opaque`: 4 pixels per `v128_store`
- `draw_circle_span_alpha`: Integer fixed-point blending per pixel group

**Scalar Fallbacks**: All SIMD paths have equivalent non-SIMD implementations.

**Viewport**: `set_viewport(x, y, scale)` enables pan/zoom. Renderer transforms world coordinates to screen coordinates and culls off-screen entities.

### `physics.rs` — Kinematics System
**Integration**: Symplectic Euler for stability with oscillatory motion (pinned springs).

**Forces per entity**:
1. External forces → acceleration (`a = F/m`)
2. Spring force (pinned nodes): `F = -k*(pos - target) - d*vel`
3. Viscosity: `vel *= 1.0 - viscosity`
4. Speed clamp
5. Position integration: `pos += vel * dt`
6. Boundary reflection with energy loss

**SIMD**: On wasm32+simd128, loads force/mass/velocity for 4 entities into `f32x4` lanes. Force → acceleration → velocity integration done in parallel. Spring forces, speed clamp, and boundary bounce are scalar (only a few nodes are pinned at any time).

**Configurable**: Viscosity (drag), bounce (restitution), gravity, max_speed, spring_stiffness, spring_damping.

### `relations.rs` — Bitwise Merge/Fracture Logic
**Bitmask Model**: Each entity carries a `u32` bitmask. Bits 0–7 map to color spectrum (Red, Green, Blue, Yellow, Magenta, Cyan, Orange, Purple). Bits 8+ are extended properties (all gray).

**Merge**: `new_mask = a.mask | b.mask` (bitwise OR). Merged entity inherits center-of-mass position, momentum-conserving velocity, area-preserving radius, and blended color from the combined bitmask.

**Fracture**: Each set bit spawns a child node with that single bit. Children ejected in a circular pattern. Original entity removed. Single-bit entities cannot fracture (fundamental elements).

**Collision Detection**: For each alive entity, queries spatial index for neighbors. Distance check against combined radii × threshold. Merges queued and executed after detection pass to avoid iterator invalidation.

**Zero-Allocation**: Merge queue and query scratch buffer pre-allocated. `std::mem::take` pattern avoids cloning.

## JavaScript Files (web/)

### `main.js` — Host Layer (~530 lines)
The orchestrator on the JS side. Responsibilities:
1. **Canvas setup**: Fullscreen `<canvas>`, 2D context with `willReadFrequently: true`
2. **Wasm loading**: Dynamic `import('../pkg/liquid_state_engine.js')` 
3. **Node spawning**: Initial 200 random nodes, burst-spawn 50 on click, spawn with payload
4. **Game loop**: `requestAnimationFrame` → update pin target → `engine.tick(dt)` → process events → `drawPixelBuffer()` → `putImageData()`
5. **Pixel transfer**: Reads Wasm linear memory via `pixel_buffer_ptr()` + `dirty_rect_ptr()`, constructs `ImageData` for the dirty sub-region, calls `ctx.putImageData()`
6. **Input handling**: Mouse/touch down/move/up, double-click for fracture, draw-mode path tracing
7. **Drag-and-drop**: File/text drop on canvas → auto-detect payload type → spawn node
8. **Event processing**: Reads packed u32 event queue from Wasm, decodes and applies to PayloadRegistry via rule engine
9. **Demo mode fallback**: Pure JS simulation when Wasm fails to load

**Draw Mode Pipeline**:
- `mousedown` + draw mode: start tracking path points
- `mousemove`: append to path
- `mouseup`: compute centroid + bounding circle → spawn node → dispatch `lse-drawnode` event → HUD shows payload dialog

### `payload.js` — Payload Registry
Maintains a `Map<entityId, payload>` that decouples the physical shell (Rust entity) from its data (JS object). Each payload has `{ type, value, label }`.

**Event Decoder**: Parses packed u32 format into structured events: `{ kind, consumed: [...], produced: [...] }`.

**Event Application**:
- `spawn(2)`: Payload already registered via `register()`
- `despawn(3)`: Remove consumed payloads
- `merge(0)`: Remove consumed payloads, apply `rules.merge()` to produce combined payload
- `fracture(1)`: Remove consumed, apply `rules.fracture()` to produce child payloads

### `rules.js` — Generic Rule Engine
Pure functions (no side effects, easily testable) that define merge/fracture semantics per data type:

| Type | Merge | Fracture |
|------|-------|----------|
| **text** | Concatenate with `\n` separator | Split by whitespace/punctuation tokens |
| **number** | Configurable reducer: sum (default), average, product | Divide value equally across child nodes |
| **json** | Shallow merge objects; key conflicts become sub-composite | Each key/value pair becomes a child |
| **array** | Concatenate arrays | Each element becomes a child |
| **composite/mixed** | Wrap all in `{ items: [...] }` | Generic split |

**Auto-Detection**: `detectPayload(raw)` tries `JSON.parse` → `typeof number` → `typeof string` → `typeof object`.

**Configuration**: Numeric reducer can be changed at runtime via `setNumericReducer('sum'|'avg'|'product')`.

### `worker.js` — Web Worker (~215 lines)
Owns the Wasm engine instance in a background thread. Two synchronization modes:

1. **SharedArrayBuffer Mode**: Main thread allocates SABs for pixel data and control. Worker writes pixel buffer into SAB after each tick, signals via `Atomics.store(ready, 1)` + `Atomics.notify()`. Main thread polls with `Atomics.wait()`. Worker runs its own tick loop via `setTimeout`.

2. **Transfer Mode**: Main thread sends `{ type: 'tick' }` message. Worker performs tick, copies pixel data into a buffer, transfers ownership back via `postMessage({ pixels }, [pixels.buffer])`.

**Message Protocol**: Worker accepts `init`, `spawn`, `remove`, `apply_force`, `fracture`, `pin_node`, `unpin_node`, `update_pin`, `pick`, `set_viscosity`, `set_gravity`, `tick`, `stop`. Worker sends `ready`, `frame`, `events`, `pick_result`, `error`.

### `worker-engine.js` — Worker Adapter (~224 lines)
Mirrors the direct `LiquidEngine` API but proxies all calls through `postMessage` to the worker. Handles both SAB and transfer modes. Provides `getPixelData()`, `getDirtyRect()`, `isFrameReady()`, `clearFrameReady()` for the main-thread render loop.

**Graceful Degradation**: Tries SAB → transfer-based worker → returns `'none'` (caller falls back to direct engine).

### `hud/app.js` — Preact Glassmorphism HUD (~270 lines)
Built with [Preact](https://preactjs.com/) + [htm](https://github.com/developit/htm) loaded from CDN (zero build step). Renders inside `#hud-app` div positioned above the canvas with `pointer-events: none` on the container and `pointer-events: auto` on interactive panels.

**Components**:
- **StatsPanel** (top-left): FPS, node count, dirty rect size, engine status
- **ModeSwitcher** (top-right): Select (`⊙`), Draw (`✎`), Fracture (`⟐`) mode buttons
- **InspectorPanel** (floating center-left): Shows payload type, label, and truncated value when a node is selected
- **Toolbar** (bottom center): Numeric merge reducer buttons (Σ Sum / μ Avg / Π Prod), gravity toggle, viscosity slider
- **PayloadDialog** (modal overlay): Label input + data textarea when a draw-mode node is created

**Data Flow**: HUD reads DOM elements populated by `main.js` for FPS/node/dirty stats. Listens for `lse-pick` and `lse-drawnode` custom events dispatched by `main.js`. Calls `window.lse.*` API to configure engine settings.

### `hud/style.css` — Glassmorphism Styles (~257 lines)
All HUD panels use:
- `background: rgba(10, 15, 28, 0.72)` — translucent dark
- `backdrop-filter: blur(16px)` — frosted glass effect
- `border: 1px solid rgba(100, 180, 255, 0.18)` — subtle cyan edge
- `box-shadow: 0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)` — depth + inner highlight
- Monospace font at 10–12px

Responsive: toolbar hidden below 600px viewport width.

## Configuration & Build Files

### `Cargo.toml`
- Package: `liquid-state-engine` v0.2.0
- Crate types: `cdylib` (Wasm) + `rlib` (native for testing)
- Dependencies: `wasm-bindgen = "0.2"`, `web-sys = "0.3"`
- Release profile: `opt-level = 3`, `lto = true`, `codegen-units = 1`, `panic = "abort"`

### `.cargo/config.toml`
- Default target: `wasm32-unknown-unknown`
- SIMD128 enabled via `-C target-feature=+simd128`

### `package.json`
- Scripts: `build:wasm`, `build:wasm:release`, `check`, `test:rust`, `serve`, `clean`
- Uses `wasm-pack` for building, `http-server` or `scripts/serve.js` for serving

### `scripts/serve.js`
Minimal Node.js HTTP server that serves `web/` and `pkg/` directories with required headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
These headers are mandatory for `SharedArrayBuffer` to be available in the browser. Without them, the engine falls back to transfer-based `postMessage` or single-threaded operation.

## Interactions & User Experience

| Gesture | Mode | Effect |
|---------|------|--------|
| Click empty space | Select | Burst-spawn 50 nodes in a ring pattern |
| Click + drag on node | Select | Pin node to cursor with spring-damped physics |
| Double-click node | Select | Fracture node into bit components |
| Mouse drag on canvas | Draw | Trace path → on release, spawn node at centroid with payload dialog |
| Drop file/text on canvas | Any | Auto-detect type, spawn node with data as payload |
| HUD mode buttons | Any | Switch Select / Draw modes |
| HUD toolbar | Any | Change numeric reducer, toggle gravity, adjust viscosity |

## Performance Characteristics

Measured on x86_64 (native, debug build) at 1920×1080, 300 frames:

| Node Count | ms/frame | FPS equivalent | Key techniques |
|-----------|----------|----------------|----------------|
| 3,000 | 2.15 ms | ~465 FPS | Alive-list, zero-alloc quadtree, SIMD fill |
| 10,000 | 8.95 ms | ~112 FPS | Above + spatial grid, LOD culling, Y-sorted batch draw |

On wasm32 with SIMD128 enabled and release optimizations, performance is expected 3–4× faster due to LTO, inlined intrinsics, and optimized code generation.

## Project File Map (21 files)

```
C:\Liquid-State-Engine\
├── Cargo.toml                      # Rust project config
├── Cargo.lock                      # Dependency lock file
├── package.json                    # npm scripts
├── README.md                       # Project documentation
├── PROJECT_SUMMARY.md              # This file
├── .cargo/
│   └── config.toml                 # wasm32 target + SIMD128 flags
│
├── src/                            # Rust source (7 files, ~2,300 lines)
│   ├── lib.rs                      # Engine orchestrator, wasm-bindgen API, benchmarks
│   ├── ecs.rs                      # SoA World, free-list, alive_list
│   ├── quadtree.rs                 # Arena-based recursive spatial partition
│   ├── spatial_grid.rs             # Uniform cell grid for dense scenes
│   ├── renderer.rs                 # Double-buffer CPU renderer with SIMD
│   ├── physics.rs                  # Symplectic Euler + f32x4 SIMD + spring drag
│   └── relations.rs                # Bitwise merge/fracture + collision detection
│
├── web/                            # JavaScript host (8 files, ~2,000 lines)
│   ├── index.html                  # Canvas host + HUD mount point
│   ├── main.js                     # Game loop, input, canvas blit, payload integration
│   ├── payload.js                  # Map<id, payload> registry + event decoder
│   ├── rules.js                    # Pure-function merge/fracture per data type
│   ├── worker.js                   # Web Worker Wasm runner (SAB + transfer)
│   ├── worker-engine.js            # Worker adapter (same API as direct engine)
│   └── hud/
│       ├── app.js                  # Preact+htm glassmorphism HUD components
│       └── style.css               # Glass panel styles, backdrop-blur
│
├── examples/
│   └── data-workflow.html          # JSON/number/text dataset demo page
│
└── scripts/
    └── serve.js                    # Node.js dev server with COOP/COEP headers
```

## Development Phases

| Phase | Feature Set | Status |
|-------|------------|--------|
| 1 | Foundation: ECS, Cargo setup, wasm-bindgen | Done |
| 2 | Spatial + Rendering: Quadtree, Software Renderer, Dirty Rects | Done |
| 3 | Interaction: Input handling, Physics, Fracture gestures | Done |
| 4 | Relational Logic: Bitmask merge/fracture, Event queue | Done |
| 5 | Holographic Core: Payload system, Rule engine, HUD, Worker, Spring drag, Tests | Done |
| 6 | Performance: SIMD rendering/physics, Zero-alloc, Alive-list, Spatial grid, Double-buffer, LOD | Done |

## License

MIT
