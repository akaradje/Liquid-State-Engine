//! Quadtree Spatial Partitioning
//!
//! Divides 2D space into recursive quadrants for efficient spatial queries.
//! Reduces collision detection from O(N^2) to approximately O(N log N).
//!
//! **Zero-allocation design:**
//! - All node storage is pre-allocated in an arena (Vec with reserved capacity).
//! - `clear()` resets `arena_len` to 1 without deallocating.
//! - Points per leaf use a fixed-size inline array ([QTPoint; 8]) plus an
//!   optional overflow pointer into a shared overflow pool.
//! - Query methods accept a `&mut Vec<u32>` scratch buffer to avoid allocation.

/// A point stored in the quadtree: entity ID + position.
#[derive(Clone, Copy)]
struct QTPoint {
    id: u32,
    x: f32,
    y: f32,
}

/// Axis-aligned bounding box for quadtree regions.
#[derive(Clone, Copy)]
struct AABB {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

impl AABB {
    fn contains(&self, px: f32, py: f32) -> bool {
        px >= self.x && px < self.x + self.w &&
        py >= self.y && py < self.y + self.h
    }

    fn intersects(&self, other: &AABB) -> bool {
        !(other.x > self.x + self.w ||
          other.x + other.w < self.x ||
          other.y > self.y + self.h ||
          other.y + other.h < self.y)
    }
}

/// Maximum points stored inline per QTNode before subdivision or overflow.
const INLINE_CAP: usize = 8;

/// Overflow pool entry for nodes exceeding INLINE_CAP.
struct OverflowEntry {
    next: usize,
    point: QTPoint,
}

/// A node in the quadtree (either leaf or internal).
struct QTNode {
    boundary: AABB,
    /// Inline point storage (no heap for small counts).
    inline_points: [QTPoint; INLINE_CAP],
    inline_count: u8,
    /// Head index into the overflow pool linked list.
    overflow_head: usize,
    capacity: u8,
    divided: bool,
    nw: usize,
    ne: usize,
    sw: usize,
    se: usize,
}

/// Empty QTNode for arena initialization.
const EMPTY_QTNODE: QTNode = QTNode {
    boundary: AABB { x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
    inline_points: [QTPoint { id: 0, x: 0.0, y: 0.0 }; INLINE_CAP],
    inline_count: 0,
    overflow_head: 0,
    capacity: 0,
    divided: false,
    nw: 0, ne: 0, sw: 0, se: 0,
};

/// The Quadtree spatial index (arena-based, zero-alloc on clear).
pub struct Quadtree {
    /// Pre-allocated node pool (arena). clear() resets len to 1.
    nodes: Vec<QTNode>,
    /// Pre-allocated overflow pool for points beyond INLINE_CAP.
    overflows: Vec<OverflowEntry>,
    /// Free list for overflow entries (stack of indices).
    overflow_free: Vec<usize>,
    max_depth: u32,
}

/// Estimated max nodes in quadtree for pre-allocation.
/// For 10K entities with capacity 8, worst case ~ 1250 leaf nodes.
/// With subdivision, 4x overhead = ~5000 nodes max.
const MAX_QT_NODES: usize = 8192;

impl Quadtree {
    /// Create a new quadtree covering the specified region.
    /// Pre-allocates arena for zero runtime allocation.
    pub fn new(x: f32, y: f32, w: f32, h: f32, max_depth: u32, node_capacity: usize) -> Self {
        let boundary = AABB { x, y, w, h };
        let cap = node_capacity.min(INLINE_CAP) as u8;
        let mut root = EMPTY_QTNODE;
        root.boundary = boundary;
        root.capacity = cap;

        let mut nodes = Vec::with_capacity(MAX_QT_NODES);
        nodes.push(root);

        Quadtree {
            nodes,
            overflows: Vec::with_capacity(MAX_QT_NODES * 4),
            overflow_free: Vec::with_capacity(MAX_QT_NODES * 4),
            max_depth,
        }
    }

    /// Clear and reset the quadtree for a new frame.
    /// Does NOT deallocate — just resets arena length to 1 (root only).
    pub fn clear(&mut self) {
        unsafe { self.nodes.set_len(1); }
        let root = &mut self.nodes[0];
        root.inline_count = 0;
        root.overflow_head = 0;
        root.divided = false;
        root.nw = 0; root.ne = 0; root.sw = 0; root.se = 0;

        // Reset overflow free list
        self.overflow_free.clear();
        for i in (0..self.overflows.len()).rev() {
            self.overflow_free.push(i);
        }
    }

    /// Insert a point (entity) into the quadtree.
    pub fn insert(&mut self, id: u32, x: f32, y: f32) {
        let point = QTPoint { id, x, y };
        self.insert_into(0, point, 0);
    }

    fn insert_into(&mut self, node_idx: usize, point: QTPoint, depth: u32) {
        if !self.nodes[node_idx].boundary.contains(point.x, point.y) {
            return;
        }

        let node = &mut self.nodes[node_idx];
        let cap = node.capacity as usize;

        // Try inline storage first
        let inline_n = node.inline_count as usize;
        if !node.divided && inline_n < cap {
            node.inline_points[inline_n] = point;
            node.inline_count += 1;
            return;
        }

        if !node.divided {
            if depth >= self.max_depth {
                // At max depth — push to overflow
                self.add_overflow(node_idx, point);
                return;
            }
            self.subdivide(node_idx);
        }

        let nw = self.nodes[node_idx].nw;
        let ne = self.nodes[node_idx].ne;
        let sw = self.nodes[node_idx].sw;
        let se = self.nodes[node_idx].se;

        self.insert_into(nw, point, depth + 1);
        self.insert_into(ne, point, depth + 1);
        self.insert_into(sw, point, depth + 1);
        self.insert_into(se, point, depth + 1);
    }

    fn add_overflow(&mut self, node_idx: usize, point: QTPoint) {
        let entry_idx = if let Some(free) = self.overflow_free.pop() {
            self.overflows[free] = OverflowEntry { next: 0, point };
            free
        } else {
            let idx = self.overflows.len();
            self.overflows.push(OverflowEntry { next: 0, point });
            idx
        };
        let node = &mut self.nodes[node_idx];
        self.overflows[entry_idx].next = node.overflow_head;
        node.overflow_head = entry_idx;
    }

    fn subdivide(&mut self, node_idx: usize) {
        let b = self.nodes[node_idx].boundary;
        let hw = b.w / 2.0;
        let hh = b.h / 2.0;
        let cap = self.nodes[node_idx].capacity;

        let nw_idx = self.alloc_node(AABB { x: b.x, y: b.y, w: hw, h: hh }, cap);
        let ne_idx = self.alloc_node(AABB { x: b.x + hw, y: b.y, w: hw, h: hh }, cap);
        let sw_idx = self.alloc_node(AABB { x: b.x, y: b.y + hh, w: hw, h: hh }, cap);
        let se_idx = self.alloc_node(AABB { x: b.x + hw, y: b.y + hh, w: hw, h: hh }, cap);

        self.nodes[node_idx].nw = nw_idx;
        self.nodes[node_idx].ne = ne_idx;
        self.nodes[node_idx].sw = sw_idx;
        self.nodes[node_idx].se = se_idx;
        self.nodes[node_idx].divided = true;

        // Move inline points into children
        let inline_n = self.nodes[node_idx].inline_count as usize;
        let inline_pts: [QTPoint; INLINE_CAP] = self.nodes[node_idx].inline_points;
        self.nodes[node_idx].inline_count = 0;

        // Move overflow points
        let mut overflow_idx = self.nodes[node_idx].overflow_head;
        self.nodes[node_idx].overflow_head = 0;

        let depth = 0; // Re-insert at depth 0 from children

        for i in 0..inline_n {
            let p = inline_pts[i];
            self.insert_into(nw_idx, p, depth);
            self.insert_into(ne_idx, p, depth);
            self.insert_into(sw_idx, p, depth);
            self.insert_into(se_idx, p, depth);
        }

        while overflow_idx != 0 {
            let entry = &self.overflows[overflow_idx];
            let p = entry.point;
            let next = entry.next;
            // Free overflow entry
            self.overflow_free.push(overflow_idx);
            self.insert_into(nw_idx, p, depth);
            self.insert_into(ne_idx, p, depth);
            self.insert_into(sw_idx, p, depth);
            self.insert_into(se_idx, p, depth);
            overflow_idx = next;
        }
    }

    fn alloc_node(&mut self, boundary: AABB, capacity: u8) -> usize {
        let idx = self.nodes.len();
        let mut node = EMPTY_QTNODE;
        node.boundary = boundary;
        node.capacity = capacity;
        self.nodes.push(node);
        idx
    }

    // ---- Query methods (output into pre-allocated scratch buffer) ----

    /// Query all entities within a rectangular region.
    /// Appends entity IDs to `out` (does not clear it first — caller should clear).
    pub fn query_rect(&self, x: f32, y: f32, w: f32, h: f32, out: &mut Vec<u32>) {
        let range = AABB { x, y, w, h };
        self.query_node(0, &range, out);
    }

    /// Query all entities near a point within a given radius.
    pub fn query(&self, x: f32, y: f32, radius: f32, out: &mut Vec<u32>) {
        self.query_rect(x - radius, y - radius, radius * 2.0, radius * 2.0, out)
    }

    /// Query all entities that could potentially collide with a given entity.
    pub fn query_neighbors(&self, x: f32, y: f32, search_radius: f32, out: &mut Vec<u32>) {
        self.query(x, y, search_radius, out)
    }

    fn query_node(&self, node_idx: usize, range: &AABB, out: &mut Vec<u32>) {
        if node_idx >= self.nodes.len() { return; }

        let node = &self.nodes[node_idx];
        if !node.boundary.intersects(range) { return; }

        // Inline points
        for i in 0..node.inline_count as usize {
            let p = &node.inline_points[i];
            if range.contains(p.x, p.y) {
                out.push(p.id);
            }
        }

        // Overflow points
        let mut oi = node.overflow_head;
        while oi != 0 {
            if oi < self.overflows.len() {
                let p = &self.overflows[oi].point;
                if range.contains(p.x, p.y) {
                    out.push(p.id);
                }
                oi = self.overflows[oi].next;
            } else {
                break;
            }
        }

        // Recurse children
        if node.divided {
            self.query_node(node.nw, range, out);
            self.query_node(node.ne, range, out);
            self.query_node(node.sw, range, out);
            self.query_node(node.se, range, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_query_single_point() {
        let mut qt = Quadtree::new(0.0, 0.0, 800.0, 600.0, 8, 4);
        qt.insert(42, 100.0, 200.0);

        let mut out = Vec::new();
        qt.query(100.0, 200.0, 10.0, &mut out);
        assert!(out.contains(&42));

        out.clear();
        qt.query(500.0, 500.0, 10.0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn query_returns_multiple_points_in_area() {
        let mut qt = Quadtree::new(0.0, 0.0, 400.0, 400.0, 8, 4);
        qt.insert(1, 50.0, 50.0);
        qt.insert(2, 60.0, 55.0);
        qt.insert(3, 20.0, 20.0);
        qt.insert(4, 300.0, 300.0);

        let mut out = Vec::new();
        qt.query(55.0, 52.0, 20.0, &mut out);
        assert!(out.contains(&1));
        assert!(out.contains(&2));
        assert!(!out.contains(&3));
        assert!(!out.contains(&4));
    }

    #[test]
    fn clear_resets_all() {
        let mut qt = Quadtree::new(0.0, 0.0, 400.0, 400.0, 8, 4);
        qt.insert(1, 100.0, 100.0);
        let mut out = Vec::new();
        qt.query(100.0, 100.0, 5.0, &mut out);
        assert!(!out.is_empty());

        qt.clear();
        out.clear();
        qt.query(100.0, 100.0, 5.0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn many_points_subdivide() {
        let mut qt = Quadtree::new(0.0, 0.0, 1000.0, 1000.0, 8, 4);
        for i in 0..100u32 {
            let x = (i * 7) as f32 % 1000.0;
            let y = (i * 13) as f32 % 1000.0;
            qt.insert(i, x, y);
        }
        let mut out = Vec::new();
        qt.query_rect(0.0, 0.0, 1000.0, 1000.0, &mut out);
        assert_eq!(out.len(), 100);
    }
}
