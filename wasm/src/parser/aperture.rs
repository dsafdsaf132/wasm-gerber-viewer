use super::aperture_macro::ApertureMacro;
use super::geometry::{scale_primitive, Primitive};
use super::state::Polarity;
use super::PolarityLayer;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct TriangleTemplateTransformKey {
    layer_scale: u32,
    mirror_x: bool,
    mirror_y: bool,
    layer_rotation: u32,
}

/// Aperture shape metadata used by optional interaction indexing.
#[derive(Clone, Debug, PartialEq)]
pub enum ApertureKind {
    Circle,
    Rectangle,
    Obround,
    Polygon,
    Macro,
    Block,
    Unknown,
}

impl ApertureKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ApertureKind::Circle => "circle",
            ApertureKind::Rectangle => "rectangle",
            ApertureKind::Obround => "obround",
            ApertureKind::Polygon => "polygon",
            ApertureKind::Macro => "macro",
            ApertureKind::Block => "block",
            ApertureKind::Unknown => "unknown",
        }
    }
}

/// Aperture definition (Circle, Rectangle, Obround, Polygon, or Macro reference)
#[derive(Clone, Debug)]
pub struct Aperture {
    pub radius: f32,
    pub primitives: Vec<Primitive>, // Aperture contains multiple basic primitives
    pub has_negative: bool,         // true if primitives contain exposure=0
    pub block_layers: Option<Vec<PolarityLayer>>,
    pub triangle_template: Option<Rc<Vec<f32>>>,
    triangle_template_cache: RefCell<HashMap<TriangleTemplateTransformKey, Rc<Vec<f32>>>>,
    pub is_solid_circle: bool,
    pub kind: ApertureKind,
    pub macro_name: Option<String>,
    pub width: f32,
    pub height: f32,
    pub hole_diameter: f32,
    pub vertices: u32,
    pub rotation: f32,
}

impl Aperture {
    pub fn new(radius: f32) -> Self {
        Aperture {
            radius,
            primitives: Vec::new(),
            has_negative: false,
            block_layers: None,
            triangle_template: None,
            triangle_template_cache: RefCell::new(HashMap::new()),
            is_solid_circle: false,
            kind: ApertureKind::Unknown,
            macro_name: None,
            width: 0.0,
            height: 0.0,
            hole_diameter: 0.0,
            vertices: 0,
            rotation: 0.0,
        }
    }

    pub fn new_block(block_layers: Vec<PolarityLayer>) -> Self {
        let has_negative = block_layers
            .iter()
            .any(|layer| layer.polarity == Polarity::Negative);

        Aperture {
            radius: 0.0,
            primitives: Vec::new(),
            has_negative,
            block_layers: Some(block_layers),
            triangle_template: None,
            triangle_template_cache: RefCell::new(HashMap::new()),
            is_solid_circle: false,
            kind: ApertureKind::Block,
            macro_name: None,
            width: 0.0,
            height: 0.0,
            hole_diameter: 0.0,
            vertices: 0,
            rotation: 0.0,
        }
    }

    pub(crate) fn triangle_template_for_transform(
        &self,
        layer_scale: f32,
        mirror_x: bool,
        mirror_y: bool,
        layer_rotation: f32,
    ) -> Option<Rc<Vec<f32>>> {
        let template = self.triangle_template.as_ref()?;
        if !layer_scale.is_finite() || layer_scale.abs() <= f32::EPSILON {
            return None;
        }

        if layer_scale == 1.0 && !mirror_x && !mirror_y && layer_rotation == 0.0 {
            return Some(Rc::clone(template));
        }

        let key = TriangleTemplateTransformKey {
            layer_scale: layer_scale.to_bits(),
            mirror_x,
            mirror_y,
            layer_rotation: layer_rotation.to_bits(),
        };
        if let Some(cached_template) = self.triangle_template_cache.borrow().get(&key) {
            return Some(Rc::clone(cached_template));
        }

        let cos_r = layer_rotation.cos();
        let sin_r = layer_rotation.sin();
        let mut vertices = Vec::new();
        if vertices.try_reserve(template.len()).is_err() {
            return None;
        }

        for point in template.chunks_exact(2) {
            let mut x = point[0] * layer_scale;
            let mut y = point[1] * layer_scale;
            if mirror_x {
                x = -x;
            }
            if mirror_y {
                y = -y;
            }
            vertices.push(x * cos_r - y * sin_r);
            vertices.push(x * sin_r + y * cos_r);
        }

        if mirror_x ^ mirror_y {
            for triangle in vertices.chunks_exact_mut(6) {
                triangle.swap(2, 4);
                triangle.swap(3, 5);
            }
        }

        let transformed_template = Rc::new(vertices);
        self.triangle_template_cache
            .borrow_mut()
            .insert(key, Rc::clone(&transformed_template));
        Some(transformed_template)
    }
}

