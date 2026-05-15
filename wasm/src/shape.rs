use wasm_bindgen::prelude::*;

/// Triangle mesh data structure
pub struct Triangles {
    pub(crate) vertices: Vec<f32>,
    pub(crate) hole_x: Vec<f32>,
    pub(crate) hole_y: Vec<f32>,
    pub(crate) hole_radius: Vec<f32>,
}

impl Triangles {
    pub fn new(
        vertices: Vec<f32>,
        hole_x: Vec<f32>,
        hole_y: Vec<f32>,
        hole_radius: Vec<f32>,
    ) -> Triangles {
        Triangles {
            vertices,
            hole_x,
            hole_y,
            hole_radius,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.vertices = Vec::new();
        self.hole_x = Vec::new();
        self.hole_y = Vec::new();
        self.hole_radius = Vec::new();
    }
}

/// Circle primitive data structure
pub struct Circles {
    pub(crate) x: Vec<f32>,
    pub(crate) y: Vec<f32>,
    pub(crate) radius: Vec<f32>,
    pub(crate) hole_x: Vec<f32>,
    pub(crate) hole_y: Vec<f32>,
    pub(crate) hole_radius: Vec<f32>,
}

impl Circles {
    pub fn new(
        x: Vec<f32>,
        y: Vec<f32>,
        radius: Vec<f32>,
        hole_x: Vec<f32>,
        hole_y: Vec<f32>,
        hole_radius: Vec<f32>,
    ) -> Circles {
        Circles {
            x,
            y,
            radius,
            hole_x,
            hole_y,
            hole_radius,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x = Vec::new();
        self.y = Vec::new();
        self.radius = Vec::new();
        self.hole_x = Vec::new();
        self.hole_y = Vec::new();
        self.hole_radius = Vec::new();
    }
}

/// Arc primitive data structure
pub struct Arcs {
    pub(crate) x: Vec<f32>,
    pub(crate) y: Vec<f32>,
    pub(crate) radius: Vec<f32>,
    pub(crate) start_angle: Vec<f32>,
    pub(crate) sweep_angle: Vec<f32>,
    pub(crate) thickness: Vec<f32>,
}

impl Arcs {
    pub fn new(
        x: Vec<f32>,
        y: Vec<f32>,
        radius: Vec<f32>,
        start_angle: Vec<f32>,
        sweep_angle: Vec<f32>,
        thickness: Vec<f32>,
    ) -> Arcs {
        Arcs {
            x,
            y,
            radius,
            start_angle,
            sweep_angle,
            thickness,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x = Vec::new();
        self.y = Vec::new();
        self.radius = Vec::new();
        self.start_angle = Vec::new();
        self.sweep_angle = Vec::new();
        self.thickness = Vec::new();
    }
}

/// Thermal primitive data structure
pub struct Thermals {
    pub(crate) x: Vec<f32>,
    pub(crate) y: Vec<f32>,
    pub(crate) outer_diameter: Vec<f32>,
    pub(crate) inner_diameter: Vec<f32>,
    pub(crate) gap_thickness: Vec<f32>,
    pub(crate) rotation: Vec<f32>,
}

impl Thermals {
    pub fn new(
        x: Vec<f32>,
        y: Vec<f32>,
        outer_diameter: Vec<f32>,
        inner_diameter: Vec<f32>,
        gap_thickness: Vec<f32>,
        rotation: Vec<f32>,
    ) -> Thermals {
        Thermals {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
        }
    }

    pub(crate) fn release_cpu_geometry(&mut self) {
        self.x = Vec::new();
        self.y = Vec::new();
        self.outer_diameter = Vec::new();
        self.inner_diameter = Vec::new();
        self.gap_thickness = Vec::new();
        self.rotation = Vec::new();
    }
}

/// Boundary information for the entire Gerber layer
#[wasm_bindgen]
pub struct Boundary {
    pub(crate) min_x: f32,
    pub(crate) max_x: f32,
    pub(crate) min_y: f32,
    pub(crate) max_y: f32,
}

#[wasm_bindgen]
impl Boundary {
    #[wasm_bindgen(constructor)]
    pub fn new(min_x: f32, max_x: f32, min_y: f32, max_y: f32) -> Boundary {
        Boundary {
            min_x,
            max_x,
            min_y,
            max_y,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn min_x(&self) -> f32 {
        self.min_x
    }

    #[wasm_bindgen(getter)]
    pub fn max_x(&self) -> f32 {
        self.max_x
    }

    #[wasm_bindgen(getter)]
    pub fn min_y(&self) -> f32 {
        self.min_y
    }

    #[wasm_bindgen(getter)]
    pub fn max_y(&self) -> f32 {
        self.max_y
    }
}

/// Container for all parsed Gerber data
pub struct GerberData {
    pub(crate) triangles: Triangles,
    pub(crate) circles: Circles,
    pub(crate) arcs: Arcs,
    pub(crate) thermals: Thermals,
    pub(crate) boundary: Boundary,
    pub(crate) is_negative: bool,
}

impl GerberData {
    pub fn new(
        triangles: Triangles,
        circles: Circles,
        arcs: Arcs,
        thermals: Thermals,
        boundary: Boundary,
        is_negative: bool,
    ) -> GerberData {
        GerberData {
            triangles,
            circles,
            arcs,
            thermals,
            boundary,
            is_negative,
        }
    }

    /// Check if this GerberData contains any geometry
    pub fn has_geometry(&self) -> bool {
        !self.triangles.vertices.is_empty()
            || !self.circles.x.is_empty()
            || !self.arcs.x.is_empty()
            || !self.thermals.x.is_empty()
    }
}
