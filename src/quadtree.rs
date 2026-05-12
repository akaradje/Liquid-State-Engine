//! Quadtree Spatial Partitioning
//!
//! Divides 2D space into recursive quadrants for efficient spatial queries.
//! Reduces collision detection from O(N^2) to approximately O(N log N).
//!
//! The quadtree is rebuilt every frame from scratch (cheaper than maintaining
//! incremental updates with fast-moving objects).

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
    x: f32,      // left
    y: f32,      // top
    w: f32,      // width
    h: f32,      // height
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

/// A node in the quadtree (either leaf or internal).
struct QTNode {
    boundary: AABB,
    points: Vec<QTPoint>,
    capacity: usize,
    divided: bool,
    // Children indices in the nodes pool
    nw: usize,
    ne: usize,
    sw: usize,
    se: usize,
}

/// The Quadtree spatial index.
pub struct Quadtree {
    nodes: Vec<QTNode>,
    max_depth: u32,
    node_capacity: usize,
    root_boundary: AABB,
}

impl Quadtree {
    /// Create a new quadtree covering the specified region.
    ///
    /// # Arguments
    /// * `x`, `y` - Top-left corner of the region
    /// * `w`, `h` - Width and height of the region
    /// * `max_depth` - Maximum recursion depth
    /// * `node_capacity` - Max points per leaf before subdivision
    pub fn new(x: f32, y: f32, w: f32, h: f32, max_depth: u32, node_capacity: usize) -> Self {
        let boundary = AABB { x, y, w, h };
        let root = QTNode {
            boundary,
            points: Vec::with_capacity(node_capacity),
            capacity: node_capacity,
            divided: false,
            nw: 0, ne: 0, sw: 0, se: 0,
        };
        Quadtree {
            nodes: vec![root],
            max_depth,
            node_capacity,
            root_boundary: boundary,
        }
    }

