//! Software Renderer - CPU-based pixel buffer rendering.
//!
//! Writes RGBA pixel data directly into a flat buffer that JavaScript
//! reads and puts onto the Canvas via `putImageData()`.
//!
//! Uses a "Dirty Rectangles" strategy: only the region that changed
//! since last frame is redrawn, dramatically reducing CPU work for
//! mostly-static scenes.

use crate::ecs::World;

/// Dirty rectangle tracking: the bounding box of all changes this frame.
#[derive(Clone, Copy)]
struct DirtyRect {
    min_x: u32,
    min_y: u32,
    max_x: u32,
    max_y: u32,
    active: bool,
}

impl DirtyRect {
    fn new() -> Self {
        DirtyRect {
            min_x: u32::MAX,
            min_y: u32::MAX,
            max_x: 0,
            max_y: 0,
            active: false,
        }
    }

    fn expand(&mut self, x: u32, y: u32, radius: u32) {
        let x_min = x.saturating_sub(radius);
        let y_min = y.saturating_sub(radius);
        let x_max = x + radius;
        let y_max = y + radius;

        self.min_x = self.min_x.min(x_min);
        self.min_y = self.min_y.min(y_min);
        self.max_x = self.max_x.max(x_max);
        self.max_y = self.max_y.max(y_max);
        self.active = true;
    }
}

/// The Software Renderer that manages the pixel buffer.
pub struct SoftwareRenderer {
    /// The RGBA pixel buffer (width * height * 4 bytes).
    buffer: Vec<u8>,
    width: u32,
    height: u32,
    /// Current frame's dirty rectangle.
    dirty: DirtyRect,
    /// Exported dirty rect as [x, y, w, h] for JS consumption.
    dirty_rect_export: [u32; 4],
    /// Previous frame positions for dirty tracking.
    prev_pos_x: Vec<f32>,
    prev_pos_y: Vec<f32>,
}

impl SoftwareRenderer {
    /// Create a new renderer for the given canvas dimensions.
    pub fn new(width: u32, height: u32) -> Self {
        let buf_size = (width * height * 4) as usize;
        SoftwareRenderer {
            buffer: vec![0u8; buf_size],
            width,
            height,
            dirty: DirtyRect::new(),
            dirty_rect_export: [0, 0, 0, 0],
            prev_pos_x: Vec::new(),
            prev_pos_y: Vec::new(),
        }
    }

    /// Render all alive entities to the pixel buffer.
    /// Uses dirty rectangles to minimize work.
    pub fn render(&mut self, world: &World) {
        // Reset dirty rect for this frame
        self.dirty = DirtyRect::new();

        // Ensure prev_pos arrays are sized correctly
        if self.prev_pos_x.len() < world.max_entities {
            self.prev_pos_x.resize(world.max_entities, -1.0);
            self.prev_pos_y.resize(world.max_entities, -1.0);
        }

        // Step 1: Mark previous positions as dirty (need clearing)
        for i in 0..world.max_entities {
            if self.prev_pos_x[i] >= 0.0 {
                let px = self.prev_pos_x[i] as u32;
                let py = self.prev_pos_y[i] as u32;
                let r = (world.radius[i] as u32).max(1) + 1;
                self.dirty.expand(px, py, r);
            }
        }

        // Step 2: Mark current alive positions as dirty
        for i in 0..world.max_entities {
            if world.alive[i] {
                let px = world.pos_x[i] as u32;
                let py = world.pos_y[i] as u32;
                let r = (world.radius[i] as u32).max(1) + 1;
                self.dirty.expand(px, py, r);
            }
        }

        // Step 3: Clear dirty region to background color (dark)
        if self.dirty.active {
            self.clear_region(
                self.dirty.min_x,
                self.dirty.min_y,
                self.dirty.max_x,
                self.dirty.max_y,
            );
        }

        // Step 4: Draw all alive entities (filled circles)
        for i in 0..world.max_entities {
            if world.alive[i] {
                self.draw_circle(
                    world.pos_x[i],
                    world.pos_y[i],
                    world.radius[i],
                    world.color_r[i],
                    world.color_g[i],
                    world.color_b[i],
                    world.color_a[i],
                );
                // Update previous positions
                self.prev_pos_x[i] = world.pos_x[i];
                self.prev_pos_y[i] = world.pos_y[i];
            } else {
                self.prev_pos_x[i] = -1.0;
                self.prev_pos_y[i] = -1.0;
            }
        }

        // Step 5: Export dirty rect for JS
        if self.dirty.active {
            let clamped_min_x = self.dirty.min_x.min(self.width);
            let clamped_min_y = self.dirty.min_y.min(self.height);
            let clamped_max_x = self.dirty.max_x.min(self.width);
            let clamped_max_y = self.dirty.max_y.min(self.height);
            self.dirty_rect_export = [
                clamped_min_x,
                clamped_min_y,
                clamped_max_x.saturating_sub(clamped_min_x),
                clamped_max_y.saturating_sub(clamped_min_y),
            ];
        } else {
            self.dirty_rect_export = [0, 0, 0, 0];
        }
    }

