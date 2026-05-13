use crate::parser::{Aperture, FormatSpec, ParserState, Polarity};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use i_triangle::float::triangulatable::Triangulatable;
use std::collections::HashMap;
use std::mem::take;

/// Basic primitive shape - created directly by parser
#[derive(Clone, Debug)]
pub enum Primitive {
    Triangle {
        vertices: [[f32; 2]; 3], // Changed from Vec to fixed array
        exposure: f32,           // 1.0 = positive, 0.0 = negative
        hole_x: f32,             // Hole center X (relative to triangle)
        hole_y: f32,             // Hole center Y (relative to triangle)
        hole_radius: f32,        // Hole radius (0.0 = no hole)
    },
    Circle {
        x: f32,
        y: f32,
        radius: f32,
        exposure: f32,    // 1.0 = positive, 0.0 = negative
        hole_x: f32,      // Hole center X (absolute position)
        hole_y: f32,      // Hole center Y (absolute position)
        hole_radius: f32, // Hole radius (0.0 = no hole)
    },
    Arc {
        x: f32,
        y: f32,
        radius: f32,
        start_angle: f32,
        end_angle: f32,
        thickness: f32,
        exposure: f32, // 1.0 = positive, 0.0 = negative
    },
    Thermal {
        x: f32,
        y: f32,
        outer_diameter: f32,
        inner_diameter: f32,
        gap_thickness: f32,
        rotation: f32,
        exposure: f32, // 1.0 = positive, 0.0 = negative
    },
}

/// Rotate point around given center
#[inline]
pub fn rotate_point(point: &mut [f32; 2], angle: f32, center_x: f32, center_y: f32) {
    let cos_a = angle.cos();
    let sin_a = angle.sin();
    let x = point[0] - center_x;
    let y = point[1] - center_y;
    point[0] = center_x + x * cos_a - y * sin_a;
    point[1] = center_y + x * sin_a + y * cos_a;
}

/// Scale a primitive by a given factor
pub fn scale_primitive(primitive: &mut Primitive, scale: f32) {
    if scale == 1.0 {
        return; // No scaling needed
    }

    match primitive {
        Primitive::Circle {
            x,
            y,
            radius,
            hole_x,
            hole_y,
            hole_radius,
            ..
        } => {
            *x *= scale;
            *y *= scale;
            *radius *= scale;
            *hole_x *= scale;
            *hole_y *= scale;
            *hole_radius *= scale;
        }
        Primitive::Triangle {
            vertices,
            hole_x,
            hole_y,
            hole_radius,
            ..
        } => {
            for vertex in vertices.iter_mut() {
                vertex[0] *= scale;
                vertex[1] *= scale;
            }
            *hole_x *= scale;
            *hole_y *= scale;
            *hole_radius *= scale;
        }
        Primitive::Arc {
            x,
            y,
            radius,
            thickness,
            ..
        } => {
            *x *= scale;
            *y *= scale;
            *radius *= scale;
            *thickness *= scale;
        }
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            ..
        } => {
            *x *= scale;
            *y *= scale;
            *outer_diameter *= scale;
            *inner_diameter *= scale;
            *gap_thickness *= scale;
        }
    }
}

/// Mirror a primitive around its aperture origin.
pub fn mirror_primitive(primitive: &mut Primitive, mirror_x: bool, mirror_y: bool) {
    if !mirror_x && !mirror_y {
        return;
    }

    let mirror_angle = |angle: &mut f32| {
        if mirror_x {
            *angle = std::f32::consts::PI - *angle;
        }
        if mirror_y {
            *angle = -*angle;
        }
    };

    match primitive {
        Primitive::Circle {
            x,
            y,
            hole_x,
            hole_y,
            ..
        } => {
            if mirror_x {
                *x = -*x;
                *hole_x = -*hole_x;
            }
            if mirror_y {
                *y = -*y;
                *hole_y = -*hole_y;
            }
        }
        Primitive::Triangle {
            vertices,
            hole_x,
            hole_y,
            ..
        } => {
            for vertex in vertices.iter_mut() {
                if mirror_x {
                    vertex[0] = -vertex[0];
                }
                if mirror_y {
                    vertex[1] = -vertex[1];
                }
            }
            if mirror_x {
                *hole_x = -*hole_x;
            }
            if mirror_y {
                *hole_y = -*hole_y;
            }
            if mirror_x ^ mirror_y {
                vertices.swap(1, 2);
            }
        }
        Primitive::Arc {
            x,
            y,
            start_angle,
            end_angle,
            ..
        } => {
            if mirror_x {
                *x = -*x;
            }
            if mirror_y {
                *y = -*y;
            }
            mirror_angle(start_angle);
            mirror_angle(end_angle);
        }
        Primitive::Thermal { x, y, rotation, .. } => {
            if mirror_x {
                *x = -*x;
            }
            if mirror_y {
                *y = -*y;
            }
            mirror_angle(rotation);
        }
    }
}

