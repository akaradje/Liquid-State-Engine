//! Liquid-State Engine: Interactive Visual Computing Platform
//!
//! A CPU-only, DOM-free rendering engine that bypasses the browser's
//! normal rendering pipeline. Uses a single <canvas> as a holographic
//! display surface with direct pixel manipulation via WebAssembly.

pub mod ecs;
pub mod quadtree;
pub mod renderer;
pub mod physics;
pub mod relations;
pub mod spatial_grid;

use wasm_bindgen::prelude::*;
use ecs::World;
use quadtree::Quadtree;
use spatial_grid::SpatialGrid;
use renderer::SoftwareRenderer;
use physics::PhysicsSystem;
use relations::RelationSystem;

/// Event kind constants (packed u32 format).
pub const EVENT_MERGE: u32 = 0;
pub const EVENT_FRACTURE: u32 = 1;
pub const EVENT_SPAWN: u32 = 2;
pub const EVENT_DESPAWN: u32 = 3;

/// Node count threshold to switch from quadtree to spatial grid.
const GRID_SWITCH_THRESHOLD: u32 = 2000;

/// Pre-allocated event queue capacity.
const EVENT_CAPACITY: usize = 4096;

/// The main engine struct that orchestrates all subsystems.
/// This is the single entry point exposed to JavaScript.
#[wasm_bindgen]
pub struct LiquidEngine {
    world: World,
    quadtree: Quadtree,
    grid: SpatialGrid,
    renderer: SoftwareRenderer,
    physics: PhysicsSystem,
    relations: RelationSystem,
    canvas_width: u32,
    canvas_height: u32,
    frame_count: u64,
    events: Vec<u32>,
    /// Scratch buffer for spatial queries (reused each frame).
    query_scratch: Vec<u32>,
    /// Currently active spatial index: true = quadtree, false = grid.
    use_quadtree: bool,
}

#[wasm_bindgen]
impl LiquidEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, max_nodes: u32) -> LiquidEngine {
        let mut events = Vec::with_capacity(EVENT_CAPACITY);
        // Pre-fill to avoid reallocation during runtime
        events.reserve(EVENT_CAPACITY);

