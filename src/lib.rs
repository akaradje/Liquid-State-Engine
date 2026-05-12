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

use wasm_bindgen::prelude::*;
use ecs::World;
use quadtree::Quadtree;
use renderer::SoftwareRenderer;
use physics::PhysicsSystem;
use relations::RelationSystem;

/// Event kind constants (packed u32 format).
pub const EVENT_MERGE: u32 = 0;
pub const EVENT_FRACTURE: u32 = 1;
pub const EVENT_SPAWN: u32 = 2;
pub const EVENT_DESPAWN: u32 = 3;

/// The main engine struct that orchestrates all subsystems.
/// This is the single entry point exposed to JavaScript.
#[wasm_bindgen]
pub struct LiquidEngine {
    world: World,
    quadtree: Quadtree,
    renderer: SoftwareRenderer,
    physics: PhysicsSystem,
    relations: RelationSystem,
    canvas_width: u32,
    canvas_height: u32,
    frame_count: u64,
    /// Event queue: packed u32 format:
    /// [kind, consumed_count, produced_count, consumed_ids..., produced_ids...]
    events: Vec<u32>,
}

#[wasm_bindgen]
impl LiquidEngine {
    /// Create a new Liquid-State Engine instance.
    /// 
    /// # Arguments
    /// * `width` - Canvas width in pixels
    /// * `height` - Canvas height in pixels
    /// * `max_nodes` - Maximum number of entities supported (pre-allocated)
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, max_nodes: u32) -> LiquidEngine {
        LiquidEngine {
            world: World::new(max_nodes as usize),
            quadtree: Quadtree::new(0.0, 0.0, width as f32, height as f32, 8, 4),
            renderer: SoftwareRenderer::new(width, height),
            physics: PhysicsSystem::new(),
            relations: RelationSystem::new(),
            canvas_width: width,
            canvas_height: height,
            frame_count: 0,
            events: Vec::with_capacity(1024),
        }
    }

    /// Spawn a new node entity with position, velocity, color, and bitmask.
    /// Returns the entity ID, or u32::MAX if capacity is full.
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
            // Record spawn event: [kind=2, consumed=0, produced=1, id]
            self.events.push(EVENT_SPAWN);
            self.events.push(0);
            self.events.push(1);
            self.events.push(id as u32);
        }
        id as u32
    }

    /// Remove a node by entity ID.
    pub fn remove_node(&mut self, id: u32) {
        let idx = id as usize;
        if idx < self.world.max_entities && self.world.alive[idx] {
            // Record despawn event: [kind=3, consumed=1, produced=0, id]
            self.events.push(EVENT_DESPAWN);
            self.events.push(1);
            self.events.push(0);
            self.events.push(id);
        }
        self.world.despawn(idx);
    }

    /// Get the current number of active nodes.
    pub fn node_count(&self) -> u32 {
        self.world.active_count() as u32
    }

    /// Apply an external force (e.g., from user drag) to a specific node.
    pub fn apply_force(&mut self, id: u32, fx: f32, fy: f32) {
        self.world.apply_force(id as usize, fx, fy);
    }

    /// Main simulation tick - advances physics, resolves collisions,
    /// processes merge/fracture logic, and renders to pixel buffer.
    ///
    /// # Arguments
    /// * `dt` - Delta time in seconds since last frame
    pub fn tick(&mut self, dt: f32) {
        self.frame_count += 1;

        // 0. Clear event queue from previous frame
        self.events.clear();

        // 1. Physics update: apply velocities, viscosity, bounds
        self.physics.update(&mut self.world, dt, self.canvas_width as f32, self.canvas_height as f32);

        // 2. Rebuild Quadtree with current positions
        self.quadtree.clear();
        let count = self.world.active_count();
        for i in 0..count {
            if self.world.alive[i] {
                let x = self.world.pos_x[i];
                let y = self.world.pos_y[i];
                self.quadtree.insert(i as u32, x, y);
            }
        }

        // 3. Collision detection & relational logic (merge/fracture)
        self.relations.process(&mut self.world, &self.quadtree, &mut self.events);

        // 4. Render to pixel buffer (dirty rectangles)
        self.renderer.render(&self.world);
    }

    /// Get a pointer to the pixel buffer for JavaScript to read.
    /// The buffer is RGBA format, width*height*4 bytes.
    pub fn pixel_buffer_ptr(&self) -> *const u8 {
        self.renderer.buffer_ptr()
    }

    /// Get the pixel buffer length in bytes.
    pub fn pixel_buffer_len(&self) -> u32 {
        self.renderer.buffer_len() as u32
    }

    /// Get pointer to the dirty rectangle data.
    /// Format: [x, y, width, height] as u32 values, or [0,0,0,0] if no dirty region.
    pub fn dirty_rect_ptr(&self) -> *const u32 {
        self.renderer.dirty_rect_ptr()
    }

    /// Check if there is a dirty region that needs redrawing.
    pub fn has_dirty_region(&self) -> bool {
        self.renderer.has_dirty_region()
    }

    /// Find the node at a given screen position (for hit testing / picking).
    /// Returns the entity ID or u32::MAX if nothing found.
    pub fn pick_node_at(&self, x: f32, y: f32) -> u32 {
        let candidates = self.quadtree.query(x, y, 1.0);
        for &id in &candidates {
            let idx = id as usize;
            if idx < self.world.active_count() && self.world.alive[idx] {
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

    /// Initiate a fracture operation on a node (split into components).
    pub fn fracture_node(&mut self, id: u32) {
        self.relations.fracture(&mut self.world, id as usize, &mut self.events);
    }

    /// Get canvas width.
    pub fn width(&self) -> u32 {
        self.canvas_width
    }

    /// Get canvas height.
    pub fn height(&self) -> u32 {
        self.canvas_height
    }

    /// Get frame count since engine creation.
    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    /// Reset the dirty region flag after JS has read the pixel data.
    pub fn clear_dirty(&mut self) {
        self.renderer.clear_dirty();
    }

    // ---- Event Queue API ----

    /// Number of u32 entries in the event queue.
    pub fn event_count(&self) -> u32 {
        self.events.len() as u32
    }

    /// Pointer to the event queue data (packed u32 format).
    /// JS consumes the raw buffer and decodes it.
    pub fn event_ptr(&self) -> *const u32 {
        self.events.as_ptr()
    }

    /// Drain all events from the queue. JS should call this after
    /// reading events to avoid re-processing them next frame.
    pub fn drain_events(&mut self) {
        self.events.clear();
    }

    // ---- Pinned Drag API (spring-damped) ----

    /// Pin a node to be pulled toward `cursor_x, cursor_y` by a damped spring.
    pub fn pin_node(&mut self, id: u32, cursor_x: f32, cursor_y: f32) {
        self.physics.pin_node(&mut self.world, id as usize, cursor_x, cursor_y);
    }

    /// Unpin a previously pinned node.
    pub fn unpin_node(&mut self, id: u32) {
        self.physics.unpin_node(&mut self.world, id as usize);
    }

    /// Update cursor position for an already-pinned node.
    pub fn update_pin_target(&mut self, id: u32, cursor_x: f32, cursor_y: f32) {
        self.physics.update_pin_target(&mut self.world, id as usize, cursor_x, cursor_y);
    }

    // ---- Physics Settings ----

    pub fn set_viscosity(&mut self, v: f32) {
        self.physics.viscosity = v;
    }

    pub fn set_gravity(&mut self, g: f32) {
        self.physics.gravity_y = g;
    }
}
