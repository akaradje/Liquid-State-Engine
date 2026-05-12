//! Software Renderer - CPU-based pixel buffer rendering.
//!
//! Uses SIMD128 intrinsics when available for 4x pixel throughput.
//! Supports double-buffering for streaming frame delivery without stalls.
//! Implements LOD culling: sub-pixel nodes skip expensive circle rasterization.

use crate::ecs::World;

// ---- SIMD imports (wasm32 only) ----
#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::*;

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

// ---- LOD constants ----
const MIN_CIRCLE_RADIUS: f32 = 2.0; // Below this, draw single pixel
const MIN_VISIBLE_RADIUS: f32 = 0.8; // Below this, skip entirely if stationary
const MIN_MOVE_SQ: f32 = 0.25; // Movement threshold for sub-pixel nodes

/// The Software Renderer that manages the pixel buffer.
pub struct SoftwareRenderer {
    /// Front buffer — stable for JS read (always the one returned by buffer_ptr).
    buffer_front: Vec<u8>,
    /// Back buffer — written by render(), swapped after frame complete.
    buffer_back: Vec<u8>,
    width: u32,
    height: u32,
    /// Current frame's dirty rectangle.
    dirty: DirtyRect,
    /// Exported dirty rect as [x, y, w, h] for JS consumption.
    dirty_rect_export: [u32; 4],
    /// Previous frame positions for dirty tracking.
    prev_pos_x: Vec<f32>,
    prev_pos_y: Vec<f32>,
    /// Viewport for frustum culling.
    pub viewport_x: f32,
    pub viewport_y: f32,
    pub viewport_scale: f32,
    /// Y-sorted entity indices for batch draw (cache-friendly scanline order).
    draw_order: Vec<u32>,
}

impl SoftwareRenderer {
    /// Create a new renderer for the given canvas dimensions.
    pub fn new(width: u32, height: u32) -> Self {
        let buf_size = (width * height * 4) as usize;
        SoftwareRenderer {
            buffer_front: vec![0u8; buf_size],
            buffer_back: vec![0u8; buf_size],
            width,
            height,
            dirty: DirtyRect::new(),
            dirty_rect_export: [0, 0, 0, 0],
            prev_pos_x: Vec::new(),
            prev_pos_y: Vec::new(),
            viewport_x: 0.0,
            viewport_y: 0.0,
            viewport_scale: 1.0,
            draw_order: Vec::new(),
        }
    }

    /// Set viewport for frustum culling.
    pub fn set_viewport(&mut self, x: f32, y: f32, scale: f32) {
        self.viewport_x = x;
        self.viewport_y = y;
        self.viewport_scale = scale;
    }

    /// Swap front and back buffers — call after frame is complete and before
    /// JS reads the pixel buffer.
    pub fn swap_buffers(&mut self) {
        std::mem::swap(&mut self.buffer_front, &mut self.buffer_back);
    }