    /// Clear and reset the quadtree for a new frame.
    pub fn clear(&mut self) {
        self.nodes.clear();
        let root = QTNode {
            boundary: self.root_boundary,
            points: Vec::with_capacity(self.node_capacity),
            capacity: self.node_capacity,
            divided: false,
            nw: 0, ne: 0, sw: 0, se: 0,
        };
        self.nodes.push(root);
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

        if !self.nodes[node_idx].divided && 
           self.nodes[node_idx].points.len() < self.nodes[node_idx].capacity {
            self.nodes[node_idx].points.push(point);
            return;
        }

        if !self.nodes[node_idx].divided {
            if depth >= self.max_depth {
                // At max depth, just store it here
                self.nodes[node_idx].points.push(point);
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

    fn subdivide(&mut self, node_idx: usize) {
        let b = self.nodes[node_idx].boundary;
        let hw = b.w / 2.0;
        let hh = b.h / 2.0;
        let cap = self.nodes[node_idx].capacity;

        let nw_idx = self.nodes.len();
        self.nodes.push(QTNode {
            boundary: AABB { x: b.x, y: b.y, w: hw, h: hh },
            points: Vec::with_capacity(cap),
            capacity: cap,
            divided: false,
            nw: 0, ne: 0, sw: 0, se: 0,
        });

        let ne_idx = self.nodes.len();
        self.nodes.push(QTNode {
            boundary: AABB { x: b.x + hw, y: b.y, w: hw, h: hh },
            points: Vec::with_capacity(cap),
            capacity: cap,
            divided: false,
            nw: 0, ne: 0, sw: 0, se: 0,
        });

        let sw_idx = self.nodes.len();
        self.nodes.push(QTNode {
            boundary: AABB { x: b.x, y: b.y + hh, w: hw, h: hh },
            points: Vec::with_capacity(cap),
            capacity: cap,
            divided: false,
            nw: 0, ne: 0, sw: 0, se: 0,
        });

        let se_idx = self.nodes.len();
        self.nodes.push(QTNode {
            boundary: AABB { x: b.x + hw, y: b.y + hh, w: hw, h: hh },
            points: Vec::with_capacity(cap),
            capacity: cap,
            divided: false,
            nw: 0, ne: 0, sw: 0, se: 0,
        });

        self.nodes[node_idx].nw = nw_idx;
        self.nodes[node_idx].ne = ne_idx;
        self.nodes[node_idx].sw = sw_idx;
        self.nodes[node_idx].se = se_idx;
        self.nodes[node_idx].divided = true;

        // Re-insert existing points into children
        let existing: Vec<QTPoint> = self.nodes[node_idx].points.drain(..).collect();
        for p in existing {
            self.insert_into(nw_idx, p, 0);
            self.insert_into(ne_idx, p, 0);
            self.insert_into(sw_idx, p, 0);
            self.insert_into(se_idx, p, 0);
        }
    }

    /// Query all entities within a rectangular region.
    /// Returns entity IDs found in the area.
    pub fn query_rect(&self, x: f32, y: f32, w: f32, h: f32) -> Vec<u32> {
        let range = AABB { x, y, w, h };
        let mut found = Vec::new();
        self.query_node(0, &range, &mut found);
        found
    }

    /// Query all entities near a point within a given radius.
    /// Uses a bounding box approximation first, then exact distance check
    /// should be done by the caller.
    pub fn query(&self, x: f32, y: f32, radius: f32) -> Vec<u32> {
        self.query_rect(x - radius, y - radius, radius * 2.0, radius * 2.0)
    }

    fn query_node(&self, node_idx: usize, range: &AABB, found: &mut Vec<u32>) {
        if node_idx >= self.nodes.len() {
            return;
        }
        
        let node = &self.nodes[node_idx];
        if !node.boundary.intersects(range) {
            return;
        }

        for p in &node.points {
            if range.contains(p.x, p.y) {
                found.push(p.id);
            }
        }

        if node.divided {
            self.query_node(node.nw, range, found);
            self.query_node(node.ne, range, found);
            self.query_node(node.sw, range, found);
            self.query_node(node.se, range, found);
        }
    }

    /// Query all entities that could potentially collide with a given entity.
    /// Uses the entity's radius to define the search area.
    pub fn query_neighbors(&self, x: f32, y: f32, search_radius: f32) -> Vec<u32> {
        self.query(x, y, search_radius)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_query_single_point() {
        let mut qt = Quadtree::new(0.0, 0.0, 800.0, 600.0, 8, 4);
        qt.insert(42, 100.0, 200.0);

        let found = qt.query(100.0, 200.0, 10.0);
        assert!(found.contains(&42));

        let empty = qt.query(500.0, 500.0, 10.0);
        assert!(empty.is_empty());
    }

    #[test]
    fn query_returns_multiple_points_in_area() {
        let mut qt = Quadtree::new(0.0, 0.0, 400.0, 400.0, 8, 4);
        qt.insert(1, 50.0, 50.0);
        qt.insert(2, 60.0, 55.0);
        qt.insert(3, 20.0, 20.0);
        qt.insert(4, 300.0, 300.0);

        // Query near (55, 52) should find id 1 and 2
        let found = qt.query(55.0, 52.0, 20.0);
        assert!(found.contains(&1));
        assert!(found.contains(&2));
        assert!(!found.contains(&3));
        assert!(!found.contains(&4));
    }

    #[test]
    fn clear_resets_all() {
        let mut qt = Quadtree::new(0.0, 0.0, 400.0, 400.0, 8, 4);
        qt.insert(1, 100.0, 100.0);
        assert!(!qt.query(100.0, 100.0, 5.0).is_empty());

        qt.clear();
        assert!(qt.query(100.0, 100.0, 5.0).is_empty());
    }

    #[test]
    fn many_points_subdivide() {
        let mut qt = Quadtree::new(0.0, 0.0, 1000.0, 1000.0, 8, 4);
        // Insert many points to force subdivision
        for i in 0..100u32 {
            let x = (i * 7) as f32 % 1000.0;
            let y = (i * 13) as f32 % 1000.0;
            qt.insert(i, x, y);
        }
        // Query should still work after subdivision
        let found = qt.query_rect(0.0, 0.0, 1000.0, 1000.0);
        assert_eq!(found.len(), 100);
    }
}