    /// Clear a rectangular region to the background color (near-black with slight blue tint).
    fn clear_region(&mut self, min_x: u32, min_y: u32, max_x: u32, max_y: u32) {
        let bg_r: u8 = 10;
        let bg_g: u8 = 10;
        let bg_b: u8 = 20;
        let bg_a: u8 = 255;

        let x_start = min_x.min(self.width);
        let x_end = max_x.min(self.width);
        let y_start = min_y.min(self.height);
        let y_end = max_y.min(self.height);

        for y in y_start..y_end {
            for x in x_start..x_end {
                let idx = ((y * self.width + x) * 4) as usize;
                if idx + 3 < self.buffer.len() {
                    self.buffer[idx] = bg_r;
                    self.buffer[idx + 1] = bg_g;
                    self.buffer[idx + 2] = bg_b;
                    self.buffer[idx + 3] = bg_a;
                }
            }
        }
    }

    /// Draw a filled circle using the midpoint circle algorithm variant.
    /// Supports alpha blending for glassmorphism-like transparency.
    fn draw_circle(&mut self, cx: f32, cy: f32, radius: f32, r: u8, g: u8, b: u8, a: u8) {
        let cx_i = cx as i32;
        let cy_i = cy as i32;
        let rad_i = radius as i32;

        let alpha = a as f32 / 255.0;
        let inv_alpha = 1.0 - alpha;

        for dy in -rad_i..=rad_i {
            // Horizontal span at this scanline
            let dx_max_sq = rad_i * rad_i - dy * dy;
            if dx_max_sq < 0 {
                continue;
            }
            let dx_max = (dx_max_sq as f32).sqrt() as i32;

            let py = cy_i + dy;
            if py < 0 || py >= self.height as i32 {
                continue;
            }

            let x_start = (cx_i - dx_max).max(0);
            let x_end = (cx_i + dx_max).min(self.width as i32 - 1);

            for px in x_start..=x_end {
                let idx = ((py as u32 * self.width + px as u32) * 4) as usize;
                if idx + 3 < self.buffer.len() {
                    if a == 255 {
                        // Opaque - fast path
                        self.buffer[idx] = r;
                        self.buffer[idx + 1] = g;
                        self.buffer[idx + 2] = b;
                        self.buffer[idx + 3] = 255;
                    } else {
                        // Alpha blend
                        let dst_r = self.buffer[idx] as f32;
                        let dst_g = self.buffer[idx + 1] as f32;
                        let dst_b = self.buffer[idx + 2] as f32;

                        self.buffer[idx] = (r as f32 * alpha + dst_r * inv_alpha) as u8;
                        self.buffer[idx + 1] = (g as f32 * alpha + dst_g * inv_alpha) as u8;
                        self.buffer[idx + 2] = (b as f32 * alpha + dst_b * inv_alpha) as u8;
                        self.buffer[idx + 3] = 255;
                    }
                }
            }
        }
    }

    /// Get a raw pointer to the pixel buffer (for Wasm memory export to JS).
    pub fn buffer_ptr(&self) -> *const u8 {
        self.buffer.as_ptr()
    }

    /// Get the buffer length in bytes.
    pub fn buffer_len(&self) -> usize {
        self.buffer.len()
    }

    /// Get a pointer to the dirty rectangle export data.
    pub fn dirty_rect_ptr(&self) -> *const u32 {
        self.dirty_rect_export.as_ptr()
    }

    /// Check if there's a dirty region this frame.
    pub fn has_dirty_region(&self) -> bool {
        self.dirty.active
    }

    /// Clear the dirty flag (called by JS after reading pixel data).
    pub fn clear_dirty(&mut self) {
        self.dirty.active = false;
    }
}
