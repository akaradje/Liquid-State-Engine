//! Physics / Kinematics System
//!
//! Handles velocity integration, viscosity (drag), boundary reflection,
//! and force application. Designed for smooth, "liquid-like" motion
//! that gives nodes a sense of weight and fluidity.

use crate::ecs::World;

/// Physics system configuration and state.
pub struct PhysicsSystem {
    /// Viscosity coefficient (0.0 = no drag, 1.0 = frozen).
    /// Acts as a damping force proportional to velocity.
    pub viscosity: f32,

    /// Coefficient of restitution for boundary bouncing (0.0-1.0).
    pub bounce: f32,

    /// Global gravity (pixels/sec^2). Set to 0 for zero-g mode.
    pub gravity_y: f32,

    /// Maximum velocity magnitude (speed limit).
    pub max_speed: f32,
}

impl PhysicsSystem {
    /// Create a new physics system with default liquid-like parameters.
    pub fn new() -> Self {
        PhysicsSystem {
            viscosity: 0.02,    // Light drag for fluid feel
            bounce: 0.7,       // Moderate bounce off walls
            gravity_y: 0.0,    // No gravity by default (floating workspace)
            max_speed: 1000.0, // Reasonable speed cap
        }
    }

    /// Update all entity positions based on velocity, forces, and constraints.
    ///
    /// Integration method: Semi-implicit Euler (Symplectic Euler)
    /// - First update velocity from forces
    /// - Then update position from new velocity
    /// This is more stable than explicit Euler for oscillatory systems.
    pub fn update(&self, world: &mut World, dt: f32, bounds_w: f32, bounds_h: f32) {
        for i in 0..world.max_entities {
            if !world.alive[i] {
                continue;
            }

            let mass = world.mass[i];
            let inv_mass = if mass > 0.0 { 1.0 / mass } else { 1.0 };

            // Apply accumulated forces -> acceleration -> velocity
            let ax = world.force_x[i] * inv_mass;
            let ay = world.force_y[i] * inv_mass + self.gravity_y;

            world.vel_x[i] += ax * dt;
            world.vel_y[i] += ay * dt;

            // Apply viscosity (velocity-dependent drag)
            world.vel_x[i] *= 1.0 - self.viscosity;
            world.vel_y[i] *= 1.0 - self.viscosity;

            // Clamp speed
            let speed_sq = world.vel_x[i] * world.vel_x[i] + world.vel_y[i] * world.vel_y[i];
            if speed_sq > self.max_speed * self.max_speed {
                let speed = speed_sq.sqrt();
                let scale = self.max_speed / speed;
                world.vel_x[i] *= scale;
                world.vel_y[i] *= scale;
            }

            // Integrate position
            world.pos_x[i] += world.vel_x[i] * dt;
            world.pos_y[i] += world.vel_y[i] * dt;

            // Boundary collision (reflect with energy loss)
            let r = world.radius[i];

            if world.pos_x[i] - r < 0.0 {
                world.pos_x[i] = r;
                world.vel_x[i] = -world.vel_x[i] * self.bounce;
            } else if world.pos_x[i] + r > bounds_w {
                world.pos_x[i] = bounds_w - r;
                world.vel_x[i] = -world.vel_x[i] * self.bounce;
            }

            if world.pos_y[i] - r < 0.0 {
                world.pos_y[i] = r;
                world.vel_y[i] = -world.vel_y[i] * self.bounce;
            } else if world.pos_y[i] + r > bounds_h {
                world.pos_y[i] = bounds_h - r;
                world.vel_y[i] = -world.vel_y[i] * self.bounce;
            }

            // Clear forces for next frame (forces are impulse-based)
            world.force_x[i] = 0.0;
            world.force_y[i] = 0.0;

            // Stop very slow entities (avoid micro-jitter)
            if world.vel_x[i].abs() < 0.01 {
                world.vel_x[i] = 0.0;
            }
            if world.vel_y[i].abs() < 0.01 {
                world.vel_y[i] = 0.0;
            }
        }
    }
}