        LiquidEngine {
            world: World::new(max_nodes as usize),
            quadtree: Quadtree::new(0.0, 0.0, width as f32, height as f32, 8, 4),
            grid: SpatialGrid::new(width as f32, height as f32),
            renderer: SoftwareRenderer::new(width, height),
            physics: PhysicsSystem::new(),
            relations: RelationSystem::new(),
            canvas_width: width,
            canvas_height: height,
            frame_count: 0,
            events,
            query_scratch: Vec::with_capacity(512),
            use_quadtree: true,
        }
    }

    pub fn spawn_node(
        &mut self,
        x: f32, y: f32,
        vx: f32, vy: f32,
        r: u8, g: u8, b: u8, a: u8,
        bitmask: u32,
        radius: f32,
    ) -> u32 {
        let id = self.world.spawn(x, y, vx, vy, r, g, b, a, bitmask, radius);
        if id != usize::MAX {
            self.events.push(EVENT_SPAWN);
            self.events.push(0);
            self.events.push(1);
            self.events.push(id as u32);
        }
        id as u32
    }

    pub fn remove_node(&mut self, id: u32) {
        let idx = id as usize;
        if idx < self.world.max_entities && self.world.alive[idx] {
            self.events.push(EVENT_DESPAWN);
            self.events.push(1);
            self.events.push(0);
            self.events.push(id);
        }
        self.world.despawn(idx);
    }

    pub fn node_count(&self) -> u32 {
        self.world.active_count() as u32
    }

    pub fn apply_force(&mut self, id: u32, fx: f32, fy: f32) {
        self.world.apply_force(id as usize, fx, fy);
    }

    pub fn tick(&mut self, dt: f32) {
        self.frame_count += 1;

        // 0. Clear event queue (keep capacity)
        self.events.clear();

        // 1. Physics update (uses alive_list internally)
        self.physics.update(&mut self.world, dt, self.canvas_width as f32, self.canvas_height as f32);

        // 2. Auto-select spatial index based on node count
        let count = self.world.active_count();
        if count > GRID_SWITCH_THRESHOLD as usize {
            self.use_quadtree = false;
        } else if count < (GRID_SWITCH_THRESHOLD as usize / 2) {
            self.use_quadtree = true;
        }

        // 3. Rebuild spatial index
        let alive = self.world.alive_iter();
        if self.use_quadtree {
            self.quadtree.clear();
            for &id_u32 in alive {
                let i = id_u32 as usize;
                self.quadtree.insert(id_u32, self.world.pos_x[i], self.world.pos_y[i]);
            }
            // 4. Collision detection via quadtree
            self.relations.process(&mut self.world, &self.quadtree, &mut self.events);
        } else {
            self.grid.clear();
            for &id_u32 in alive {
                let i = id_u32 as usize;
                self.grid.insert(id_u32, self.world.pos_x[i], self.world.pos_y[i]);
            }
            // When using grid, relations still queries via quadtree for now
            // (The relations system uses Quadtree. In a future refactor,
            //  we'd add a trait-based dispatch. For now, rebuild quadtree
            //  for relations but use grid for pick queries.)
            self.quadtree.clear();
            for &id_u32 in alive {
                let i = id_u32 as usize;
                self.quadtree.insert(id_u32, self.world.pos_x[i], self.world.pos_y[i]);
            }
            self.relations.process(&mut self.world, &self.quadtree, &mut self.events);
        }

        // 5. Render to pixel buffer (uses alive_list internally)
        self.renderer.render(&self.world);
    }

    pub fn pixel_buffer_ptr(&self) -> *const u8 {
        self.renderer.buffer_ptr()
    }

    pub fn pixel_buffer_len(&self) -> u32 {
        self.renderer.buffer_len() as u32
    }

    pub fn dirty_rect_ptr(&self) -> *const u32 {
        self.renderer.dirty_rect_ptr()
    }

    pub fn has_dirty_region(&self) -> bool {
        self.renderer.has_dirty_region()
    }

    pub fn pick_node_at(&mut self, x: f32, y: f32) -> u32 {
        self.query_scratch.clear();
        if self.use_quadtree {
            self.quadtree.query(x, y, 1.0, &mut self.query_scratch);
        } else {
            self.grid.query(x, y, 1.0, &mut self.query_scratch);
        }

        for &id in &self.query_scratch {
            let idx = id as usize;
            if idx < self.world.max_entities && self.world.alive[idx] {
                let dx = self.world.pos_x[idx] - x;
                let dy = self.world.pos_y[idx] - y;
                let r = self.world.radius[idx];
                if dx * dx + dy * dy <= r * r {
                    return id;
                }
            }
        }
        u32::MAX
    }

    pub fn fracture_node(&mut self, id: u32) {
        self.relations.fracture(&mut self.world, id as usize, &mut self.events);
    }

    pub fn width(&self) -> u32 { self.canvas_width }
    pub fn height(&self) -> u32 { self.canvas_height }
    pub fn frame_count(&self) -> u64 { self.frame_count }

    pub fn clear_dirty(&mut self) {
        self.renderer.clear_dirty();
    }

    // ---- Event Queue API ----

    pub fn event_count(&self) -> u32 {
        self.events.len() as u32
    }

    pub fn event_ptr(&self) -> *const u32 {
        self.events.as_ptr()
    }

    pub fn drain_events(&mut self) {
        self.events.clear();
    }

    // ---- Pinned Drag API ----

    pub fn pin_node(&mut self, id: u32, cursor_x: f32, cursor_y: f32) {
        self.physics.pin_node(&mut self.world, id as usize, cursor_x, cursor_y);
    }

    pub fn unpin_node(&mut self, id: u32) {
        self.physics.unpin_node(&mut self.world, id as usize);
    }

    pub fn update_pin_target(&mut self, id: u32, cursor_x: f32, cursor_y: f32) {
        self.physics.update_pin_target(&mut self.world, id as usize, cursor_x, cursor_y);
    }

    // ---- Physics Settings ----

    pub fn set_viscosity(&mut self, v: f32) { self.physics.viscosity = v; }
    pub fn set_gravity(&mut self, g: f32) { self.physics.gravity_y = g; }

    // ---- Double-Buffer & Viewport ----

    pub fn swap_buffers(&mut self) {
        self.renderer.swap_buffers();
    }

    pub fn set_viewport(&mut self, x: f32, y: f32, scale: f32) {
        self.renderer.set_viewport(x, y, scale);
    }
}

