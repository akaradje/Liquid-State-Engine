//! Physics / Kinematics System
//!
//! Handles velocity integration, viscosity (drag), boundary reflection,
//! and force application. Designed for smooth, "liquid-like" motion.
//!
//! Iterates the compact alive_list to skip dead slots.
//! SIMD f32x4 processing of 4 entities in parallel when available.

use crate::ecs::World;

/// Physics system configuration and state.
pub struct PhysicsSystem {
    pub viscosity: f32,
    pub bounce: f32,
    pub gravity_y: f32,
    pub max_speed: f32,
    pub spring_stiffness: f32,
    pub spring_damping: f32,

    pinned: Vec<bool>,
    pin_target_x: Vec<f32>,
    pin_target_y: Vec<f32>,
}

impl PhysicsSystem {
    pub fn new() -> Self {
        PhysicsSystem {
            viscosity: 0.02,
            bounce: 0.7,
            gravity_y: 0.0,
            max_speed: 1000.0,
            spring_stiffness: 300.0,
            spring_damping: 8.0,
            pinned: Vec::new(),
            pin_target_x: Vec::new(),
            pin_target_y: Vec::new(),
        }
    }

    fn ensure_pin_capacity(&mut self, max_entities: usize) {
        if self.pinned.len() < max_entities {
            self.pinned.resize(max_entities, false);
            self.pin_target_x.resize(max_entities, 0.0);
            self.pin_target_y.resize(max_entities, 0.0);
        }
    }

    pub fn pin_node(&mut self, world: &mut World, id: usize, cursor_x: f32, cursor_y: f32) {
        if id < world.max_entities && world.alive[id] {
            self.ensure_pin_capacity(world.max_entities);
            self.pinned[id] = true;
            self.pin_target_x[id] = cursor_x;
            self.pin_target_y[id] = cursor_y;
        }
    }

    pub fn unpin_node(&mut self, world: &mut World, id: usize) {
        if id < world.max_entities {
            self.ensure_pin_capacity(world.max_entities);
            self.pinned[id] = false;
        }
    }

    pub fn update_pin_target(&mut self, world: &mut World, id: usize, cursor_x: f32, cursor_y: f32) {
        if id < world.max_entities && self.pinned.len() > id {
            self.pin_target_x[id] = cursor_x;
            self.pin_target_y[id] = cursor_y;
        }
    }

    /// Update all entity positions using Symplectic Euler integration.
    /// Uses alive_list for O(active) iteration.
    /// SIMD path processes 4 entities in parallel lanes; scalar tail for remainder.
    pub fn update(&mut self, world: &mut World, dt: f32, bounds_w: f32, bounds_h: f32) {
        self.ensure_pin_capacity(world.max_entities);

        // Snapshot the alive IDs to release immutable borrow on world
        let alive: Vec<u32> = world.alive_iter().to_vec();
        let len = alive.len();
        let mut i = 0usize;

        // SIMD path: process 4 at a time
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            use core::arch::wasm32::*;
            let dt_v = f32x4_splat(dt);
            let max_spd = self.max_speed;
            let bounce = self.bounce;
            let grav = self.gravity_y;
            let stiff = self.spring_stiffness;
            let damp = self.spring_damping;
            let visc = self.viscosity;

            while i + 4 <= len {
                let id0 = alive[i] as usize;
                let id1 = alive[i + 1] as usize;
                let id2 = alive[i + 2] as usize;
                let id3 = alive[i + 3] as usize;

                // Load SoA into SIMD lanes
                let f_x = f32x4(world.force_x[id0], world.force_x[id1], world.force_x[id2], world.force_x[id3]);
                let f_y = f32x4(world.force_y[id0], world.force_y[id1], world.force_y[id2], world.force_y[id3]);
                let mass = f32x4(world.mass[id0], world.mass[id1], world.mass[id2], world.mass[id3]);

                // inv_mass = 1/mass
                let inv_mass = f32x4_div(f32x4_splat(1.0), mass);

                // Acceleration from forces: ax = fx * inv_mass, ay = fy * inv_mass + gravity
                let grav_v = f32x4_splat(grav);
                let ax = f32x4_mul(f_x, inv_mass);
                let ay = f32x4_add(f32x4_mul(f_y, inv_mass), grav_v);

                // Integrate velocities
                let nvx = f32x4_add(
                    f32x4(world.vel_x[id0], world.vel_x[id1], world.vel_x[id2], world.vel_x[id3]),
                    f32x4_mul(ax, dt_v),
                );
                let nvy = f32x4_add(
                    f32x4(world.vel_y[id0], world.vel_y[id1], world.vel_y[id2], world.vel_y[id3]),
                    f32x4_mul(ay, dt_v),
                );

                // Store intermediate velocities back (spring forces handled below)
                world.vel_x[id0] = f32x4_extract_lane::<0>(nvx);
                world.vel_x[id1] = f32x4_extract_lane::<1>(nvx);
                world.vel_x[id2] = f32x4_extract_lane::<2>(nvx);
                world.vel_x[id3] = f32x4_extract_lane::<3>(nvx);
                world.vel_y[id0] = f32x4_extract_lane::<0>(nvy);
                world.vel_y[id1] = f32x4_extract_lane::<1>(nvy);
                world.vel_y[id2] = f32x4_extract_lane::<2>(nvy);
                world.vel_y[id3] = f32x4_extract_lane::<3>(nvy);

                // Scalar spring + finish for each
                for &id in &[id0, id1, id2, id3] {
                    apply_spring(world, self, id, stiff, damp, dt);
                    apply_viscosity(world, id, visc);
                    speed_clamp(world, id, max_spd);
                    integrate(world, id, dt);
                    boundary_bounce(world, id, bounds_w, bounds_h, bounce);
                    clear_forces(world, id);
                }

                i += 4;
            }
        }