fn triangle_vertices_are_renderable(vertices: &[[f32; 2]; 3]) -> bool {
    if !vertices
        .iter()
        .all(|point| point[0].is_finite() && point[1].is_finite())
    {
        return false;
    }

    let area2 = (vertices[1][0] - vertices[0][0]) * (vertices[2][1] - vertices[0][1])
        - (vertices[2][0] - vertices[0][0]) * (vertices[1][1] - vertices[0][1]);
    area2.is_finite() && area2.abs() > f32::EPSILON * f32::EPSILON
}

fn build_triangle_template(primitives: &[Primitive]) -> Option<Rc<Vec<f32>>> {
    if primitives.is_empty() {
        return None;
    }

    let vertex_capacity = primitives.len().checked_mul(6)?;
    let mut vertices = Vec::new();
    vertices.try_reserve(vertex_capacity).ok()?;
    for primitive in primitives {
        match primitive {
            Primitive::Triangle {
                vertices: triangle,
                exposure,
                hole_radius,
                ..
            } if *exposure >= 0.5
                && *hole_radius == 0.0
                && triangle_vertices_are_renderable(triangle) =>
            {
                for vertex in triangle {
                    vertices.push(vertex[0]);
                    vertices.push(vertex[1]);
                }
            }
            _ => return None,
        }
    }

    Some(Rc::new(vertices))
}

fn primitive_bounds(primitives: &[Primitive]) -> Option<(f32, f32, f32, f32)> {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for primitive in primitives {
        match primitive {
            Primitive::Triangle { vertices, .. } => {
                for vertex in vertices {
                    min_x = min_x.min(vertex[0]);
                    max_x = max_x.max(vertex[0]);
                    min_y = min_y.min(vertex[1]);
                    max_y = max_y.max(vertex[1]);
                }
            }
            Primitive::Circle { x, y, radius, .. } => {
                min_x = min_x.min(*x - *radius);
                max_x = max_x.max(*x + *radius);
                min_y = min_y.min(*y - *radius);
                max_y = max_y.max(*y + *radius);
            }
            Primitive::Arc {
                x,
                y,
                radius,
                thickness,
                ..
            } => {
                let outer = *radius + *thickness * 0.5;
                min_x = min_x.min(*x - outer);
                max_x = max_x.max(*x + outer);
                min_y = min_y.min(*y - outer);
                max_y = max_y.max(*y + outer);
            }
            Primitive::Thermal {
                x,
                y,
                outer_diameter,
                ..
            } => {
                let radius = *outer_diameter * 0.5;
                min_x = min_x.min(*x - radius);
                max_x = max_x.max(*x + radius);
                min_y = min_y.min(*y - radius);
                max_y = max_y.max(*y + radius);
            }
            Primitive::Line {
                start_x,
                start_y,
                end_x,
                end_y,
                width,
                ..
            } => {
                let radius = *width * 0.5;
                min_x = min_x.min(start_x.min(*end_x) - radius);
                max_x = max_x.max(start_x.max(*end_x) + radius);
                min_y = min_y.min(start_y.min(*end_y) - radius);
                max_y = max_y.max(start_y.max(*end_y) + radius);
            }
            Primitive::TriangleTemplateFlash { template, x, y } => {
                for point in template.chunks_exact(2) {
                    let px = point[0] + *x;
                    let py = point[1] + *y;
                    min_x = min_x.min(px);
                    max_x = max_x.max(px);
                    min_y = min_y.min(py);
                    max_y = max_y.max(py);
                }
            }
        }
    }

    min_x.is_finite().then_some((min_x, max_x, min_y, max_y))
}