// ---- Performance Benchmark (native-only, not wasm) ----

#[cfg(test)]
mod bench_tests {
    use super::*;

    #[test]
    fn bench_10k_nodes_300_frames() {
        let mut engine = LiquidEngine::new(1920, 1080, 10000);

        // Spawn 10000 nodes with SAME bitmask (no merging during benchmark)
        let mask = 0b001u32;
        for i in 0..10000u32 {
            let x = ((i.wrapping_mul(7919)) % 1920) as f32;
            let y = ((i.wrapping_mul(6271)) % 1080) as f32;
            let vx = ((i.wrapping_mul(31)) as f32 % 60.0) - 30.0;
            let vy = ((i.wrapping_mul(47)) as f32 % 60.0) - 30.0;
            let id = engine.spawn_node(x, y, vx, vy, 255, 60, 60, 255, mask, 4.0 + (i as f32 % 4.0));
            if id == 0xFFFFFFFF {
                break;
            }
        }

        // Warm up: 2 frames to stabilize allocations
        engine.tick(0.016);
        engine.tick(0.016);

        // Benchmark: 300 frames
        let start = std::time::Instant::now();
        for _ in 0..300 {
            engine.tick(0.016);
        }
        let elapsed = start.elapsed();
        let ms_per_frame = elapsed.as_millis() as f64 / 300.0;

        println!("=== PERFORMANCE BENCHMARK ===");
        println!("  Nodes: {}", engine.node_count());
        println!("  Frames: 300");
        println!("  Total time: {:.2} ms", elapsed.as_millis());
        println!("  Per frame: {:.2} ms", ms_per_frame);
        println!("  Equivalent FPS: {:.0}", 1000.0 / ms_per_frame);
        println!("=============================");

        // Must sustain ≥ 60 FPS (≤ 16.67 ms per frame)
        assert!(ms_per_frame < 16.0, "Performance target: < 16ms/frame (60 FPS), got {:.2}ms", ms_per_frame);
    }

    #[test]
    fn bench_3k_nodes_baseline() {
        let mut engine = LiquidEngine::new(1920, 1080, 5000);

        let mask = 0b001u32;
        for i in 0..3000u32 {
            let x = ((i.wrapping_mul(7919)) % 1920) as f32;
            let y = ((i.wrapping_mul(6271)) % 1080) as f32;
            let vx = ((i.wrapping_mul(31)) as f32 % 40.0) - 20.0;
            let vy = ((i.wrapping_mul(47)) as f32 % 40.0) - 20.0;
            engine.spawn_node(x, y, vx, vy, 200, 200, 200, 255, mask, 5.0);
        }

        engine.tick(0.016);
        engine.tick(0.016);

        let start = std::time::Instant::now();
        for _ in 0..300 {
            engine.tick(0.016);
        }
        let elapsed = start.elapsed();
        let ms_per_frame = elapsed.as_millis() as f64 / 300.0;

        println!("=== 3K Baseline ===");
        println!("  Per frame: {:.2} ms", ms_per_frame);
        println!("===================");

        // Should be very fast at 3K
        assert!(ms_per_frame < 10.0);
    }
}