/// Rotate a primitive counterclockwise around its aperture origin.
pub fn rotate_primitive(primitive: &mut Primitive, angle: f32) {
    if angle == 0.0 {
        return;
    }

    let rotate_angle = |primitive_angle: &mut f32| {
        *primitive_angle += angle;
    };

    match primitive {
        Primitive::Circle {
            x,
            y,
            hole_x,
            hole_y,
            ..
        } => {
            let mut center = [*x, *y];
            rotate_point(&mut center, angle, 0.0, 0.0);
            *x = center[0];
            *y = center[1];

            let mut hole = [*hole_x, *hole_y];
            rotate_point(&mut hole, angle, 0.0, 0.0);
            *hole_x = hole[0];
            *hole_y = hole[1];
        }
        Primitive::Triangle {
            vertices,
            hole_x,
            hole_y,
            ..
        } => {
            for vertex in vertices.iter_mut() {
                rotate_point(vertex, angle, 0.0, 0.0);
            }

            let mut hole = [*hole_x, *hole_y];
            rotate_point(&mut hole, angle, 0.0, 0.0);
            *hole_x = hole[0];
            *hole_y = hole[1];
        }
        Primitive::Arc {
            x,
            y,
            start_angle,
            end_angle,
            ..
        } => {
            let mut center = [*x, *y];
            rotate_point(&mut center, angle, 0.0, 0.0);
            *x = center[0];
            *y = center[1];
            rotate_angle(start_angle);
            rotate_angle(end_angle);
        }
        Primitive::Thermal { x, y, rotation, .. } => {
            let mut center = [*x, *y];
            rotate_point(&mut center, angle, 0.0, 0.0);
            *x = center[0];
            *y = center[1];
            rotate_angle(rotation);
        }
    }
}

/// Triangulate outline into triangles
pub fn triangulate_outline(vertices: &[[f32; 2]], exposure: f32) -> Result<Vec<Primitive>, String> {
    if vertices.len() < 3 {
        return Err("Not enough vertices".to_string());
    }

    // Use i_triangle library
    let shape = [vertices.to_vec()];
    let triangulation = shape.triangulate();
    {
        let tri_result = triangulation.to_triangulation::<u32>();
        let mut triangles = Vec::new();

        // Group triangles in sets of 3 to create Primitive::Triangle
        for i in (0..tri_result.indices.len()).step_by(3) {
            if i + 2 < tri_result.indices.len() {
                let i0 = tri_result.indices[i] as usize;
                let i1 = tri_result.indices[i + 1] as usize;
                let i2 = tri_result.indices[i + 2] as usize;

                if i0 < tri_result.points.len()
                    && i1 < tri_result.points.len()
                    && i2 < tri_result.points.len()
                {
                    triangles.push(Primitive::Triangle {
                        vertices: [
                            tri_result.points[i0],
                            tri_result.points[i1],
                            tri_result.points[i2],
                        ],
                        exposure,
                        hole_x: 0.0,
                        hole_y: 0.0,
                        hole_radius: 0.0,
                    });
                }
            }
        }

        Ok(triangles)
    }
}

/// Split line into two triangles (including width)
pub fn line_to_triangles(
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    width: f32,
    exposure: f32,
) -> Vec<Primitive> {
    // Line direction vector
    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let len = (dx * dx + dy * dy).sqrt();

    if len == 0.0 {
        return Vec::new();
    }

    // Perpendicular vector (width direction)
    let half_width = width / 2.0;
    let perp_x = -dy / len * half_width;
    let perp_y = dx / len * half_width;

    // 4 vertices on both sides of the line
    let v1 = [start_x + perp_x, start_y + perp_y];
    let v2 = [start_x - perp_x, start_y - perp_y];
    let v3 = [end_x + perp_x, end_y + perp_y];
    let v4 = [end_x - perp_x, end_y - perp_y];

    // Two triangles: (v1, v2, v3), (v2, v4, v3)
    vec![
        Primitive::Triangle {
            vertices: [v1, v2, v3],
            exposure,
            hole_x: 0.0,
            hole_y: 0.0,
            hole_radius: 0.0,
        },
        Primitive::Triangle {
            vertices: [v2, v4, v3],
            exposure,
            hole_x: 0.0,
            hole_y: 0.0,
            hole_radius: 0.0,
        },
    ]
}