    /// Render all alive entities to the pixel buffer.
    /// Uses dirty rectangles, LOD culling, and SIMD where available.
    pub fn render(&mut self, world: &World) {
        self.dirty = DirtyRect::new();

        // Ensure prev_pos arrays are sized correctly
        if self.prev_pos_x.len() < world.max_entities {
            self.prev_pos_x.resize(world.max_entities, -1.0);
            self.prev_pos_y.resize(world.max_entities, -1.0);
        }

        let scale = self.viewport_scale;
        let vx = self.viewport_x;
        let vy = self.viewport_y;
        let vw = self.width as f32 / scale;
        let vh = self.height as f32 / scale;

        // Step 1: Mark previous positions as dirty
        for i in 0..world.max_entities {
            if self.prev_pos_x[i] >= 0.0 {
                // Cull check: only mark dirty if in viewport
                let px = self.prev_pos_x[i];
                let py = self.prev_pos_y[i];
                if px + 100.0 > vx && px - 100.0 < vx + vw
                    && py + 100.0 > vy && py - 100.0 < vy + vh
                {
                    let sx = ((px - vx) * scale) as u32;
                    let sy = ((py - vy) * scale) as u32;
                    let r = (world.radius[i] as u32).max(1) + 1;
                    self.dirty.expand(sx, sy, r);
                }
            }
        }

        // Step 2: Mark current alive positions as dirty (viewport culled)
        for i in 0..world.max_entities {
            if world.alive[i] {
                let px = world.pos_x[i];
                let py = world.pos_y[i];
                if px + 100.0 > vx && px - 100.0 < vx + vw
                    && py + 100.0 > vy && py - 100.0 < vy + vh
                {
                    let sx = ((px - vx) * scale) as u32;
                    let sy = ((py - vy) * scale) as u32;
                    let r = ((world.radius[i] * scale) as u32).max(1) + 1;
                    self.dirty.expand(sx, sy, r);
                }
            }
        }

        // Step 3: Clear dirty region to background color (SIMD or scalar)
        if self.dirty.active {
            self.clear_region(
                self.dirty.min_x,
                self.dirty.min_y,
                self.dirty.max_x,
                self.dirty.max_y,
            );
        }

        // Step 4: Build Y-sorted draw order (cache-friendly scanline order)
        // (draw_order was taken by previous frame's iteration, so it's already clear)
        for i in 0..world.max_entities {
            if world.alive[i] {
                // Viewport frustum cull
                let px = world.pos_x[i];
                let py = world.pos_y[i];
                let r = world.radius[i];
                let scaled_r = r * scale;
                let sx = (px - vx) * scale;
                let sy = (py - vy) * scale;

                if sx + scaled_r < 0.0 || sx - scaled_r > self.width as f32
                    || sy + scaled_r < 0.0 || sy - scaled_r > self.height as f32
                {
                    self.prev_pos_x[i] = world.pos_x[i];
                    self.prev_pos_y[i] = world.pos_y[i];
                    continue; // Entirely off-screen
                }

                // LOD: stationary sub-pixel nodes are invisible
                let dx = world.pos_x[i] - self.prev_pos_x[i];
                let dy = world.pos_y[i] - self.prev_pos_y[i];
                let moved_sq = dx * dx + dy * dy;
                if scaled_r < MIN_VISIBLE_RADIUS && moved_sq < MIN_MOVE_SQ {
                    self.prev_pos_x[i] = world.pos_x[i];
                    self.prev_pos_y[i] = world.pos_y[i];
                    continue; // Too small and stationary, skip
                }

                self.draw_order.push(i as u32);
            }
        }

        // Sort by Y coordinate for cache-friendly scanline access
        self.draw_order.sort_by(|&a, &b| {
            let ya = world.pos_y[a as usize];
            let yb = world.pos_y[b as usize];
            ya.partial_cmp(&yb).unwrap_or(std::cmp::Ordering::Equal)
        });

        // Step 5: Batch-draw all entities in Y-sorted order
        // Take the draw order to release the immutable borrow
        let order = std::mem::take(&mut self.draw_order);
        for &idx in &order {
            let i = idx as usize;
            let px = world.pos_x[i];
            let py = world.pos_y[i];
            let r = world.radius[i];
            let sx = (px - vx) * scale;
            let sy = (py - vy) * scale;
            let scaled_r = r * scale;

            // LOD: use single-pixel fast path for tiny nodes
            if scaled_r < MIN_CIRCLE_RADIUS {
                self.draw_single_pixel(sx, sy, world.color_r[i], world.color_g[i], world.color_b[i], world.color_a[i]);
            } else {
                self.draw_circle(
                    sx, sy, scaled_r,
                    world.color_r[i], world.color_g[i],
                    world.color_b[i], world.color_a[i],
                );
            }
            self.prev_pos_x[i] = world.pos_x[i];
            self.prev_pos_y[i] = world.pos_y[i];
        }

        // Put the draw_order back for reuse next frame
        self.draw_order = order;
        self.draw_order.clear();

        // Mark dead entities as cleared
        for i in 0..world.max_entities {
            if !world.alive[i] {
                self.prev_pos_x[i] = -1.0;
                self.prev_pos_y[i] = -1.0;
            }
        }

        // Step 6: Export dirty rect for JS
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

    /// Draw a single pixel (for LOD-culled distant nodes).
    fn draw_single_pixel(&mut self, x: f32, y: f32, r: u8, g: u8, b: u8, a: u8) {
        let px = x as i32;
        let py = y as i32;
        if px >= 0 && px < self.width as i32 && py >= 0 && py < self.height as i32 {
            let idx = ((py as u32 * self.width + px as u32) * 4) as usize;
            if a == 255 {
                self.buffer_back[idx] = r;
                self.buffer_back[idx + 1] = g;
                self.buffer_back[idx + 2] = b;
            } else {
                let alpha = a as f32 / 255.0;
                self.buffer_back[idx] = (r as f32 * alpha + self.buffer_back[idx] as f32 * (1.0 - alpha)) as u8;
                self.buffer_back[idx + 1] = (g as f32 * alpha + self.buffer_back[idx + 1] as f32 * (1.0 - alpha)) as u8;
                self.buffer_back[idx + 2] = (b as f32 * alpha + self.buffer_back[idx + 2] as f32 * (1.0 - alpha)) as u8;
            }
            self.buffer_back[idx + 3] = 255;
        }
    }

    /// Clear a rectangular region to the background color.
    /// Uses SIMD 128-bit writes when available (16 bytes / 4 pixels per iteration).
    fn clear_region(&mut self, min_x: u32, min_y: u32, max_x: u32, max_y: u32) {
        let bg_r: u8 = 10;
        let bg_g: u8 = 10;
        let bg_b: u8 = 20;
        let bg_a: u8 = 255;

        let x_start = min_x.min(self.width);
        let x_end = max_x.min(self.width);
        let y_start = min_y.min(self.height);
        let y_end = max_y.min(self.height);

        let line_width = (x_end.saturating_sub(x_start)) as usize;
        if line_width == 0 { return; }

        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            let bg_pixel = u8x16(bg_r, bg_g, bg_b, bg_a, bg_r, bg_g, bg_b, bg_a,
                                  bg_r, bg_g, bg_b, bg_a, bg_r, bg_g, bg_b, bg_a);

            for y in y_start..y_end {
                let row_start = ((y * self.width + x_start) * 4) as usize;
                let row_end = row_start + line_width * 4;
                let mut p = row_start;

                // SIMD: write 16 bytes (4 pixels) per iteration
                while p + 16 <= row_end && p + 16 <= self.buffer_back.len() {
                    unsafe {
                        v128_store(self.buffer_back.as_mut_ptr().add(p) as *mut v128, bg_pixel);
                    }
                    p += 16;
                }
                // Scalar tail
                while p < row_end && p + 3 < self.buffer_back.len() {
                    self.buffer_back[p] = bg_r;
                    self.buffer_back[p + 1] = bg_g;
                    self.buffer_back[p + 2] = bg_b;
                    self.buffer_back[p + 3] = bg_a;
                    p += 4;
                }
            }
            return;
        }

        // Scalar fallback
        #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
        {
            for y in y_start..y_end {
                let row_start = ((y * self.width + x_start) * 4) as usize;
                let row_end = row_start + line_width * 4;
                let mut p = row_start;
                // Write 4 pixels at a time (still better than 1)
                while p + 16 <= row_end && p + 16 <= self.buffer_back.len() {
                    self.buffer_back[p] = bg_r;
                    self.buffer_back[p + 1] = bg_g;
                    self.buffer_back[p + 2] = bg_b;
                    self.buffer_back[p + 3] = bg_a;
                    self.buffer_back[p + 4] = bg_r;
                    self.buffer_back[p + 5] = bg_g;
                    self.buffer_back[p + 6] = bg_b;
                    self.buffer_back[p + 7] = bg_a;
                    self.buffer_back[p + 8] = bg_r;
                    self.buffer_back[p + 9] = bg_g;
                    self.buffer_back[p + 10] = bg_b;
                    self.buffer_back[p + 11] = bg_a;
                    self.buffer_back[p + 12] = bg_r;
                    self.buffer_back[p + 13] = bg_g;
                    self.buffer_back[p + 14] = bg_b;
                    self.buffer_back[p + 15] = bg_a;
                    p += 16;
                }
                // Tail
                while p < row_end && p + 3 < self.buffer_back.len() {
                    self.buffer_back[p] = bg_r;
                    self.buffer_back[p + 1] = bg_g;
                    self.buffer_back[p + 2] = bg_b;
                    self.buffer_back[p + 3] = bg_a;
                    p += 4;
                }
            }
        }
    }