/// Parse Aperture definition - %ADD{code}{shape}{params}*%
/// Example: %ADD10C,0.20*% (circle), %ADD20R,0.5X0.3*% (rectangle), %ADD30TESTMACRO*1.5*%
pub fn parse_aperture(
    data: &str,
    apertures: &mut HashMap<String, Aperture>,
    macros: &HashMap<String, ApertureMacro>,
    unit_multiplier: f32,
    collect_metadata: bool,
) {
    // Format: %ADD{code}{shape},{params}*%
    // Remove %ADD and %
    let content = data
        .trim_start_matches('%')
        .trim_start_matches("ADD")
        .trim_end_matches('%');

    // Split code and shape/params by first letter that's not a digit
    let mut code_end = 0;
    for (i, ch) in content.chars().enumerate() {
        if !ch.is_ascii_digit() {
            code_end = i;
            break;
        }
    }

    if code_end == 0 {
        return;
    }

    let code = match content[..code_end].parse::<u32>() {
        Ok(code) => code.to_string(),
        Err(_) => return,
    };
    let rest = &content[code_end..];

    // Split shape and parameters by comma or *
    let shape_and_params: Vec<&str> = rest.split([',', '*']).collect();
    if shape_and_params.is_empty() {
        return;
    }

    let shape = shape_and_params[0].trim().to_string();
    let mut aperture = Aperture::new(0.0);

    // Process basic Aperture formats (C, R, O, P)
    match shape.as_str() {
        "C" => {
            // Circle: %ADD10C,0.20*% or with hole: %ADD10C,0.20X0.10*%
            if shape_and_params.len() > 1 {
                let params: Vec<&str> = shape_and_params[1].split('X').collect();
                if let Ok(diameter) = params[0].trim().parse::<f32>() {
                    let diameter_mm = diameter * unit_multiplier;
                    let hole_diameter_mm = if params.len() > 1 {
                        params[1].trim().parse::<f32>().unwrap_or(0.0) * unit_multiplier
                    } else {
                        0.0
                    };

                    aperture.radius = diameter_mm / 2.0;
                    aperture.is_solid_circle = hole_diameter_mm == 0.0;
                    if collect_metadata {
                        aperture.kind = ApertureKind::Circle;
                        aperture.width = diameter_mm;
                        aperture.height = diameter_mm;
                        aperture.hole_diameter = hole_diameter_mm;
                    }
                    aperture.primitives.push(Primitive::Circle {
                        x: 0.0,
                        y: 0.0,
                        radius: diameter_mm / 2.0,
                        exposure: 1.0,
                        hole_x: 0.0,
                        hole_y: 0.0,
                        hole_radius: hole_diameter_mm / 2.0,
                    });
                }
            }
        }
        "R" => {
            // Rectangle: %ADD20R,0.5X0.3*% or with hole: %ADD20R,0.5X0.3X0.1*%
            if shape_and_params.len() > 1 {
                let params: Vec<&str> = shape_and_params[1].split('X').collect();
                if params.len() >= 2 {
                    if let (Ok(width), Ok(height)) = (
                        params[0].trim().parse::<f32>(),
                        params[1].trim().parse::<f32>(),
                    ) {
                        let width_mm = width * unit_multiplier;
                        let height_mm = height * unit_multiplier;
                        let hole_diameter_mm = if params.len() > 2 {
                            params[2].trim().parse::<f32>().unwrap_or(0.0) * unit_multiplier
                        } else {
                            0.0
                        };

                        aperture.radius = width_mm.max(height_mm) / 2.0;
                        if collect_metadata {
                            aperture.kind = ApertureKind::Rectangle;
                            aperture.width = width_mm;
                            aperture.height = height_mm;
                            aperture.hole_diameter = hole_diameter_mm;
                        }
                        // Split Rectangle into two triangles
                        let half_width = width_mm / 2.0;
                        let half_height = height_mm / 2.0;

                        let v1 = [-half_width, -half_height];
                        let v2 = [half_width, -half_height];
                        let v3 = [half_width, half_height];
                        let v4 = [-half_width, half_height];

                        aperture.primitives.push(Primitive::Triangle {
                            vertices: [v1, v2, v3],
                            exposure: 1.0,
                            hole_x: 0.0,
                            hole_y: 0.0,
                            hole_radius: hole_diameter_mm / 2.0,
                        });
                        aperture.primitives.push(Primitive::Triangle {
                            vertices: [v1, v3, v4],
                            exposure: 1.0,
                            hole_x: 0.0,
                            hole_y: 0.0,
                            hole_radius: hole_diameter_mm / 2.0,
                        });
                    }
                }
            }
        }
        "O" => {
            // Obround (rounded rectangle): %ADD30O,0.5X0.3*% or with hole: %ADD30O,0.5X0.3X0.1*%
            if shape_and_params.len() > 1 {
                let params: Vec<&str> = shape_and_params[1].split('X').collect();
                if params.len() >= 2 {
                    if let (Ok(width), Ok(height)) = (
                        params[0].trim().parse::<f32>(),
                        params[1].trim().parse::<f32>(),
                    ) {
                        let width_mm = width * unit_multiplier;
                        let height_mm = height * unit_multiplier;
                        let hole_diameter_mm = if params.len() > 2 {
                            params[2].trim().parse::<f32>().unwrap_or(0.0) * unit_multiplier
                        } else {
                            0.0
                        };

                        let short_side = width_mm.min(height_mm);
                        let long_side = width_mm.max(height_mm);
                        let radius = short_side / 2.0;

                        aperture.radius = radius;
                        if collect_metadata {
                            aperture.kind = ApertureKind::Obround;
                            aperture.width = width_mm;
                            aperture.height = height_mm;
                            aperture.hole_diameter = hole_diameter_mm;
                        }

                        if width_mm > height_mm {
                            // If width is greater - circles on the left and right, rectangle in the middle
                            let rect_width = long_side - short_side;
                            let half_rect_width = rect_width / 2.0;
                            let half_height = height_mm / 2.0;

                            // Left circle (center: -half_rect_width, 0), hole at aperture center (0, 0)
                            aperture.primitives.push(Primitive::Circle {
                                x: -half_rect_width,
                                y: 0.0,
                                radius,
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });

                            // Right circle (center: half_rect_width, 0), hole at aperture center (0, 0)
                            aperture.primitives.push(Primitive::Circle {
                                x: half_rect_width,
                                y: 0.0,
                                radius,
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });

                            // Central rectangle (2 triangles)
                            let x1 = -half_rect_width;
                            let x2 = half_rect_width;
                            let y1 = -half_height;
                            let y2 = half_height;

                            aperture.primitives.push(Primitive::Triangle {
                                vertices: [[x1, y1], [x2, y1], [x1, y2]],
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });
                            aperture.primitives.push(Primitive::Triangle {
                                vertices: [[x2, y1], [x2, y2], [x1, y2]],
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });
                        } else {
                            // If height is greater - circles on the top and bottom, rectangle in the middle
                            let rect_height = long_side - short_side;
                            let half_rect_height = rect_height / 2.0;
                            let half_width = width_mm / 2.0;

                            // Bottom circle (center: 0, -half_rect_height), hole at aperture center (0, 0)
                            aperture.primitives.push(Primitive::Circle {
                                x: 0.0,
                                y: -half_rect_height,
                                radius,
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });

                            // Top circle (center: 0, half_rect_height), hole at aperture center (0, 0)
                            aperture.primitives.push(Primitive::Circle {
                                x: 0.0,
                                y: half_rect_height,
                                radius,
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });

                            // Central rectangle (2 triangles)
                            let x1 = -half_width;
                            let x2 = half_width;
                            let y1 = -half_rect_height;
                            let y2 = half_rect_height;

                            aperture.primitives.push(Primitive::Triangle {
                                vertices: [[x1, y1], [x2, y1], [x1, y2]],
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });
                            aperture.primitives.push(Primitive::Triangle {
                                vertices: [[x2, y1], [x2, y2], [x1, y2]],
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });
                        }
                    }
                }
            }
        }
        "P" => {
            // Polygon: %ADD40P,0.5X5*% or with rotation: %ADD40P,0.5X5X45.0*% or with hole: %ADD40P,0.5X5X0X0.1*%
            // Parameters: diameter X vertices [X rotation] [X hole_diameter]
            if shape_and_params.len() > 1 {
                let params: Vec<&str> = shape_and_params[1].split('X').collect();
                if params.len() >= 2 {
                    if let (Ok(diameter), Ok(num_vertices)) = (
                        params[0].trim().parse::<f32>(),
                        params[1].trim().parse::<f64>(),
                    ) {
                        if !num_vertices.is_finite()
                            || num_vertices.fract() != 0.0
                            || !(3.0..=12.0).contains(&num_vertices)
                        {
                            return;
                        }
                        let num_vertices = num_vertices as u32;
                        let diameter_mm = diameter * unit_multiplier;

                        // Parse rotation (degrees, defaults to 0)
                        // 3 parameters: rotation (NOT hole!)
                        // 4+ parameters: rotation AND hole
                        let rotation_degrees = if params.len() > 2 {
                            params[2].trim().parse::<f32>().unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        let rotation_radians = rotation_degrees * std::f32::consts::PI / 180.0;

                        // Parse hole (only if 4+ parameters)
                        let hole_diameter_mm = if params.len() > 3 {
                            params[3].trim().parse::<f32>().unwrap_or(0.0) * unit_multiplier
                        } else {
                            0.0
                        };

                        aperture.radius = diameter_mm / 2.0;
                        if collect_metadata {
                            aperture.kind = ApertureKind::Polygon;
                            aperture.width = diameter_mm;
                            aperture.height = diameter_mm;
                            aperture.hole_diameter = hole_diameter_mm;
                            aperture.vertices = num_vertices;
                            aperture.rotation = rotation_radians;
                        }
                        let radius = diameter_mm / 2.0;
                        let angle_step = 2.0 * std::f32::consts::PI / num_vertices as f32;

                        // Fan triangulation with rotation
                        for i in 0..(num_vertices as usize) {
                            let next_i = (i + 1) % (num_vertices as usize);
                            let angle_i = angle_step * i as f32 + rotation_radians;
                            let angle_next = angle_step * next_i as f32 + rotation_radians;

                            let x1 = radius * angle_i.cos();
                            let y1 = radius * angle_i.sin();
                            let x2 = radius * angle_next.cos();
                            let y2 = radius * angle_next.sin();

                            aperture.primitives.push(Primitive::Triangle {
                                vertices: [[0.0, 0.0], [x1, y1], [x2, y2]],
                                exposure: 1.0,
                                hole_x: 0.0,
                                hole_y: 0.0,
                                hole_radius: hole_diameter_mm / 2.0,
                            });
                        }
                    }
                }
            }
        }
        _ => {
            // Macro reference: %ADD30TESTMACRO,1.5*% or %ADD11RoundRect,0.250000X0.600000X...
            // Check if shape is a macro name
            if let Some(macro_def) = macros.get(&shape) {
                // Collect parameters - also handle parameters separated by X
                let mut params = Vec::new();
                for param_str in shape_and_params.iter().skip(1) {
                    let param_str = param_str.trim();
                    if param_str.is_empty() {
                        continue;
                    }

                    // There can be multiple parameters separated by X
                    if param_str.contains('X') {
                        for sub_param in param_str.split('X') {
                            if let Ok(param) = sub_param.trim().parse::<f32>() {
                                params.push(param);
                            }
                        }
                    } else if let Ok(param) = param_str.parse::<f32>() {
                        params.push(param);
                    }
                }

                // Call Macro instantiate
                aperture.primitives = macro_def.instantiate(&params);
                for primitive in &mut aperture.primitives {
                    scale_primitive(primitive, unit_multiplier);
                }
                aperture.radius = 0.0; // For macros, the radius depends on the parameters
                if collect_metadata {
                    aperture.kind = ApertureKind::Macro;
                    aperture.macro_name = Some(shape.clone());
                    if let Some((min_x, max_x, min_y, max_y)) =
                        primitive_bounds(&aperture.primitives)
                    {
                        aperture.width = max_x - min_x;
                        aperture.height = max_y - min_y;
                        aperture.radius = aperture.width.max(aperture.height) / 2.0;
                    }
                }
            }
        }
    }

    // Calculate has_negative based on actual primitives
    aperture.has_negative = aperture.primitives.iter().any(|p| match p {
        Primitive::Circle { exposure, .. } => *exposure < 0.5,
        Primitive::Triangle { exposure, .. } => *exposure < 0.5,
        Primitive::Arc { exposure, .. } => *exposure < 0.5,
        Primitive::Thermal { exposure, .. } => *exposure < 0.5,
        Primitive::Line { exposure, .. } => *exposure < 0.5,
        Primitive::TriangleTemplateFlash { .. } => false,
    });
    aperture.triangle_template = build_triangle_template(&aperture.primitives);

    apertures.insert(code, aperture);
}