/// Convert a primitive to a polygon (outer boundary as Vec<[f32; 2]>)
pub fn primitive_to_polygon(primitive: &Primitive) -> Vec<[f32; 2]> {
    match primitive {
        Primitive::Circle { x, y, radius, .. } => {
            // 36-sided polygon (10 degree increments)
            let segments = 36;
            let mut vertices = Vec::with_capacity(segments);
            for i in 0..segments {
                let angle = (i as f32) * (2.0 * std::f32::consts::PI / segments as f32);
                vertices.push([x + radius * angle.cos(), y + radius * angle.sin()]);
            }
            vertices
        }

        Primitive::Triangle { vertices, .. } => {
            // Already a polygon
            vertices.to_vec()
        }

        Primitive::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            ..
        } => {
            // Subdivide arc into 10-degree segments
            let start_rad = start_angle.to_radians();
            let end_rad = end_angle.to_radians();
            let mut sweep = end_rad - start_rad;
            if sweep < 0.0 {
                sweep += 2.0 * std::f32::consts::PI;
            }

            let segment_angle = 10.0_f32.to_radians();
            let num_segments = (sweep / segment_angle).ceil() as usize;

            let mut vertices = Vec::with_capacity(num_segments + 1);
            for i in 0..=num_segments {
                let t = (i as f32) / (num_segments as f32);
                let angle = start_rad + sweep * t;
                vertices.push([x + radius * angle.cos(), y + radius * angle.sin()]);
            }
            vertices
        }

        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            ..
        } => {
            // Convert thermal to polygon
            // For now, simplified to outer circle (can be refined later)
            let outer_radius = outer_diameter / 2.0;
            let segments = 36;

            let mut vertices = Vec::with_capacity(segments);
            for i in 0..segments {
                let angle = (i as f32) * (2.0 * std::f32::consts::PI / segments as f32);
                vertices.push([
                    x + outer_radius * angle.cos(),
                    y + outer_radius * angle.sin(),
                ]);
            }
            vertices
        }
    }
}

/// Apply sequential boolean operations to shapes (new version using Shape format)
/// Input: Vec<(Shape, exposure)> where Shape is Vec<Contour> and Contour is Vec<Point>
/// Returns: Vec<Primitive::Triangle> with all triangulated results
pub fn apply_boolean_operations(shapes: &[(Vec<Vec<[f32; 2]>>, f32)]) -> Vec<Primitive> {
    if shapes.is_empty() {
        return Vec::new();
    }

    // Find first positive shape
    let first_positive_idx = shapes.iter().position(|(_, exposure)| *exposure > 0.5);

    let first_idx = match first_positive_idx {
        Some(idx) => idx,
        None => return Vec::new(), // No positive shapes to start with
    };

    // Start with first positive shape
    let mut result_shapes: Vec<Vec<Vec<[f32; 2]>>> = vec![shapes[first_idx].0.clone()];

    // Apply boolean operations sequentially
    for (i, (shape, exposure)) in shapes.iter().enumerate() {
        if i == first_idx {
            continue; // Skip the first shape we already added
        }

        if *exposure > 0.5 {
            // Positive: UNION
            result_shapes =
                result_shapes.overlay(&vec![shape.clone()], OverlayRule::Union, FillRule::NonZero);
        } else {
            // Negative: DIFFERENCE
            result_shapes = result_shapes.overlay(
                &vec![shape.clone()],
                OverlayRule::Difference,
                FillRule::NonZero,
            );
        }

        if result_shapes.is_empty() {
            return Vec::new();
        }
    }

    // Triangulate all result shapes (preserving holes)
    let mut all_primitives = Vec::new();

    for shape in result_shapes {
        // shape is Vec<Contour> where first contour is outer, rest are holes
        if shape.is_empty() {
            continue;
        }

        // Use i_triangle to triangulate shape with holes
        // i_triangle expects: outer boundary + holes
        let triangulated = triangulate_shape_with_holes(&shape, 1.0);

        match triangulated {
            Ok(primitives) => {
                all_primitives.extend(primitives);
            }
            Err(_) => {
                // If triangulation fails, skip this shape
                continue;
            }
        }
    }

    all_primitives
}

/// Triangulate a shape with holes using i_triangle
/// Input: Vec<Contour> where first is outer boundary (CCW), rest are holes (CW)
/// Returns: Vec<Primitive::Triangle>
pub fn triangulate_shape_with_holes(
    contours: &[Vec<[f32; 2]>],
    exposure: f32,
) -> Result<Vec<Primitive>, String> {
    if contours.is_empty() {
        return Ok(Vec::new());
    }

    // Extract outer boundary (first contour)
    let outer = &contours[0];

    if outer.len() < 3 {
        return Err("Outer boundary has less than 3 vertices".to_string());
    }

    // Extract holes (remaining contours)
    let holes: Vec<Vec<[f32; 2]>> = contours[1..].to_vec();

    // Convert to i_triangle format
    // i_triangle expects Vec<Vec<[f32; 2]>> where first is outer, rest are holes
    let mut paths = vec![outer.clone()];
    paths.extend(holes);

    // Use i_triangle for triangulation with holes
    let raw_triangulation = paths.triangulate();
    let tri_result = raw_triangulation.to_triangulation::<u32>();

    // Create triangles from indices
    let mut triangles = Vec::new();
    for i in (0..tri_result.indices.len()).step_by(3) {
        if i + 2 < tri_result.indices.len() {
            let idx0 = tri_result.indices[i] as usize;
            let idx1 = tri_result.indices[i + 1] as usize;
            let idx2 = tri_result.indices[i + 2] as usize;

            if idx0 < tri_result.points.len()
                && idx1 < tri_result.points.len()
                && idx2 < tri_result.points.len()
            {
                triangles.push(Primitive::Triangle {
                    vertices: [
                        tri_result.points[idx0],
                        tri_result.points[idx1],
                        tri_result.points[idx2],
                    ],
                    exposure,
                    hole_x: 0.0,
                    hole_y: 0.0,
                    hole_radius: 0.0,
                });
            }
        }
    }

    Ok(triangles)
}