        // Scalar tail
        while i < len {
            let id = alive[i] as usize;
            scalar_update(world, self, id, dt, bounds_w, bounds_h);
            i += 1;
        }
    }
}

fn scalar_update(world: &mut World, phys: &PhysicsSystem, id: usize, dt: f32, bounds_w: f32, bounds_h: f32) {
    let mass = world.mass[id];
    let inv_mass = if mass > 0.0 { 1.0 / mass } else { 1.0 };

    let ax = world.force_x[id] * inv_mass;
    let ay = world.force_y[id] * inv_mass + phys.gravity_y;

    world.vel_x[id] += ax * dt;
    world.vel_y[id] += ay * dt;

    apply_spring(world, phys, id, phys.spring_stiffness, phys.spring_damping, dt);
    apply_viscosity(world, id, phys.viscosity);
    speed_clamp(world, id, phys.max_speed);
    integrate(world, id, dt);
    boundary_bounce(world, id, bounds_w, bounds_h, phys.bounce);
    clear_forces(world, id);
}

fn apply_spring(world: &mut World, phys: &PhysicsSystem, id: usize, stiff: f32, damp: f32, dt: f32) {
    if id < phys.pinned.len() && phys.pinned[id] {
        let inv_mass = if world.mass[id] > 0.0 { 1.0 / world.mass[id] } else { 1.0 };
        let ox = phys.pin_target_x[id] - world.pos_x[id];
        let oy = phys.pin_target_y[id] - world.pos_y[id];
        let fx = stiff * ox - damp * world.vel_x[id];
        let fy = stiff * oy - damp * world.vel_y[id];
        world.vel_x[id] += fx * inv_mass * dt;
        world.vel_y[id] += fy * inv_mass * dt;
    }
}

fn apply_viscosity(world: &mut World, id: usize, viscosity: f32) {
    world.vel_x[id] *= 1.0 - viscosity;
    world.vel_y[id] *= 1.0 - viscosity;
}

fn speed_clamp(world: &mut World, id: usize, max_speed: f32) {
    let speed_sq = world.vel_x[id] * world.vel_x[id] + world.vel_y[id] * world.vel_y[id];
    if speed_sq > max_speed * max_speed {
        let speed = speed_sq.sqrt();
        let scale = max_speed / speed;
        world.vel_x[id] *= scale;
        world.vel_y[id] *= scale;
    }
}

fn integrate(world: &mut World, id: usize, dt: f32) {
    world.pos_x[id] += world.vel_x[id] * dt;
    world.pos_y[id] += world.vel_y[id] * dt;
}

fn boundary_bounce(world: &mut World, id: usize, bounds_w: f32, bounds_h: f32, bounce: f32) {
    let r = world.radius[id];
    if world.pos_x[id] - r < 0.0 {
        world.pos_x[id] = r;
        world.vel_x[id] = -world.vel_x[id] * bounce;
    } else if world.pos_x[id] + r > bounds_w {
        world.pos_x[id] = bounds_w - r;
        world.vel_x[id] = -world.vel_x[id] * bounce;
    }
    if world.pos_y[id] - r < 0.0 {
        world.pos_y[id] = r;
        world.vel_y[id] = -world.vel_y[id] * bounce;
    } else if world.pos_y[id] + r > bounds_h {
        world.pos_y[id] = bounds_h - r;
        world.vel_y[id] = -world.vel_y[id] * bounce;
    }
}

fn clear_forces(world: &mut World, id: usize) {
    world.force_x[id] = 0.0;
    world.force_y[id] = 0.0;
    // Stop micro-jitter
    if world.vel_x[id].abs() < 0.01 { world.vel_x[id] = 0.0; }
    if world.vel_y[id].abs() < 0.01 { world.vel_y[id] = 0.0; }
}
