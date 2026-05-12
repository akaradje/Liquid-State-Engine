//! Bitwise Relational Logic System
//!
//! Implements the merge (OR) and fracture (decompose) operations
//! that form the core data-interaction model of the Liquid-State Engine.
//!
//! Each node carries a bitmask representing its fundamental properties:
//! - Bit 0 (001): Red component
//! - Bit 1 (010): Green component
//! - Bit 2 (100): Blue component
//! - Bits 3+: Extended properties
//!
//! When two nodes collide:
//! - MERGE: new_mask = a.mask | b.mask (combines properties)
//! - FRACTURE: splits a composite node into its individual bit components

use crate::ecs::World;
use crate::quadtree::Quadtree;

/// Color mapping from bitmask bits to RGBA values.
/// This defines the "rainbow spectrum" of fundamental elements.
const BIT_COLORS: [(u8, u8, u8); 8] = [
    (255, 60, 60),    // Bit 0: Red
    (60, 255, 60),    // Bit 1: Green
    (60, 100, 255),   // Bit 2: Blue
    (255, 255, 60),   // Bit 3: Yellow
    (255, 60, 255),   // Bit 4: Magenta
    (60, 255, 255),   // Bit 5: Cyan
    (255, 160, 60),   // Bit 6: Orange
    (200, 130, 255),  // Bit 7: Purple
];

/// The Relational Logic system.
pub struct RelationSystem {
    /// Minimum distance ratio for collision (relative to combined radii).
    pub collision_threshold: f32,
    /// Merge queue: pairs of entities to merge this frame.
    merge_queue: Vec<(usize, usize)>,
    /// Search radius multiplier for neighbor queries.
    pub search_radius_mul: f32,
}

impl RelationSystem {
    pub fn new() -> Self {
        RelationSystem {
            collision_threshold: 0.8,
            merge_queue: Vec::with_capacity(256),
            search_radius_mul: 2.5,
        }
    }

    /// Process collisions and execute merge logic.
    /// Called once per frame after quadtree is built.
    pub fn process(&mut self, world: &mut World, quadtree: &Quadtree) {
        self.merge_queue.clear();

        // Detect collisions via quadtree
        for i in 0..world.max_entities {
            if !world.alive[i] {
                continue;
            }

            let x = world.pos_x[i];
            let y = world.pos_y[i];
            let r = world.radius[i];
            let search_r = r * self.search_radius_mul;

            let neighbors = quadtree.query_neighbors(x, y, search_r);

            for &neighbor_id in &neighbors {
                let j = neighbor_id as usize;
                if j <= i || !world.alive[j] {
                    continue; // Skip self, dead, and already-checked pairs
                }

                // Distance check
                let dx = world.pos_x[j] - x;
                let dy = world.pos_y[j] - y;
                let dist_sq = dx * dx + dy * dy;
                let combined_r = (r + world.radius[j]) * self.collision_threshold;

                if dist_sq < combined_r * combined_r {
                    // Collision detected! Check if they can merge.
                    let mask_a = world.bitmask[i];
                    let mask_b = world.bitmask[j];

                    // Only merge if they have different properties to combine
                    if mask_a != mask_b && (mask_a & mask_b) != mask_a && (mask_a & mask_b) != mask_b {
                        self.merge_queue.push((i, j));
                    } else {
                        // Same type - elastic repulsion
                        let dist = dist_sq.sqrt().max(0.1);
                        let overlap = combined_r / self.collision_threshold - dist;
                        let nx = dx / dist;
                        let ny = dy / dist;
                        let repel = overlap * 2.0;

                        world.vel_x[i] -= nx * repel;
                        world.vel_y[i] -= ny * repel;
                        world.vel_x[j] += nx * repel;
                        world.vel_y[j] += ny * repel;
                    }
                }
            }
        }

        // Execute merges
        for &(a, b) in &self.merge_queue.clone() {
            if !world.alive[a] || !world.alive[b] {
                continue; // May have been consumed by earlier merge
            }
            self.merge(world, a, b);
        }
    }