/// Offset a primitive by the given dx and dy
pub fn offset_primitive_by(primitive: &Primitive, dx: f32, dy: f32) -> Primitive {
    match primitive {
        Primitive::Circle {
            x,
            y,
            radius,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        } => Primitive::Circle {
            x: x + dx,
            y: y + dy,
            radius: *radius,
            exposure: *exposure,
            hole_x: hole_x + dx,
            hole_y: hole_y + dy,
            hole_radius: *hole_radius,
        },
        Primitive::Triangle {
            vertices,
            exposure,
            hole_x,
            hole_y,
            hole_radius,
        } => Primitive::Triangle {
            vertices: [
                [vertices[0][0] + dx, vertices[0][1] + dy],
                [vertices[1][0] + dx, vertices[1][1] + dy],
                [vertices[2][0] + dx, vertices[2][1] + dy],
            ],
            exposure: *exposure,
            hole_x: hole_x + dx,
            hole_y: hole_y + dy,
            hole_radius: *hole_radius,
        },
        Primitive::Arc {
            x,
            y,
            radius,
            start_angle,
            end_angle,
            thickness,
            exposure,
        } => Primitive::Arc {
            x: x + dx,
            y: y + dy,
            radius: *radius,
            start_angle: *start_angle,
            end_angle: *end_angle,
            thickness: *thickness,
            exposure: *exposure,
        },
        Primitive::Thermal {
            x,
            y,
            outer_diameter,
            inner_diameter,
            gap_thickness,
            rotation,
            exposure,
        } => Primitive::Thermal {
            x: x + dx,
            y: y + dy,
            outer_diameter: *outer_diameter,
            inner_diameter: *inner_diameter,
            gap_thickness: *gap_thickness,
            rotation: *rotation,
            exposure: *exposure,
        },
    }
}

/// Extracts the numeric value after a specific character in a string (e.g., "X1000" → "1000")
pub fn extract_value(line: &str, key: char) -> Option<String> {
    let key_str = key.to_string();
    if let Some(pos) = line.find(&key_str) {
        let rest = &line[pos + 1..];
        let mut value = String::new();
        let mut has_minus = false;

        for ch in rest.chars() {
            if ch == '-' || ch == '+' {
                has_minus = ch == '-';
            } else if ch.is_ascii_digit() {
                if has_minus && value.is_empty() {
                    value.push('-');
                }
                value.push(ch);
            } else {
                break;
            }
        }

        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    } else {
        None
    }
}

/// Coordinate value conversion - decimal point processing according to format spec
pub fn convert_coordinate(
    coord_str: &str,
    axis: char,
    format_spec: &FormatSpec,
    unit_multiplier: f32,
) -> f32 {
    if let Ok(val) = coord_str.parse::<i64>() {
        let divisor = match axis {
            'x' => format_spec.x_divisor,
            'y' => format_spec.y_divisor,
            _ => 10000.0,
        };

        // Check for division by zero
        if divisor == 0.0 || !divisor.is_finite() {
            return 0.0;
        }

        // Divide by decimal point position (no padding) and then convert units (1.0 for mm, 25.4 for inch)
        let result = (val as f64 / divisor) as f32 * unit_multiplier;

        // Check for numeric overflow
        if !result.is_finite() {
            return 0.0;
        }

        result
    } else {
        0.0
    }
}

/// Flash aperture at given position without Step and Repeat
fn flash_aperture_no_sr(
    aperture: &Aperture,
    primitives: &mut Vec<Primitive>,
    x: f32,
    y: f32,
    layer_scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    layer_rotation: f32,
) {
    // Use pre-calculated has_negative field for performance
    if aperture.has_negative {
        // Boolean operations with hole preservation
        // Convert offset primitives to shapes
        let shapes_with_exposure: Vec<(Vec<Vec<[f32; 2]>>, f32)> = aperture
            .primitives
            .iter()
            .map(|p| {
                let mut scaled_primitive = p.clone();
                scale_primitive(&mut scaled_primitive, layer_scale);
                mirror_primitive(&mut scaled_primitive, mirror_x, mirror_y);
                rotate_primitive(&mut scaled_primitive, layer_rotation);
                let offset_p = offset_primitive_by(&scaled_primitive, x, y);
                let poly = primitive_to_polygon(&offset_p);
                let exposure = match &offset_p {
                    Primitive::Circle { exposure, .. } => *exposure,
                    Primitive::Triangle { exposure, .. } => *exposure,
                    Primitive::Arc { exposure, .. } => *exposure,
                    Primitive::Thermal { exposure, .. } => *exposure,
                };
                // Wrap polygon in shape format (single contour)
                (vec![poly], exposure)
            })
            .collect();

        // Apply boolean operations with hole preservation
        let result_primitives = apply_boolean_operations(&shapes_with_exposure);
        primitives.extend(result_primitives);
    } else {
        // Direct primitive cloning
        for primitive in &aperture.primitives {
            let mut new_primitive = primitive.clone();
            scale_primitive(&mut new_primitive, layer_scale);
            mirror_primitive(&mut new_primitive, mirror_x, mirror_y);
            rotate_primitive(&mut new_primitive, layer_rotation);
            match &mut new_primitive {
                Primitive::Circle {
                    x: px,
                    y: py,
                    hole_x: hx,
                    hole_y: hy,
                    ..
                } => {
                    *px += x;
                    *py += y;
                    *hx += x;
                    *hy += y;
                }
                Primitive::Triangle {
                    vertices,
                    hole_x,
                    hole_y,
                    ..
                } => {
                    for vertex in vertices.iter_mut() {
                        vertex[0] += x;
                        vertex[1] += y;
                    }
                    *hole_x += x;
                    *hole_y += y;
                }
                Primitive::Arc { x: ax, y: ay, .. } => {
                    *ax += x;
                    *ay += y;
                }
                Primitive::Thermal { x: tx, y: ty, .. } => {
                    *tx += x;
                    *ty += y;
                }
            }
            primitives.push(new_primitive);
        }
    }
}

