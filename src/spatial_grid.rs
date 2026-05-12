//! Uniform Spatial Grid for dense scenes (>2000 nodes).
//!
//! Divides space into fixed-size cells. O(1) insertion via position hash.
//! Query checks the 3x3 neighborhood of cells around the target.
//! Each cell stores entity IDs inline (up to 16) with overflow for dense cells.
//!
//! Zero-allocation: cells and overflow are pre-allocated. clear() zeroes
//! counts without deallocation.

/// Fixed cell size in world units (pixels).
const CELL_SIZE: f32 = 64.0;
/// Inline entity capacity per cell.
const CELL_INLINE: usize = 16;

/// A single cell in the spatial grid.
struct Cell {
    /// Inline entity ID storage.
    ids: [u32; CELL_INLINE],
    /// Number of entities in the inline array.
    count: u8,
    /// Head index into overflow pool (linked list).
    overflow_head: u32,
}

/// Overflow pool entry for cells exceeding CELL_INLINE.
struct OverflowEntry {
    id: u32,
    next: u32,
}

/// Uniform spatial grid for O(1) spatial queries.
pub struct SpatialGrid {
    cells: Vec<Cell>,
    cell_cols: u32,
    cell_size: f32,
    world_w: f32,
    world_h: f32,
    /// Pre-allocated overflow pool.
    overflows: Vec<OverflowEntry>,
    overflow_free: Vec<u32>,
}

impl SpatialGrid {
    /// Create a new spatial grid covering the world bounds.
    pub fn new(world_w: f32, world_h: f32) -> Self {
        let cell_cols = (world_w / CELL_SIZE).ceil() as u32 + 1;
        let cell_rows = (world_h / CELL_SIZE).ceil() as u32 + 1;
        let num_cells = (cell_cols * cell_rows) as usize;

        let cells = (0..num_cells)
            .map(|_| Cell {
                ids: [0u32; CELL_INLINE],
                count: 0,
                overflow_head: 0,
            })
            .collect();

        SpatialGrid {
            cells,
            cell_cols,
            cell_size: CELL_SIZE,
            world_w,
            world_h,
            overflows: Vec::with_capacity(4096),
            overflow_free: Vec::with_capacity(4096),
        }
    }

    /// Clear all cells for a new frame. O(num_cells) only touches active cells.
    pub fn clear(&mut self) {
        // Only reset cells that had entries (tracked via non-zero count)
        for cell in &mut self.cells {
            cell.count = 0;
            cell.overflow_head = 0;
        }
        // Reset overflow free list
        self.overflow_free.clear();
        for i in (0..self.overflows.len()).rev() {
            self.overflow_free.push(i as u32);
        }
    }

    /// Insert an entity at the given position.
    pub fn insert(&mut self, id: u32, x: f32, y: f32) {
        let col = (x.max(0.0).min(self.world_w - 0.1) / self.cell_size) as u32;
        let row = (y.max(0.0).min(self.world_h - 0.1) / self.cell_size) as u32;
        let idx = (row * self.cell_cols + col) as usize;

        if idx >= self.cells.len() {
            return;
        }

        let cell = &mut self.cells[idx];

        if (cell.count as usize) < CELL_INLINE {
            cell.ids[cell.count as usize] = id;
            cell.count += 1;
        } else {
            // Overflow
            let entry_idx = if let Some(free) = self.overflow_free.pop() {
                let ei = free as usize;
                if ei < self.overflows.len() {
                    self.overflows[ei] = OverflowEntry { id, next: cell.overflow_head };
                }
                ei as u32
            } else {
                let ei = self.overflows.len();
                self.overflows.push(OverflowEntry { id, next: cell.overflow_head });
                ei as u32
            };
            cell.overflow_head = entry_idx;
        }
    }

    /// Query entities near a point. Checks the 3x3 neighborhood.
    /// Appends results to `out`.
    pub fn query(&self, x: f32, y: f32, radius: f32, out: &mut Vec<u32>) {
        let min_col = ((x - radius).max(0.0) / self.cell_size) as u32;
        let max_col = ((x + radius).min(self.world_w - 0.1) / self.cell_size) as u32;
        let min_row = ((y - radius).max(0.0) / self.cell_size) as u32;
        let max_row = ((y + radius).min(self.world_h - 0.1) / self.cell_size) as u32;

        for row in min_row..=max_row {
            for col in min_col..=max_col {
                let idx = (row * self.cell_cols + col) as usize;
                if idx >= self.cells.len() {
                    continue;
                }

                let cell = &self.cells[idx];
                // Inline IDs
                for i in 0..cell.count as usize {
                    out.push(cell.ids[i]);
                }
                // Overflow IDs
                let mut oi = cell.overflow_head;
                while oi != 0 {
                    let eidx = oi as usize;
                    if eidx < self.overflows.len() {
                        out.push(self.overflows[eidx].id);
                        oi = self.overflows[eidx].next;
                    } else {
                        break;
                    }
                }
            }
        }
    }
}