    /// Merge two entities: combine bitmasks with OR, create new entity, remove originals.
    fn merge(&self, world: &mut World, a: usize, b: usize) {
        let new_mask = world.bitmask[a] | world.bitmask[b];

        // New position: center of mass
        let total_mass = world.mass[a] + world.mass[b];
        let new_x = (world.pos_x[a] * world.mass[a] + world.pos_x[b] * world.mass[b]) / total_mass;
        let new_y = (world.pos_y[a] * world.mass[a] + world.pos_y[b] * world.mass[b]) / total_mass;

        // New velocity: conservation of momentum
        let new_vx = (world.vel_x[a] * world.mass[a] + world.vel_x[b] * world.mass[b]) / total_mass;
        let new_vy = (world.vel_y[a] * world.mass[a] + world.vel_y[b] * world.mass[b]) / total_mass;

        // New color: derived from combined bitmask
        let (r, g, b_color) = Self::color_from_bitmask(new_mask);

        // New radius: area-preserving merge
        let area = std::f32::consts::PI * (world.radius[a].powi(2) + world.radius[b].powi(2));
        let new_radius = (area / std::f32::consts::PI).sqrt();

        // Remove originals
        world.despawn(a);
        world.despawn(b);

        // Spawn merged entity
        world.spawn(new_x, new_y, new_vx, new_vy, r, g, b_color, 230, new_mask, new_radius);
    }

    /// Fracture an entity into its individual bit components.
    /// Each set bit becomes a new separate node.
    pub fn fracture(&self, world: &mut World, id: usize) {
        if !world.alive[id] || id >= world.max_entities {
            return;
        }

        let mask = world.bitmask[id];
        let bit_count = mask.count_ones();
        if bit_count <= 1 {
            return; // Cannot fracture a fundamental element
        }

        let cx = world.pos_x[id];
        let cy = world.pos_y[id];
        let original_radius = world.radius[id];

        // Calculate child radius (area-preserving split)
        let child_radius = original_radius / (bit_count as f32).sqrt();

        // Remove the original
        world.despawn(id);

        // Spawn individual components in a circular pattern
        let angle_step = std::f32::consts::TAU / bit_count as f32;
        let eject_speed = 80.0; // Ejection velocity
        let mut angle = 0.0f32;

        for bit in 0..32u32 {
            if mask & (1 << bit) != 0 {
                let child_mask = 1u32 << bit;
                let (r, g, b) = Self::color_from_bitmask(child_mask);

                let offset_x = angle.cos() * original_radius * 0.5;
                let offset_y = angle.sin() * original_radius * 0.5;
                let vx = angle.cos() * eject_speed;
                let vy = angle.sin() * eject_speed;

                world.spawn(
                    cx + offset_x,
                    cy + offset_y,
                    vx, vy,
                    r, g, b, 255,
                    child_mask,
                    child_radius,
                );

                angle += angle_step;
            }
        }
    }

    /// Derive a display color from a bitmask by blending component colors.
    fn color_from_bitmask(mask: u32) -> (u8, u8, u8) {
        if mask == 0 {
            return (128, 128, 128); // Neutral gray
        }

        let mut r_sum: u32 = 0;
        let mut g_sum: u32 = 0;
        let mut b_sum: u32 = 0;
        let mut count: u32 = 0;

        for bit in 0..8u32 {
            if mask & (1 << bit) != 0 {
                let (cr, cg, cb) = BIT_COLORS[bit as usize];
                r_sum += cr as u32;
                g_sum += cg as u32;
                b_sum += cb as u32;
                count += 1;
            }
        }

        // Handle bits beyond our color table
        let extra_bits = (mask >> 8).count_ones();
        if extra_bits > 0 {
            r_sum += 200 * extra_bits;
            g_sum += 200 * extra_bits;
            b_sum += 200 * extra_bits;
            count += extra_bits;
        }

        if count == 0 {
            return (128, 128, 128);
        }

        (
            (r_sum / count).min(255) as u8,
            (g_sum / count).min(255) as u8,
            (b_sum / count).min(255) as u8,
        )
    }
}