fn transform_primitive_for_flash(
    primitive: &Primitive,
    x: f32,
    y: f32,
    layer_scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    layer_rotation: f32,
) -> Primitive {
    let mut transformed = primitive.clone();
    scale_primitive(&mut transformed, layer_scale);
    mirror_primitive(&mut transformed, mirror_x, mirror_y);
    rotate_primitive(&mut transformed, layer_rotation);
    offset_primitive_by(&transformed, x, y)
}

fn flush_primitives_to_layer(
    primitives: &mut Vec<Primitive>,
    polarity: Polarity,
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
) {
    if !primitives.is_empty() {
        polarity_layers.push((polarity, take(primitives)));
    }
}

fn toggled_block_polarity(block_polarity: Polarity, flash_polarity: Polarity) -> Polarity {
    if flash_polarity == Polarity::Negative {
        match block_polarity {
            Polarity::Positive => Polarity::Negative,
            Polarity::Negative => Polarity::Positive,
        }
    } else {
        block_polarity
    }
}

fn flash_block_aperture(
    block_layers: &[(Polarity, Vec<Primitive>)],
    state: &ParserState,
    primitives: &mut Vec<Primitive>,
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
    x: f32,
    y: f32,
) {
    flush_primitives_to_layer(primitives, state.polarity, polarity_layers);

    for sy in 0..state.sr_y {
        for sx in 0..state.sr_x {
            let flash_x = x + sx as f32 * state.sr_i;
            let flash_y = y + sy as f32 * state.sr_j;

            for (block_polarity, block_primitives) in block_layers {
                let transformed: Vec<Primitive> = block_primitives
                    .iter()
                    .map(|primitive| {
                        transform_primitive_for_flash(
                            primitive,
                            flash_x,
                            flash_y,
                            state.layer_scale,
                            state.mirror_x,
                            state.mirror_y,
                            state.layer_rotation,
                        )
                    })
                    .collect();

                if !transformed.is_empty() {
                    polarity_layers.push((
                        toggled_block_polarity(*block_polarity, state.polarity),
                        transformed,
                    ));
                }
            }
        }
    }
}

/// Flash aperture at given position - add all primitives of the aperture to the position
pub fn flash_aperture(
    state: &ParserState,
    apertures: &HashMap<String, Aperture>,
    primitives: &mut Vec<Primitive>,
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
    x: f32,
    y: f32,
) {
    if let Some(aperture) = apertures.get(&state.current_aperture) {
        if let Some(block_layers) = aperture.block_layers.as_ref() {
            flash_block_aperture(block_layers, state, primitives, polarity_layers, x, y);
            return;
        }

        // Step and Repeat iteration
        for sy in 0..state.sr_y {
            for sx in 0..state.sr_x {
                let flash_x = x + sx as f32 * state.sr_i;
                let flash_y = y + sy as f32 * state.sr_j;
                flash_aperture_no_sr(
                    aperture,
                    primitives,
                    flash_x,
                    flash_y,
                    state.layer_scale,
                    state.mirror_x,
                    state.mirror_y,
                    state.layer_rotation,
                );
            }
        }
    }
}

