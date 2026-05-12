//! Entity Component System (ECS) with Structure of Arrays (SoA) layout.
//!
//! All entity data is stored in flat, contiguous arrays for maximum
//! CPU cache locality. This allows the CPU to prefetch sequential
//! memory access patterns, dramatically reducing cache misses.
//!
//! Supports up to `max_entities` nodes with O(1) spawn/despawn via
//! a free-list allocator.

/// The ECS World: holds all component arrays and entity lifecycle state.
pub struct World {
    /// Maximum number of entities this world can hold.
    pub max_entities: usize,
    
    // --- Lifecycle ---
    /// Whether each entity slot is alive.
    pub alive: Vec<bool>,
    /// Free list of available entity slots (stack-based allocator).
    free_list: Vec<usize>,
    /// Number of currently active entities.
    active: usize,

    // --- Position Components (SoA) ---
    pub pos_x: Vec<f32>,
    pub pos_y: Vec<f32>,

    // --- Velocity Components (SoA) ---
    pub vel_x: Vec<f32>,
    pub vel_y: Vec<f32>,

    // --- Force Accumulator (SoA) ---
    pub force_x: Vec<f32>,
    pub force_y: Vec<f32>,

    // --- Color Components (SoA) - RGBA ---
    pub color_r: Vec<u8>,
    pub color_g: Vec<u8>,
    pub color_b: Vec<u8>,
    pub color_a: Vec<u8>,

    // --- Bitmask for relational logic ---
    /// Each bit represents a fundamental property/element.
    /// Merge = OR, Fracture = decompose into individual bits.
    pub bitmask: Vec<u32>,

    // --- Geometry ---
    /// Radius of each node (for rendering and collision).
    pub radius: Vec<f32>,

    // --- Mass (derived from bitmask popcount for physics) ---
    pub mass: Vec<f32>,
}

impl World {
    /// Create a new World pre-allocated for `max_entities` nodes.
    /// All arrays are allocated upfront to avoid runtime allocation.
    pub fn new(max_entities: usize) -> Self {
        let mut free_list = Vec::with_capacity(max_entities);
        // Fill free list in reverse so index 0 is popped first
        for i in (0..max_entities).rev() {
            free_list.push(i);
        }

        World {
            max_entities,
            alive: vec![false; max_entities],
            free_list,
            active: 0,

            pos_x: vec![0.0; max_entities],
            pos_y: vec![0.0; max_entities],

            vel_x: vec![0.0; max_entities],
            vel_y: vec![0.0; max_entities],

            force_x: vec![0.0; max_entities],
            force_y: vec![0.0; max_entities],

            color_r: vec![0; max_entities],
            color_g: vec![0; max_entities],
            color_b: vec![0; max_entities],
            color_a: vec![255; max_entities],

            bitmask: vec![0; max_entities],
            radius: vec![8.0; max_entities],
            mass: vec![1.0; max_entities],
        }
    }

    /// Spawn a new entity. Returns the entity index, or usize::MAX if full.
    pub fn spawn(
        &mut self,
        x: f32, y: f32,
        vx: f32, vy: f32,
        r: u8, g: u8, b: u8, a: u8,
        bitmask: u32,
        radius: f32,
    ) -> usize {
        if let Some(id) = self.free_list.pop() {
            self.alive[id] = true;
            self.pos_x[id] = x;
            self.pos_y[id] = y;
            self.vel_x[id] = vx;
            self.vel_y[id] = vy;
            self.force_x[id] = 0.0;
            self.force_y[id] = 0.0;
            self.color_r[id] = r;
            self.color_g[id] = g;
            self.color_b[id] = b;
            self.color_a[id] = a;
            self.bitmask[id] = bitmask;
            self.radius[id] = radius;
            self.mass[id] = (bitmask.count_ones() as f32).max(1.0);
            self.active += 1;
            id
        } else {
            usize::MAX
        }
    }

    /// Despawn an entity, returning its slot to the free list.
    pub fn despawn(&mut self, id: usize) {
        if id < self.max_entities && self.alive[id] {
            self.alive[id] = false;
            self.vel_x[id] = 0.0;
            self.vel_y[id] = 0.0;
            self.force_x[id] = 0.0;
            self.force_y[id] = 0.0;
            self.free_list.push(id);
            self.active -= 1;
        }
    }

    /// Apply an external force to an entity (accumulates).
    pub fn apply_force(&mut self, id: usize, fx: f32, fy: f32) {
        if id < self.max_entities && self.alive[id] {
            self.force_x[id] += fx;
            self.force_y[id] += fy;
        }
    }

    /// Get the number of currently active entities.
    pub fn active_count(&self) -> usize {
        self.active
    }

    /// Get the total capacity.
    pub fn capacity(&self) -> usize {
        self.max_entities
    }
}