    /// Draw a filled circle. SIMD-accelerated on wasm32 with simd128.
    fn draw_circle(&mut self, cx: f32, cy: f32, radius: f32, r: u8, g: u8, b: u8, a: u8) {
        let cx_i = cx as i32;
        let cy_i = cy as i32;
        let rad_i = radius as i32;
        if rad_i <= 0 { return; }

        let opaque = a == 255;

        for dy in -rad_i..=rad_i {
            let dx_max_sq = rad_i * rad_i - dy * dy;
            if dx_max_sq < 0 { continue; }
            let dx_max = (dx_max_sq as f32).sqrt() as i32;

            let py = cy_i + dy;
            if py < 0 || py >= self.height as i32 { continue; }

            let x_start = (cx_i - dx_max).max(0) as usize;
            let x_end = ((cx_i + dx_max).min(self.width as i32 - 1)) as usize;
            if x_start > x_end { continue; }

            let row_base = py as u32 as usize * self.width as usize;

            if opaque {
                self.draw_circle_span_opaque(row_base, x_start, x_end, r, g, b);
            } else {
                self.draw_circle_span_alpha(row_base, x_start, x_end, r, g, b, a);
            }
        }
    }

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    fn draw_circle_span_opaque(&mut self, row_base: usize, x_start: usize, x_end: usize, r: u8, g: u8, b: u8) {
        let pixel = u8x16(r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255);
        let mut px = x_start;
        let buf = &mut self.buffer_back;
        while px + 4 <= x_end {
            let idx = (row_base + px) * 4;
            if idx + 16 <= buf.len() {
                unsafe { v128_store(buf.as_mut_ptr().add(idx) as *mut v128, pixel); }
            }
            px += 4;
        }
        // Scalar tail
        while px <= x_end {
            let idx = (row_base + px) * 4;
            if idx + 3 < buf.len() {
                buf[idx] = r;
                buf[idx + 1] = g;
                buf[idx + 2] = b;
                buf[idx + 3] = 255;
            }
            px += 1;
        }
    }

    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    fn draw_circle_span_opaque(&mut self, row_base: usize, x_start: usize, x_end: usize, r: u8, g: u8, b: u8) {
        let mut px = x_start;
        while px + 4 <= x_end {
            let idx = (row_base + px) * 4;
            let buf = &mut self.buffer_back;
            if idx + 16 <= buf.len() {
                buf[idx] = r; buf[idx+1] = g; buf[idx+2] = b; buf[idx+3] = 255;
                buf[idx+4] = r; buf[idx+5] = g; buf[idx+6] = b; buf[idx+7] = 255;
                buf[idx+8] = r; buf[idx+9] = g; buf[idx+10] = b; buf[idx+11] = 255;
                buf[idx+12] = r; buf[idx+13] = g; buf[idx+14] = b; buf[idx+15] = 255;
            }
            px += 4;
        }
        while px <= x_end {
            let idx = (row_base + px) * 4;
            let buf = &mut self.buffer_back;
            if idx + 3 < buf.len() {
                buf[idx] = r; buf[idx+1] = g; buf[idx+2] = b; buf[idx+3] = 255;
            }
            px += 1;
        }
    }