/// Execute interpolation (draw line or arc)
pub fn execute_interpolation(
    state: &mut ParserState,
    apertures: &HashMap<String, Aperture>,
    primitives: &mut Vec<Primitive>,
    end_x: f32,
    end_y: f32,
    i: f32,
    j: f32,
) {
    let start_x = state.x;
    let start_y = state.y;

    // Get current aperture
    if let Some(_aperture) = apertures.get(&state.current_aperture) {
        match state.interpolation_mode.as_str() {
            "linear" | "linear_x10" | "linear_x01" | "linear_x001" => {
                // Draw line with Step and Repeat
                if let Some(aperture) = apertures.get(&state.current_aperture) {
                    for sy in 0..state.sr_y {
                        for sx in 0..state.sr_x {
                            let offset_x = sx as f32 * state.sr_i;
                            let offset_y = sy as f32 * state.sr_j;
                            let sr_start_x = start_x + offset_x;
                            let sr_start_y = start_y + offset_y;
                            let sr_end_x = end_x + offset_x;
                            let sr_end_y = end_y + offset_y;

                            // Flash aperture at start point (no SR since we're already in SR loop)
                            flash_aperture_no_sr(
                                aperture,
                                primitives,
                                sr_start_x,
                                sr_start_y,
                                state.layer_scale,
                                state.mirror_x,
                                state.mirror_y,
                                state.layer_rotation,
                            );

                            // Convert vector line with width of aperture diameter to triangle
                            let diameter = aperture.radius * 2.0 * state.layer_scale;
                            let line_triangles = line_to_triangles(
                                sr_start_x, sr_start_y, sr_end_x, sr_end_y, diameter, 1.0,
                            );
                            for triangle in line_triangles {
                                primitives.push(triangle);
                            }

                            // Flash aperture at end point (no SR since we're already in SR loop)
                            flash_aperture_no_sr(
                                aperture,
                                primitives,
                                sr_end_x,
                                sr_end_y,
                                state.layer_scale,
                                state.mirror_x,
                                state.mirror_y,
                                state.layer_rotation,
                            );
                        }
                    }
                }
            }
            "clockwise" | "counterclockwise" => {
                // Draw arc with Step and Repeat
                if let Some(aperture) = apertures.get(&state.current_aperture) {
                    for sy in 0..state.sr_y {
                        for sx in 0..state.sr_x {
                            let offset_x = sx as f32 * state.sr_i;
                            let offset_y = sy as f32 * state.sr_j;
                            let sr_start_x = start_x + offset_x;
                            let sr_start_y = start_y + offset_y;
                            let sr_end_x = end_x + offset_x;
                            let sr_end_y = end_y + offset_y;

                            // Flash aperture at start point (no SR since we're already in SR loop)
                            flash_aperture_no_sr(
                                aperture,
                                primitives,
                                sr_start_x,
                                sr_start_y,
                                state.layer_scale,
                                state.mirror_x,
                                state.mirror_y,
                                state.layer_rotation,
                            );

                            if let Some((center_x, center_y, radius, start_angle, sweep_angle)) =
                                calculate_arc_parameters(
                                    state, sr_start_x, sr_start_y, sr_end_x, sr_end_y, i, j,
                                )
                            {
                                let thickness = aperture.radius * 2.0 * state.layer_scale;

                                // Add Arc primitive
                                primitives.push(Primitive::Arc {
                                    x: center_x,
                                    y: center_y,
                                    radius,
                                    start_angle,
                                    end_angle: start_angle + sweep_angle,
                                    thickness,
                                    exposure: 1.0,
                                });
                            }

                            // Flash aperture at end point (no SR since we're already in SR loop)
                            flash_aperture_no_sr(
                                aperture,
                                primitives,
                                sr_end_x,
                                sr_end_y,
                                state.layer_scale,
                                state.mirror_x,
                                state.mirror_y,
                                state.layer_rotation,
                            );
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn calculate_arc_parameters(
    state: &ParserState,
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    i: f32,
    j: f32,
) -> Option<(f32, f32, f32, f32, f32)> {
    let is_clockwise = state.interpolation_mode == "clockwise";
    if !is_clockwise && state.interpolation_mode != "counterclockwise" {
        return None;
    }

    let (center_x, center_y) = if state.quadrant_mode == "single" {
        // Single-quadrant mode: find correct center from 4 candidates (+/-I, +/-J).
        let candidates = [
            (start_x + i, start_y + j),
            (start_x - i, start_y + j),
            (start_x + i, start_y - j),
            (start_x - i, start_y - j),
        ];

        let mut selected = candidates[0];

        for &candidate in &candidates {
            let cx = candidate.0;
            let cy = candidate.1;
            let r1 = ((cx - start_x).powi(2) + (cy - start_y).powi(2)).sqrt();
            let r2 = ((cx - end_x).powi(2) + (cy - end_y).powi(2)).sqrt();

            if (r1 - r2).abs() < 0.001 {
                let start_angle = (start_y - cy).atan2(start_x - cx);
                let end_angle = (end_y - cy).atan2(end_x - cx);
                let sweep_angle = normalize_arc_sweep(
                    start_angle,
                    end_angle,
                    is_clockwise,
                    points_coincide(start_x, start_y, end_x, end_y),
                );

                if sweep_angle.abs() <= std::f32::consts::PI / 2.0 + 0.001 {
                    selected = candidate;
                    break;
                }
            }
        }

        selected
    } else {
        // Multi-quadrant mode: I/J directly specify the center offset.
        (start_x + i, start_y + j)
    };

    let radius = ((start_x - center_x).powi(2) + (start_y - center_y).powi(2)).sqrt();
    if radius <= f32::EPSILON || !radius.is_finite() {
        return None;
    }

    let start_angle = (start_y - center_y).atan2(start_x - center_x);
    let end_angle = (end_y - center_y).atan2(end_x - center_x);
    let mut sweep_angle = normalize_arc_sweep(
        start_angle,
        end_angle,
        is_clockwise,
        points_coincide(start_x, start_y, end_x, end_y),
    );

    // Single-quadrant arcs cannot exceed 90 degrees. Keep legacy tolerance behavior.
    if state.quadrant_mode == "single"
        && !points_coincide(start_x, start_y, end_x, end_y)
        && sweep_angle.abs() > std::f32::consts::PI / 2.0 + 0.001
    {
        sweep_angle = if is_clockwise {
            -std::f32::consts::PI / 2.0
        } else {
            std::f32::consts::PI / 2.0
        };
    }

    Some((center_x, center_y, radius, start_angle, sweep_angle))
}

fn normalize_arc_sweep(
    start_angle: f32,
    end_angle: f32,
    is_clockwise: bool,
    full_circle: bool,
) -> f32 {
    if full_circle {
        return if is_clockwise {
            -2.0 * std::f32::consts::PI
        } else {
            2.0 * std::f32::consts::PI
        };
    }

    let mut sweep_angle = end_angle - start_angle;
    if is_clockwise && sweep_angle >= 0.0 {
        sweep_angle -= 2.0 * std::f32::consts::PI;
    } else if !is_clockwise && sweep_angle <= 0.0 {
        sweep_angle += 2.0 * std::f32::consts::PI;
    }
    sweep_angle
}

fn points_coincide(start_x: f32, start_y: f32, end_x: f32, end_y: f32) -> bool {
    (start_x - end_x).abs() < 0.0001 && (start_y - end_y).abs() < 0.0001
}

fn append_region_segment(
    contour: &mut Vec<[f32; 2]>,
    state: &ParserState,
    end_x: f32,
    end_y: f32,
    i: f32,
    j: f32,
) {
    if state.interpolation_mode != "clockwise" && state.interpolation_mode != "counterclockwise" {
        contour.push([end_x, end_y]);
        return;
    }

    let start_x = state.x;
    let start_y = state.y;
    if contour.is_empty() {
        contour.push([start_x, start_y]);
    }

    if let Some((center_x, center_y, radius, start_angle, sweep_angle)) =
        calculate_arc_parameters(state, start_x, start_y, end_x, end_y, i, j)
    {
        let max_angle_step = std::f32::consts::PI / 36.0;
        let segment_count = ((sweep_angle.abs() / max_angle_step).ceil() as usize).clamp(1, 512);

        for segment_idx in 1..segment_count {
            let t = segment_idx as f32 / segment_count as f32;
            let angle = start_angle + sweep_angle * t;
            contour.push([
                center_x + radius * angle.cos(),
                center_y + radius * angle.sin(),
            ]);
        }
    }

    contour.push([end_x, end_y]);
}

/// Parse graphic commands - process G/D/XY codes
/// Example: G01X1000Y2000D01* (draw line), X1000Y2000D03* (flash), etc.
pub fn parse_graphic_command(
    line: &str,
    state: &mut ParserState,
    apertures: &HashMap<String, Aperture>,
    primitives: &mut Vec<Primitive>,
    region_contours: &mut Vec<Vec<[f32; 2]>>,
    polarity_layers: &mut Vec<(Polarity, Vec<Primitive>)>,
) {
    let clean_line = line.trim_end_matches('*');

    // Process G-code
    if let Some(g_match) = extract_value(clean_line, 'G') {
        if let Ok(g_code) = g_match.parse::<u32>() {
            match g_code {
                1 => {
                    // G01: Linear interpolation (1x scale)
                    state.interpolation_mode = "linear".to_string();
                    state.scale = 1.0;
                }
                2 => {
                    // G02: Clockwise arc interpolation
                    state.interpolation_mode = "clockwise".to_string();
                }
                3 => {
                    // G03: Counterclockwise arc interpolation
                    state.interpolation_mode = "counterclockwise".to_string();
                }
                10 => {
                    // G10: Linear interpolation (10x scale)
                    state.interpolation_mode = "linear_x10".to_string();
                    state.scale = 10.0;
                }
                11 => {
                    // G11: Linear interpolation (0.1x scale)
                    state.interpolation_mode = "linear_x01".to_string();
                    state.scale = 0.1;
                }
                12 => {
                    // G12: Linear interpolation (0.01x scale)
                    state.interpolation_mode = "linear_x001".to_string();
                    state.scale = 0.01;
                }
                36 => {
                    // G36: Start region fill mode
                    state.region_mode = true;
                    region_contours.clear();
                    region_contours.push(Vec::new()); // Start new contour
                }
                37 => {
                    // G37: End region fill mode
                    state.region_mode = false;

                    // Triangulate region and add to primitives with Step and Repeat
                    // Regions are always positive (add material)
                    for contour in region_contours.iter() {
                        if contour.len() >= 3 {
                            match triangulate_outline(contour, 1.0) {
                                Ok(triangles) => {
                                    // Apply Step and Repeat to region triangles
                                    for sy in 0..state.sr_y {
                                        for sx in 0..state.sr_x {
                                            let offset_x = sx as f32 * state.sr_i;
                                            let offset_y = sy as f32 * state.sr_j;

                                            for triangle in &triangles {
                                                let offset_triangle = offset_primitive_by(
                                                    triangle, offset_x, offset_y,
                                                );
                                                primitives.push(offset_triangle);
                                            }
                                        }
                                    }
                                }
                                Err(_e) => {
                                    // Triangulation failed, skip this contour
                                }
                            }
                        }
                    }

                    region_contours.clear();
                }
                70 => {
                    // G70: Unit mode - Inches
                    state.unit_multiplier = 25.4;
                }
                71 => {
                    // G71: Unit mode - Millimeters
                    state.unit_multiplier = 1.0;
                }
                74 => {
                    // G74: Single quadrant mode
                    state.quadrant_mode = "single".to_string();
                }
                75 => {
                    // G75: Multi-quadrant mode
                    state.quadrant_mode = "multi".to_string();
                }
                90 => {
                    // G90: Absolute coordinate mode
                    state.coordinate_mode = "absolute".to_string();
                }
                91 => {
                    // G91: Incremental coordinate mode
                    state.coordinate_mode = "incremental".to_string();
                }
                _ => {
                    // Unsupported G-code
                }
            }
        }
    }

    // Extract coordinates and D-code using regex
    let x_match = extract_value(clean_line, 'X');
    let y_match = extract_value(clean_line, 'Y');
    let i_match = extract_value(clean_line, 'I');
    let j_match = extract_value(clean_line, 'J');
    let d_match = extract_value(clean_line, 'D');

    let mut x = state.x;
    let mut y = state.y;
    let mut i = 0.0;
    let mut j = 0.0;

    // Process X coordinate
    if let Some(x_val) = x_match.as_ref() {
        let new_x =
            convert_coordinate(x_val, 'x', &state.format_spec, state.unit_multiplier) * state.scale;
        x = if state.coordinate_mode == "absolute" {
            new_x
        } else {
            state.x + new_x
        };
    }

    // Process Y coordinate
    if let Some(y_val) = y_match.as_ref() {
        let new_y =
            convert_coordinate(y_val, 'y', &state.format_spec, state.unit_multiplier) * state.scale;
        y = if state.coordinate_mode == "absolute" {
            new_y
        } else {
            state.y + new_y
        };
    }

    // Process I coordinate (arc center X offset)
    if let Some(i_val) = i_match.as_ref() {
        let raw_i =
            convert_coordinate(i_val, 'x', &state.format_spec, state.unit_multiplier) * state.scale;
        i = if state.quadrant_mode == "single" {
            raw_i.abs()
        } else {
            raw_i
        };
    }

    // Process J coordinate (arc center Y offset)
    if let Some(j_val) = j_match.as_ref() {
        let raw_j =
            convert_coordinate(j_val, 'y', &state.format_spec, state.unit_multiplier) * state.scale;
        j = if state.quadrant_mode == "single" {
            raw_j.abs()
        } else {
            raw_j
        };
    }

    // Process D-code
    if let Some(d_val) = d_match {
        if let Ok(d_code) = d_val.parse::<u32>() {
            match d_code {
                1 => {
                    // D01: Pen down (draw)
                    state.pen_state = "down".to_string();

                    // If in region mode, add coordinates to contour
                    if state.region_mode {
                        if let Some(last_contour) = region_contours.last_mut() {
                            append_region_segment(last_contour, state, x, y, i, j);
                        }
                    } else {
                        execute_interpolation(state, apertures, primitives, x, y, i, j);
                    }
                }
                2 => {
                    // D02: Pen up (move)
                    state.pen_state = "up".to_string();

                    // Movement is also handled in Region mode
                    if state.region_mode {
                        // D02 starts a new contour and is the first vertex of it.
                        if region_contours
                            .last()
                            .is_none_or(|last_contour| !last_contour.is_empty())
                        {
                            region_contours.push(Vec::new());
                        }

                        if let Some(last_contour) = region_contours.last_mut() {
                            last_contour.push([x, y]);
                        }
                    }
                }
                3 if !state.region_mode => {
                    // D03: Flash aperture at current position
                    flash_aperture(state, apertures, primitives, polarity_layers, x, y);
                }
                _ if d_code >= 10 => {
                    // D10+: Aperture selection
                    state.current_aperture = d_code.to_string();
                }
                _ => {}
            }
        }
    } else if (x_match.is_some() || y_match.is_some()) && state.pen_state == "down" {
        // If there is only X/Y without D-code and the pen is down, execute interpolation
        if state.region_mode {
            if let Some(last_contour) = region_contours.last_mut() {
                append_region_segment(last_contour, state, x, y, i, j);
            }
        } else {
            execute_interpolation(state, apertures, primitives, x, y, i, j);
        }
    } else {
        // No drawing operation
    }

    // Update state
    state.x = x;
    state.y = y;
    state.i = i;
    state.j = j;
}
