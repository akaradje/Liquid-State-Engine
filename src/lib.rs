//! Liquid-State Engine — DOM Physics Backend
//!
//! A lightweight Wasm physics engine for DOM-based frontends.
//! Handles velocity integration, viscosity, boundary bounce,
//! collision repulsion, and spatial indexing.
//!
//! Rendering and merge/fracture logic are handled by JavaScript.

pub mod ecs;
pub mod quadtree;
pub mod physics;

use wasm_bindgen::prelude::*;
use ecs::World;
use quadtree::Quadtree;
use physics::PhysicsSystem;

#[wasm_bindgen]
pub struct LiquidEngine {
    world: World,
    quadtree: Quadtree,
    physics: PhysicsSystem,
    canvas_width: u32,
    canvas_height: u32,
    frame_count: u64,
    /// Scratch buffer for position export (reused each frame)
    pos_export: Vec<f32>,
    /// Scratch buffer for active ID export
    id_export: Vec<u32>,
}

#[wasm_bindgen]
impl LiquidEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, max_nodes: u32) -> LiquidEngine {
        LiquidEngine {
            world: World::new(max_nodes as usize),
            quadtree: Quadtree::new(0.0, 0.0, width as f32, height as f32, 6, 4),
            physics: PhysicsSystem::new(),
            canvas_width: width,
            canvas_height: height,
            frame_count: 0,
            pos_export: Vec::with_capacity(max_nodes as usize * 2),
            id_export: Vec::with_capacity(max_nodes as usize),
        }
    }

    /// Spawn a node with position and optional velocity.
    /// Returns entity ID, or u32::MAX if full.
    pub fn spawn_at(&mut self, x: f32, y: f32, vx: f32, vy: f32, radius: f32) -> u32 {
        let bitmask = 0b001u32;
        let id = self.world.spawn(x, y, vx, vy, 255, 60, 60, 255, bitmask, radius);
        id as u32
    }

    /// Despawn a node by ID.
    pub fn despawn(&mut self, id: u32) {
        self.world.despawn(id as usize);
    }

    /// Advance physics one frame.
    /// Only runs velocity integration + collision repulsion (no merge/fracture).
    pub fn tick_dom(&mut self, dt: f32) {
        self.frame_count += 1;

        let bw = self.canvas_width as f32;
        let bh = self.canvas_height as f32;

        // 1. Physics: viscosity, velocity, boundary bounce
        self.physics.update(&mut self.world, dt, bw, bh);

        // 2. Rebuild spatial index
        self.rebuild_index();

        // 3. Simple collision repulsion (no merge)
        self.resolve_collisions();
    }

    fn rebuild_index(&mut self) {
        self.quadtree.clear();
        for &id_u32 in self.world.alive_iter() {
            let i = id_u32 as usize;
            self.quadtree.insert(id_u32, self.world.pos_x[i], self.world.pos_y[i]);
        }
    }

    fn resolve_collisions(&mut self) {
        let alive: Vec<u32> = self.world.alive_iter().to_vec();
        for j in 0..alive.len() {
            let i = alive[j] as usize;
            if !self.world.alive[i] { continue; }

            let x = self.world.pos_x[i];
            let y = self.world.pos_y[i];
            let r = self.world.radius[i];
            let search_r = r * 2.5;

            let neighbors = self.quadtree.query(x, y, search_r);

            for &nid in &neighbors {
                let k = nid as usize;
                if k <= i || !self.world.alive[k] { continue; }

                let dx = self.world.pos_x[k] - x;
                let dy = self.world.pos_y[k] - y;
                let dist_sq = dx * dx + dy * dy;
                let combined_r = r + self.world.radius[k];

                if dist_sq < combined_r * combined_r && dist_sq > 0.001 {
                    let dist = dist_sq.sqrt();
                    let overlap = combined_r - dist;
                    let nx = dx / dist;
                    let ny = dy / dist;
                    let repel = overlap * 1.5;

                    self.world.vel_x[i] -= nx * repel;
                    self.world.vel_y[i] -= ny * repel;
                    self.world.vel_x[k] += nx * repel;
                    self.world.vel_y[k] += ny * repel;
                }
            }
        }
    }

    /// Directly set a node's position (used during drag).
    pub fn set_position(&mut self, id: u32, x: f32, y: f32) {
        let i = id as usize;
        if i < self.world.max_entities && self.world.alive[i] {
            self.world.pos_x[i] = x;
            self.world.pos_y[i] = y;
        }
    }

    /// Set velocity to zero (pin in place).
    pub fn set_velocity_zero(&mut self, id: u32) {
        let i = id as usize;
        if i < self.world.max_entities && self.world.alive[i] {
            self.world.vel_x[i] = 0.0;
            self.world.vel_y[i] = 0.0;
        }
    }

    /// Apply an impulse (for fracture ejection, throws, etc).
    pub fn apply_impulse(&mut self, id: u32, vx: f32, vy: f32) {
        let i = id as usize;
        if i < self.world.max_entities && self.world.alive[i] {
            self.world.vel_x[i] += vx;
            self.world.vel_y[i] += vy;
        }
    }

    /// Get the number of active entities.
    pub fn active_count(&self) -> u32 {
        self.world.active_count() as u32
    }

    /// Pointer to a flat f32 array [x0, y0, x1, y1, ...] of all alive entities.
    /// Length = active_count() * 2.
    pub fn positions_ptr(&mut self) -> *const f32 {
        self.pos_export.clear();
        for &id_u32 in self.world.alive_iter() {
            let i = id_u32 as usize;
            self.pos_export.push(self.world.pos_x[i]);
            self.pos_export.push(self.world.pos_y[i]);
        }
        self.pos_export.as_ptr()
    }

    /// Pointer to a flat u32 array of all alive entity IDs.
    /// Length = active_count().
    pub fn active_ids_ptr(&mut self) -> *const u32 {
        self.id_export.clear();
        for &id_u32 in self.world.alive_iter() {
            self.id_export.push(id_u32);
        }
        self.id_export.as_ptr()
    }

    /// Get a single node's X position.
    pub fn pos_x(&self, id: u32) -> f32 {
        let i = id as usize;
        if i < self.world.max_entities && self.world.alive[i] {
            self.world.pos_x[i]
        } else { f32::NAN }
    }

    /// Get a single node's Y position.
    pub fn pos_y(&self, id: u32) -> f32 {
        let i = id as usize;
        if i < self.world.max_entities && self.world.alive[i] {
            self.world.pos_y[i]
        } else { f32::NAN }
    }

    pub fn set_viscosity(&mut self, v: f32) { self.physics.viscosity = v; }
    pub fn set_gravity(&mut self, g: f32) { self.physics.gravity_y = g; }
    pub fn frame_count(&self) -> u64 { self.frame_count }
    pub fn width(&self) -> u32 { self.canvas_width }
    pub fn height(&self) -> u32 { self.canvas_height }
}