    /// Alpha-blended span. Uses integer fixed-point blending:
    /// result = (src * alpha + dst * (255 - alpha) + 128) / 255
    /// Grouped into chunks of 4 pixels for throughput.
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    fn draw_circle_span_alpha(&mut self, row_base: usize, x_start: usize, x_end: usize, r: u8, g: u8, b: u8, a: u8) {
        let mut px = x_start;
        let buf = &mut self.buffer_back;
        // Process 4 pixels at a time with integer math
        while px + 4 <= x_end {
            let idx = (row_base + px) * 4;
            if idx + 16 > buf.len() { break; }
            scalar_alpha_pixel(buf, idx, r, g, b, a);
            scalar_alpha_pixel(buf, idx + 4, r, g, b, a);
            scalar_alpha_pixel(buf, idx + 8, r, g, b, a);
            scalar_alpha_pixel(buf, idx + 12, r, g, b, a);
            px += 4;
        }
        while px <= x_end {
            let idx = (row_base + px) * 4;
            if idx + 3 < buf.len() {
                scalar_alpha_pixel(buf, idx, r, g, b, a);
            }
            px += 1;
        }
    }

    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    fn draw_circle_span_alpha(&mut self, row_base: usize, x_start: usize, x_end: usize, r: u8, g: u8, b: u8, a: u8) {
        let mut px = x_start;
        let buf = &mut self.buffer_back;
        let alpha = a as f32 / 255.0;
        let inv_alpha = 1.0 - alpha;
        while px <= x_end {
            let idx = (row_base + px) * 4;
            if idx + 3 < buf.len() {
                buf[idx] = (r as f32 * alpha + buf[idx] as f32 * inv_alpha) as u8;
                buf[idx + 1] = (g as f32 * alpha + buf[idx + 1] as f32 * inv_alpha) as u8;
                buf[idx + 2] = (b as f32 * alpha + buf[idx + 2] as f32 * inv_alpha) as u8;
                buf[idx + 3] = 255;
            }
            px += 1;
        }
    }

