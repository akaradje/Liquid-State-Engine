//! Software Renderer — CPU-based pixel buffer rendering.
//!
//! Renders entities as glassmorphic data boxes (rounded rectangles)
//! with bitmap text labels rendered inside each box. Box dimensions
//! auto-size to fit the label text length.
//!
//! Uses SIMD128 intrinsics when available for 4x pixel throughput.
//! Supports double-buffering for streaming frame delivery without stalls.
//! Implements LOD culling: sub-pixel nodes drawn as single pixels.

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
                let label_len = world.label_len[i] as usize;
                self.draw_data_box(
                    sx, sy, scaled_r,
                    world.color_r[i], world.color_g[i],
                    world.color_b[i], world.color_a[i],
                    &world.label_buf[i], label_len,
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

    /// Draw a glassmorphic data box — rounded rectangle with dark fill
    /// and bitmap text label. Pre-computes scanline pixel ranges for speed.
    fn draw_data_box(&mut self, cx: f32, cy: f32, radius: f32, _r: u8, _g: u8, _b: u8, _a: u8, label: &[u8], label_len: usize) {
        // Box dimensions
        let text_pixel_w = if label_len > 0 { (label_len * (FONT_CHAR_WIDTH + FONT_SPACE)) as f32 } else { 40.0 };
        let bw = (radius * 2.0).clamp(text_pixel_w + 28.0, 300.0);
        let bh = (radius * 0.7).clamp(26.0, 44.0);

        let left = (cx - bw / 2.0) as i32;
        let top = (cy - bh / 2.0) as i32;
        let right_i = (cx + bw / 2.0) as i32;
        let bottom_i = (cy + bh / 2.0) as i32;
        let cr = 8i32;

        // Clamp to canvas
        let x0 = left.max(0);
        let y0 = top.max(0);
        let x1 = right_i.min(self.width as i32 - 1);
        let y1 = bottom_i.min(self.height as i32 - 1);
        if x0 > x1 || y0 > y1 { return; }

        // Colors
        let fill_r: u8 = 18;  let fill_g: u8 = 22;  let fill_b: u8 = 36;
        let border_r: u8 = 50; let border_g: u8 = 120; let border_b: u8 = 200;
        let text_r: u8 = 200; let text_g: u8 = 225; let text_b: u8 = 255;

        let buf_w = self.width as usize;
        let buf = &mut self.buffer_back;

        // Pre-compute corner exclusion ranges for each scanline (fast integer math)
        for py in y0..=y1 {
            let row_off = py as usize * buf_w;

            // Compute horizontal span for this scanline, accounting for rounded corners
            let (span_left, span_right) = rounded_span(py, left, top, right_i, bottom_i, cr);
            let sx = span_left.max(x0);
            let ex = span_right.min(x1);
            if sx > ex { continue; }

            // 1px border: first and last pixel of span, plus top/bottom rows
            let is_near_border_row = py >= top && py <= top + cr + 1 || py >= bottom_i - cr - 1 && py <= bottom_i;

            for px in sx..=ex {
                let idx = (row_off + px as usize) * 4;
                if idx + 3 >= buf.len() { continue; }

                // Simple border detection: edges of the rounded span
                let is_border = px == span_left || px == span_right
                    || (is_near_border_row && (px <= left + cr + 2 || px >= right_i - cr - 2));

                if is_border {
                    buf[idx] = border_r;
                    buf[idx + 1] = border_g;
                    buf[idx + 2] = border_b;
                    buf[idx + 3] = 255;
                } else {
                    // Fast fill: average with background for translucent effect
                    buf[idx]     = ((fill_r as u16 + buf[idx] as u16) / 2) as u8;
                    buf[idx + 1] = ((fill_g as u16 + buf[idx + 1] as u16) / 2) as u8;
                    buf[idx + 2] = ((fill_b as u16 + buf[idx + 2] as u16) / 2) as u8;
                    buf[idx + 3] = 255;
                }
            }
        }

        // Draw text label centered inside the box
        if label_len > 0 {
            draw_text(buf, self.width as usize, self.height as usize,
                      cx as i32, cy as i32, &label[..label_len],
                      text_r, text_g, text_b);
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

// ---- Bitmap Font (5x7 pixels per glyph, stored as 8 u8 rows) ----

/// Font data: each glyph is 8 bytes (8 rows), each byte = 8 horizontal pixels (only bits 7..3 used for 5px width).
/// Ordered: space, 0-9, A-Z, a-z, hyphen, dot, slash, underscore, parens, colon, comma, plus.
const FONT_5X7: &[u8] = &[
    // space (char 0)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    // 0
    0x70, 0x88, 0x98, 0xA8, 0xC8, 0x88, 0x70, 0x00,
    // 1
    0x20, 0x60, 0xA0, 0x20, 0x20, 0x20, 0xF8, 0x00,
    // 2
    0x70, 0x88, 0x08, 0x10, 0x20, 0x40, 0xF8, 0x00,
    // 3
    0x70, 0x88, 0x08, 0x30, 0x08, 0x88, 0x70, 0x00,
    // 4
    0x10, 0x30, 0x50, 0x90, 0xF8, 0x10, 0x10, 0x00,
    // 5
    0xF8, 0x80, 0xF0, 0x08, 0x08, 0x88, 0x70, 0x00,
    // 6
    0x70, 0x80, 0xF0, 0x88, 0x88, 0x88, 0x70, 0x00,
    // 7
    0xF8, 0x08, 0x10, 0x20, 0x40, 0x40, 0x40, 0x00,
    // 8
    0x70, 0x88, 0x88, 0x70, 0x88, 0x88, 0x70, 0x00,
    // 9
    0x70, 0x88, 0x88, 0x78, 0x08, 0x08, 0x70, 0x00,
    // A (10)
    0x20, 0x50, 0x88, 0x88, 0xF8, 0x88, 0x88, 0x00,
    // B
    0xF0, 0x88, 0x88, 0xF0, 0x88, 0x88, 0xF0, 0x00,
    // C
    0x70, 0x88, 0x80, 0x80, 0x80, 0x88, 0x70, 0x00,
    // D
    0xF0, 0x88, 0x88, 0x88, 0x88, 0x88, 0xF0, 0x00,
    // E
    0xF8, 0x80, 0x80, 0xF0, 0x80, 0x80, 0xF8, 0x00,
    // F
    0xF8, 0x80, 0x80, 0xF0, 0x80, 0x80, 0x80, 0x00,
    // G
    0x70, 0x88, 0x80, 0x98, 0x88, 0x88, 0x70, 0x00,
    // H
    0x88, 0x88, 0x88, 0xF8, 0x88, 0x88, 0x88, 0x00,
    // I
    0x70, 0x20, 0x20, 0x20, 0x20, 0x20, 0x70, 0x00,
    // J
    0x38, 0x10, 0x10, 0x10, 0x10, 0x90, 0x60, 0x00,
    // K
    0x88, 0x90, 0xA0, 0xC0, 0xA0, 0x90, 0x88, 0x00,
    // L
    0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0xF8, 0x00,
    // M
    0x88, 0xD8, 0xA8, 0xA8, 0x88, 0x88, 0x88, 0x00,
    // N
    0x88, 0xC8, 0xA8, 0x98, 0x88, 0x88, 0x88, 0x00,
    // O
    0x70, 0x88, 0x88, 0x88, 0x88, 0x88, 0x70, 0x00,
    // P
    0xF0, 0x88, 0x88, 0xF0, 0x80, 0x80, 0x80, 0x00,
    // Q
    0x70, 0x88, 0x88, 0x88, 0xA8, 0x90, 0x68, 0x00,
    // R
    0xF0, 0x88, 0x88, 0xF0, 0xA0, 0x90, 0x88, 0x00,
    // S
    0x70, 0x88, 0x80, 0x70, 0x08, 0x88, 0x70, 0x00,
    // T
    0xF8, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x00,
    // U
    0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x70, 0x00,
    // V
    0x88, 0x88, 0x88, 0x88, 0x50, 0x50, 0x20, 0x00,
    // W
    0x88, 0x88, 0x88, 0xA8, 0xA8, 0xD8, 0x88, 0x00,
    // X
    0x88, 0x88, 0x50, 0x20, 0x50, 0x88, 0x88, 0x00,
    // Y
    0x88, 0x88, 0x50, 0x20, 0x20, 0x20, 0x20, 0x00,
    // Z
    0xF8, 0x08, 0x10, 0x20, 0x40, 0x80, 0xF8, 0x00,
    // a (36)
    0x00, 0x00, 0x70, 0x08, 0x78, 0x88, 0x78, 0x00,
    // b
    0x80, 0x80, 0xF0, 0x88, 0x88, 0x88, 0xF0, 0x00,
    // c
    0x00, 0x00, 0x70, 0x88, 0x80, 0x88, 0x70, 0x00,
    // d
    0x08, 0x08, 0x78, 0x88, 0x88, 0x88, 0x78, 0x00,
    // e
    0x00, 0x00, 0x70, 0x88, 0xF8, 0x80, 0x70, 0x00,
    // f
    0x30, 0x48, 0x40, 0xE0, 0x40, 0x40, 0x40, 0x00,
    // g
    0x00, 0x00, 0x78, 0x88, 0x88, 0x78, 0x08, 0x70,
    // h
    0x80, 0x80, 0xF0, 0x88, 0x88, 0x88, 0x88, 0x00,
    // i
    0x20, 0x00, 0x60, 0x20, 0x20, 0x20, 0x70, 0x00,
    // j
    0x10, 0x00, 0x30, 0x10, 0x10, 0x10, 0x90, 0x60,
    // k
    0x80, 0x80, 0x90, 0xA0, 0xC0, 0xA0, 0x90, 0x00,
    // l
    0x60, 0x20, 0x20, 0x20, 0x20, 0x20, 0x70, 0x00,
    // m
    0x00, 0x00, 0xD0, 0xA8, 0xA8, 0xA8, 0xA8, 0x00,
    // n
    0x00, 0x00, 0xF0, 0x88, 0x88, 0x88, 0x88, 0x00,
    // o
    0x00, 0x00, 0x70, 0x88, 0x88, 0x88, 0x70, 0x00,
    // p
    0x00, 0x00, 0xF0, 0x88, 0x88, 0xF0, 0x80, 0x80,
    // q
    0x00, 0x00, 0x78, 0x88, 0x88, 0x78, 0x08, 0x08,
    // r
    0x00, 0x00, 0xB0, 0xC8, 0x80, 0x80, 0x80, 0x00,
    // s
    0x00, 0x00, 0x78, 0x80, 0x70, 0x08, 0xF0, 0x00,
    // t
    0x40, 0x40, 0xE0, 0x40, 0x40, 0x48, 0x30, 0x00,
    // u
    0x00, 0x00, 0x88, 0x88, 0x88, 0x98, 0x68, 0x00,
    // v
    0x00, 0x00, 0x88, 0x88, 0x88, 0x50, 0x20, 0x00,
    // w
    0x00, 0x00, 0x88, 0xA8, 0xA8, 0xA8, 0x50, 0x00,
    // x
    0x00, 0x00, 0x88, 0x50, 0x20, 0x50, 0x88, 0x00,
    // y
    0x00, 0x00, 0x88, 0x88, 0x88, 0x78, 0x08, 0x70,
    // z
    0x00, 0x00, 0xF8, 0x10, 0x20, 0x40, 0xF8, 0x00,
    // - (62)
    0x00, 0x00, 0x00, 0x00, 0x70, 0x00, 0x00, 0x00,
    // .
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x60,
    // /
    0x00, 0x08, 0x10, 0x20, 0x40, 0x80, 0x00, 0x00,
    // _ (65)
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x00,
    // (
    0x10, 0x20, 0x40, 0x40, 0x40, 0x20, 0x10, 0x00,
    // )
    0x40, 0x20, 0x10, 0x10, 0x10, 0x20, 0x40, 0x00,
    // : (68)
    0x00, 0x00, 0x60, 0x60, 0x00, 0x60, 0x60, 0x00,
    // ,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x20, 0x40,
    // + (70)
    0x00, 0x00, 0x20, 0x20, 0xF8, 0x20, 0x20, 0x00,
];

const FONT_CHAR_HEIGHT: usize = 8;
const FONT_CHAR_WIDTH: usize = 5;
const FONT_SPACE: usize = 1; // 1px spacing between chars

/// Map an ASCII byte to font index (0=space, 1-10=0-9, 10-35=A-Z, 36-61=a-z, 62+ = symbols)
fn char_to_font_idx(c: u8) -> usize {
    match c {
        b' ' => 0,
        b'0'..=b'9' => 1 + (c - b'0') as usize,
        b'A'..=b'Z' => 11 + (c - b'A') as usize,
        b'a'..=b'z' => 37 + (c - b'a') as usize,
        b'-' => 63,
        b'.' => 64,
        b'/' => 65,
        b'_' => 66,
        b'(' => 67,
        b')' => 68,
        b':' => 69,
        b',' => 70,
        b'+' => 71,
        _ => 0, // Unknown → space
    }
}

/// Draw a single character glyph at (px, py) in the back buffer.
fn draw_glyph(buf: &mut [u8], buf_w: usize, buf_h: usize, px: i32, py: i32, ch: u8, r: u8, g: u8, b: u8) {
    let idx = char_to_font_idx(ch);
    let glyph_offset = idx * FONT_CHAR_HEIGHT;
    if glyph_offset + FONT_CHAR_HEIGHT > FONT_5X7.len() { return; }

    for row in 0..FONT_CHAR_HEIGHT {
        let gy = py + row as i32;
        if gy < 0 || gy >= buf_h as i32 { continue; }

        let byte = FONT_5X7[glyph_offset + row];
        for col in 0..FONT_CHAR_WIDTH {
            // Bit 7 = leftmost pixel of glyph
            if (byte & (0x80 >> col)) != 0 {
                let gx = px + col as i32;
                if gx >= 0 && gx < buf_w as i32 {
                    let idx = (gy as usize * buf_w + gx as usize) * 4;
                    if idx + 3 < buf.len() {
                        buf[idx] = r;
                        buf[idx + 1] = g;
                        buf[idx + 2] = b;
                        buf[idx + 3] = 255;
                    }
                }
            }
        }
    }
}

/// Draw a text string inside a bounding box, centered.
fn draw_text(buf: &mut [u8], buf_w: usize, buf_h: usize,
             cx: i32, cy: i32, text: &[u8],
             text_r: u8, text_g: u8, text_b: u8) {
    let char_step = (FONT_CHAR_WIDTH + FONT_SPACE) as i32;
    let total_w = text.len() as i32 * char_step - FONT_SPACE as i32;
    let total_h = FONT_CHAR_HEIGHT as i32;
    let start_x = cx - total_w / 2;
    let start_y = cy - total_h / 2;

    for (i, &ch) in text.iter().enumerate() {
        let px = start_x + i as i32 * char_step;
        draw_glyph(buf, buf_w, buf_h, px, start_y, ch, text_r, text_g, text_b);
    }
}

/// For a given scanline `py`, compute the inclusive horizontal span [left, right]
/// of a rounded rectangle, accounting for corner radius `cr` at each corner.
/// Returns (span_left, span_right). If the scanline is entirely outside the box,
/// returns a span where left > right.
fn rounded_span(py: i32, left: i32, top: i32, right: i32, bottom: i32, cr: i32) -> (i32, i32) {
    if py < top || py > bottom {
        return (1, 0); // Empty span
    }

    let mut sx = left;
    let mut ex = right;

    // Top corners: narrow the span near the top
    if py < top + cr {
        let corner_dy = top + cr - py;
        let inset = cr - ((cr * cr - corner_dy * corner_dy) as f64).sqrt() as i32;
        sx = left + inset.max(0);
        ex = right - inset.max(0);
    }
    // Bottom corners: narrow the span near the bottom
    if py > bottom - cr {
        let corner_dy = py - (bottom - cr);
        let inset = cr - ((cr * cr - corner_dy * corner_dy) as f64).sqrt() as i32;
        sx = left + inset.max(0);
        ex = right - inset.max(0);
    }

    (sx, ex)
}

/// Returns 1 if the point (dx,dy) is inside the rounded rectangle defined by
/// (left,top,right,bottom) with corner radius cr. Returns 0 if outside a corner.
#[allow(dead_code)]
fn is_corner(dx: i32, dy: i32, left: i32, top: i32, right: i32, bottom: i32, cr: i32) -> u32 {
    // Check which corner region this point is in
    let in_tl_corner = dx < left + cr && dy < top + cr;
    let in_tr_corner = dx > right - cr && dy < top + cr;
    let in_bl_corner = dx < left + cr && dy > bottom - cr;
    let in_br_corner = dx > right - cr && dy > bottom - cr;

    if in_tl_corner {
        let cx = left + cr;
        let cy = top + cr;
        let dist_sq = (dx - cx) * (dx - cx) + (dy - cy) * (dy - cy);
        if dist_sq > cr * cr { return 0; }
    } else if in_tr_corner {
        let cx = right - cr;
        let cy = top + cr;
        let dist_sq = (dx - cx) * (dx - cx) + (dy - cy) * (dy - cy);
        if dist_sq > cr * cr { return 0; }
    } else if in_bl_corner {
        let cx = left + cr;
        let cy = bottom - cr;
        let dist_sq = (dx - cx) * (dx - cx) + (dy - cy) * (dy - cy);
        if dist_sq > cr * cr { return 0; }
    } else if in_br_corner {
        let cx = right - cr;
        let cy = bottom - cr;
        let dist_sq = (dx - cx) * (dx - cx) + (dy - cy) * (dy - cy);
        if dist_sq > cr * cr { return 0; }
    }

    1 // Inside the rounded rectangle
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