    // ---- Public API ----

    pub fn buffer_ptr(&self) -> *const u8 {
        self.buffer_front.as_ptr()
    }

    pub fn buffer_len(&self) -> usize {
        self.buffer_front.len()
    }

    pub fn dirty_rect_ptr(&self) -> *const u32 {
        self.dirty_rect_export.as_ptr()
    }

    pub fn has_dirty_region(&self) -> bool {
        self.dirty.active
    }

    pub fn clear_dirty(&mut self) {
        self.dirty.active = false;
    }
}

// ---- Helper: scalar alpha-blend one pixel ----
#[allow(dead_code)]
fn scalar_alpha_pixel(buf: &mut [u8], idx: usize, r: u8, g: u8, b: u8, a: u8) {
    let alpha = a as u32;
    let inv = 255u32 - alpha;
    let dr = buf[idx] as u32;
    let dg = buf[idx + 1] as u32;
    let db = buf[idx + 2] as u32;
    buf[idx] = ((r as u32 * alpha + dr * inv + 128) / 255) as u8;
    buf[idx + 1] = ((g as u32 * alpha + dg * inv + 128) / 255) as u8;
    buf[idx + 2] = ((b as u32 * alpha + db * inv + 128) / 255) as u8;
    buf[idx + 3] = 255;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecs::World;

    #[test]
    fn new_renderer_has_correct_size() {
        let r = SoftwareRenderer::new(100, 200);
        assert_eq!(r.buffer_len(), 100 * 200 * 4);
    }

    #[test]
    fn double_buffer_swap() {
        let mut r = SoftwareRenderer::new(4, 4);
        let ptr_before = r.buffer_ptr();
        r.swap_buffers();
        let ptr_after = r.buffer_ptr();
        // Front and back are swapped: front pointer should change
        // (the front buffer after swap is the old back buffer)
        assert_ne!(ptr_before, ptr_after);
    }

    #[test]
    fn clear_dirty_resets() {
        let mut r = SoftwareRenderer::new(10, 10);
        // Render a world with one node to trigger dirty
        let mut world = World::new(10);
        world.spawn(5.0, 5.0, 0.0, 0.0, 255, 255, 255, 255, 1, 4.0);
        r.render(&world);
        assert!(r.has_dirty_region());
        r.clear_dirty();
        assert!(!r.has_dirty_region());
    }
}
