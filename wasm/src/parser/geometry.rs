use crate::geometry::{Boundary, PathRegions, PATH_SECTOR_VERTEX_FLOATS};
use crate::geometry::{RegionContour, RegionSegment};
use crate::interaction::{
    aperture_name, aperture_type, feature_from_primitive_delta, FeatureKind, FeatureProperties,
    InteractionFeature, InteractionLayer, PathRegionRef,
};
use crate::parser::common::{parse_coordinate_number, parse_g_code, read_word_value};
use crate::parser::{Aperture, FormatSpec, ParserState, Polarity, PolarityLayer};
use crate::util::{format_bytes, format_count};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use i_triangle::float::triangulatable::Triangulatable;
use std::collections::HashMap;
use std::mem::size_of;
use std::mem::take;
use std::rc::Rc;

const MAX_GENERATED_ITEMS_PER_COMMAND: usize = 5_000_000;
const PATH_WEDGE_VERTEX_FLOATS: usize = 6;
const PATH_COVER_VERTEX_FLOATS: usize = 12;
const PATH_SECTOR_QUAD_VERTICES: usize = 6;

fn format_primitive_allocation(additional: usize) -> String {
    let primitives = format_count(additional);
    match additional.checked_mul(size_of::<Primitive>()) {
        Some(bytes) => format!("{} primitives, {}", primitives, format_bytes(bytes)),
        None => format!("{} primitives", primitives),
    }
}

fn checked_primitive_count(
    count: usize,
    multiplier: usize,
    context: &str,
) -> Result<usize, String> {
    count.checked_mul(multiplier).ok_or_else(|| {
        format!(
            "Gerber layer is too large to parse: {} primitive count overflow",
            context
        )
    })
}

fn consume_expansion(
    state: &ParserState,
    count: usize,
    multiplier: usize,
    context: &str,
) -> Result<usize, String> {
    let total = checked_primitive_count(count, multiplier, context)?;
    if total > MAX_GENERATED_ITEMS_PER_COMMAND {
        return Err(format!(
            "Gerber {context} expands to {total} items, exceeding the per-command limit of {MAX_GENERATED_ITEMS_PER_COMMAND}"
        ));
    }
    state.consume_generated_items(total, context)?;
    Ok(total)
}

fn aperture_flash_work_items(aperture: &Aperture) -> Result<usize, String> {
    if aperture.triangle_template.is_some() && !aperture.has_negative {
        return Ok(1);
    }

    let count = aperture.primitives.len().max(1);
    if aperture.has_negative {
        checked_primitive_count(count, 64, "negative aperture flash")
    } else {
        Ok(count)
    }
}

fn block_flash_work_items(block_layers: &[PolarityLayer]) -> Result<usize, String> {
    block_layers.iter().try_fold(0usize, |total, layer| {
        let layer_items = layer
            .primitives
            .len()
            .checked_add(layer.path_regions.work_item_count())
            .ok_or_else(|| "Gerber aperture block work item count overflow".to_string())?
            .max(1);
        total
            .checked_add(layer_items)
            .ok_or_else(|| "Gerber aperture block work item count overflow".to_string())
    })
}

fn checked_work_item_sum(total: usize, additional: usize, context: &str) -> Result<usize, String> {
    total
        .checked_add(additional)
        .ok_or_else(|| format!("Gerber {context} work item count overflow"))
}

fn region_source_work_items(region_contours: &[RegionContour]) -> Result<usize, String> {
    region_contours.iter().try_fold(0usize, |total, contour| {
        let contour_items = contour
            .points
            .len()
            .checked_add(contour.segments.len())
            .ok_or_else(|| "Gerber region source work item count overflow".to_string())?;
        checked_work_item_sum(total, contour_items, "region source")
    })
}

fn flattened_contour_point_count(
    contour: &RegionContour,
    arc_tessellation_quality: u32,
) -> Result<usize, String> {
    if contour.segments.is_empty() {
        return Ok(contour.points.len());
    }

    let mut count = 0usize;
    for segment in &contour.segments {
        if count == 0 {
            count = 1;
        }
        let additional = match *segment {
            RegionSegment::Line { .. } => 1,
            RegionSegment::Arc {
                start,
                end,
                center,
                radius,
                start_angle,
                sweep_angle,
                clamp_sweep,
            } => {
                let arc = canonical_arc_geometry(
                    start,
                    end,
                    center,
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                );
                let max_angle_step =
                    region_arc_tessellation_max_angle_step(arc_tessellation_quality);
                ((arc.sweep_angle.abs() / max_angle_step).ceil() as usize).clamp(1, 512)
            }
        };
        count = checked_work_item_sum(count, additional, "region pick contour")?;
    }
    Ok(count)
}

fn path_region_work_items_per_copy(
    region_contours: &[RegionContour],
    arc_tessellation_quality: u32,
    collect_pick_contours: bool,
    collect_source_contours: bool,
) -> Result<usize, String> {
    if path_region_bounds(region_contours, 0.0, 0.0).is_none() {
        return Ok(1);
    }

    let mut total = PATH_COVER_VERTEX_FLOATS
        .checked_mul(2)
        .ok_or_else(|| "Gerber path region work item count overflow".to_string())?;
    let flatten_pick_contours = region_contours_have_arcs(region_contours);

    for contour in region_contours {
        for segment in &contour.segments {
            let segment_items = match *segment {
                RegionSegment::Line { .. } => PATH_WEDGE_VERTEX_FLOATS,
                RegionSegment::Arc {
                    start,
                    end,
                    center,
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                } => {
                    let arc = canonical_arc_geometry(
                        start,
                        end,
                        center,
                        radius,
                        start_angle,
                        sweep_angle,
                        clamp_sweep,
                    );
                    let sweep = arc
                        .sweep_angle
                        .clamp(-std::f32::consts::TAU, std::f32::consts::TAU);
                    let chunk_count =
                        ((sweep.abs() / std::f32::consts::FRAC_PI_2).ceil() as usize).max(1);
                    let items_per_chunk = PATH_WEDGE_VERTEX_FLOATS
                        .checked_add(
                            PATH_SECTOR_QUAD_VERTICES
                                .checked_mul(PATH_SECTOR_VERTEX_FLOATS)
                                .ok_or_else(|| {
                                    "Gerber path region work item count overflow".to_string()
                                })?,
                        )
                        .ok_or_else(|| "Gerber path region work item count overflow".to_string())?;
                    checked_primitive_count(chunk_count, items_per_chunk, "path region arc")?
                }
            };
            total = checked_work_item_sum(total, segment_items, "path region")?;
        }

        if let (Some(first), Some(last)) = (contour.points.first(), contour.points.last()) {
            if !points_coincide(first[0], first[1], last[0], last[1]) {
                total =
                    checked_work_item_sum(total, PATH_WEDGE_VERTEX_FLOATS, "path region closure")?;
            }
        }

        if collect_pick_contours {
            let pick_points = if flatten_pick_contours {
                flattened_contour_point_count(contour, arc_tessellation_quality)?
            } else {
                contour.points.len()
            };
            if pick_points >= 3 {
                total = checked_work_item_sum(total, pick_points, "region pick contour")?;
            }
        }
    }

    if collect_source_contours {
        total = checked_work_item_sum(
            total,
            region_source_work_items(region_contours)?,
            "region source",
        )?;
    }

    Ok(total.max(1))
}

fn try_reserve_primitives(
    primitives: &mut Vec<Primitive>,
    additional: usize,
    context: &str,
) -> Result<(), String> {
    primitives.try_reserve(additional).map_err(|_| {
        format!(
            "Gerber layer is too large to parse: not enough memory for {} ({})",
            context,
            format_primitive_allocation(additional)
        )
    })
}

fn try_reserve_layers(
    polarity_layers: &mut Vec<PolarityLayer>,
    additional: usize,
    context: &str,
) -> Result<(), String> {
    polarity_layers.try_reserve(additional).map_err(|_| {
        format!(
            "Gerber layer is too large to parse: not enough memory for {} ({} polarity layers)",
            context,
            format_count(additional)
        )
    })
}

fn try_reserve_values<T>(
    values: &mut Vec<T>,
    additional: usize,
    context: &str,
) -> Result<(), String> {
    values.try_reserve(additional).map_err(|_| {
        format!(
            "Gerber region is too large to render: not enough memory for {} ({} values)",
            context,
            format_count(additional)
        )
    })
}

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
    TriangleTemplateFlash {
        template: Rc<Vec<f32>>,
        x: f32,
        y: f32,
    },
    Line {
        start_x: f32,
        start_y: f32,
        end_x: f32,
        end_y: f32,
        width: f32,
        exposure: f32,
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
        Primitive::TriangleTemplateFlash { template, x, y } => {
            for value in Rc::make_mut(template).iter_mut() {
                *value *= scale;
            }
            *x *= scale;
            *y *= scale;
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            ..
        } => {
            *start_x *= scale;
            *start_y *= scale;
            *end_x *= scale;
            *end_y *= scale;
            *width *= scale;
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
        Primitive::TriangleTemplateFlash { template, x, y } => {
            let vertices = Rc::make_mut(template);
            for point in vertices.chunks_exact_mut(2) {
                if mirror_x {
                    point[0] = -point[0];
                }
                if mirror_y {
                    point[1] = -point[1];
                }
            }
            if mirror_x {
                *x = -*x;
            }
            if mirror_y {
                *y = -*y;
            }
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            ..
        } => {
            if mirror_x {
                *start_x = -*start_x;
                *end_x = -*end_x;
            }
            if mirror_y {
                *start_y = -*start_y;
                *end_y = -*end_y;
            }
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
        Primitive::TriangleTemplateFlash { template, x, y } => {
            let vertices = Rc::make_mut(template);
            for point in vertices.chunks_exact_mut(2) {
                let mut vertex = [point[0], point[1]];
                rotate_point(&mut vertex, angle, 0.0, 0.0);
                point[0] = vertex[0];
                point[1] = vertex[1];
            }
            let mut center = [*x, *y];
            rotate_point(&mut center, angle, 0.0, 0.0);
            *x = center[0];
            *y = center[1];
        }
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            ..
        } => {
            let mut start = [*start_x, *start_y];
            let mut end = [*end_x, *end_y];
            rotate_point(&mut start, angle, 0.0, 0.0);
            rotate_point(&mut end, angle, 0.0, 0.0);
            *start_x = start[0];
            *start_y = start[1];
            *end_x = end[0];
            *end_y = end[1];
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

/// Store a stroked straight line body for instanced rendering.
pub fn line_to_body(
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    width: f32,
    exposure: f32,
) -> Option<Primitive> {
    if !width.is_finite() || width < 0.0 || points_coincide(start_x, start_y, end_x, end_y) {
        return None;
    }

    Some(Primitive::Line {
        start_x,
        start_y,
        end_x,
        end_y,
        width,
        exposure,
    })
}

/// Split a macro line primitive into two triangles.
pub fn line_to_triangles(
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    width: f32,
    exposure: f32,
) -> Vec<Primitive> {
    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let len = (dx * dx + dy * dy).sqrt();

    if len == 0.0 {
        return Vec::new();
    }

    let half_width = width / 2.0;
    let perp_x = -dy / len * half_width;
    let perp_y = dx / len * half_width;

    let v1 = [start_x + perp_x, start_y + perp_y];
    let v2 = [start_x - perp_x, start_y - perp_y];
    let v3 = [end_x + perp_x, end_y + perp_y];
    let v4 = [end_x - perp_x, end_y - perp_y];

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
        Primitive::TriangleTemplateFlash { template, x, y } => template
            .chunks_exact(2)
            .map(|point| [point[0] + *x, point[1] + *y])
            .collect(),
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            ..
        } => {
            let dx = end_x - start_x;
            let dy = end_y - start_y;
            let len = (dx * dx + dy * dy).sqrt();
            if len <= f32::EPSILON {
                return Vec::new();
            }
            let half_width = width * 0.5;
            let perp_x = -dy / len * half_width;
            let perp_y = dx / len * half_width;
            vec![
                [start_x + perp_x, start_y + perp_y],
                [end_x + perp_x, end_y + perp_y],
                [end_x - perp_x, end_y - perp_y],
                [start_x - perp_x, start_y - perp_y],
            ]
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

    // Apply boolean operations sequentially. Exposure-off primitives before
    // the first positive primitive have no earlier macro solid to erase.
    for (shape, exposure) in shapes.iter().skip(first_idx + 1) {
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
        Primitive::TriangleTemplateFlash { template, x, y } => Primitive::TriangleTemplateFlash {
            template: Rc::clone(template),
            x: x + dx,
            y: y + dy,
        },
        Primitive::Line {
            start_x,
            start_y,
            end_x,
            end_y,
            width,
            exposure,
        } => Primitive::Line {
            start_x: start_x + dx,
            start_y: start_y + dy,
            end_x: end_x + dx,
            end_y: end_y + dy,
            width: *width,
            exposure: *exposure,
        },
    }
}

/// Extracts the numeric value after a specific character in a string (e.g., "X1000" → "1000")
pub fn extract_value(line: &str, key: char) -> Option<String> {
    read_word_value(line, key, false).map(ToString::to_string)
}

fn extract_coordinate_value(line: &str, key: char) -> Option<String> {
    read_word_value(line, key, true).map(ToString::to_string)
}

/// Coordinate value conversion - decimal point processing according to format spec
pub fn convert_coordinate(
    coord_str: &str,
    axis: char,
    format_spec: &FormatSpec,
    unit_multiplier: f32,
) -> f32 {
    let result = parse_coordinate_number(
        coord_str,
        format_spec.coordinate_format(axis),
        unit_multiplier,
        "Gerber coordinate",
    )
    .unwrap_or(0.0);

    if result.is_finite() {
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
) -> Result<(), String> {
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
                    Primitive::Line { exposure, .. } => *exposure,
                    Primitive::TriangleTemplateFlash { .. } => 1.0,
                };
                // Wrap polygon in shape format (single contour)
                (vec![poly], exposure)
            })
            .collect();

        // Apply boolean operations with hole preservation
        let result_primitives = apply_boolean_operations(&shapes_with_exposure);
        try_reserve_primitives(primitives, result_primitives.len(), "aperture flash")?;
        primitives.extend(result_primitives);
    } else {
        if let Some(template) = aperture.triangle_template_for_transform(
            layer_scale,
            mirror_x,
            mirror_y,
            layer_rotation,
        ) {
            try_reserve_primitives(primitives, 1, "aperture triangle template flash")?;
            primitives.push(Primitive::TriangleTemplateFlash { template, x, y });
            return Ok(());
        }

        // Direct primitive cloning
        try_reserve_primitives(primitives, aperture.primitives.len(), "aperture flash")?;
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
                Primitive::TriangleTemplateFlash { x: tx, y: ty, .. } => {
                    *tx += x;
                    *ty += y;
                }
                Primitive::Line {
                    start_x,
                    start_y,
                    end_x,
                    end_y,
                    ..
                } => {
                    *start_x += x;
                    *start_y += y;
                    *end_x += x;
                    *end_y += y;
                }
            }
            primitives.push(new_primitive);
        }
    }

    Ok(())
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

fn transformed_boundary_for_flash(
    boundary: Boundary,
    x: f32,
    y: f32,
    layer_scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    layer_rotation: f32,
) -> Boundary {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for [corner_x, corner_y] in [
        [boundary.min_x(), boundary.min_y()],
        [boundary.min_x(), boundary.max_y()],
        [boundary.max_x(), boundary.min_y()],
        [boundary.max_x(), boundary.max_y()],
    ] {
        let (transformed_x, transformed_y) = transformed_flash_point(
            corner_x,
            corner_y,
            layer_scale,
            mirror_x,
            mirror_y,
            layer_rotation,
            x,
            y,
        );
        min_x = min_x.min(transformed_x);
        max_x = max_x.max(transformed_x);
        min_y = min_y.min(transformed_y);
        max_y = max_y.max(transformed_y);
    }

    Boundary::new(min_x, max_x, min_y, max_y)
}

fn transformed_flash_point(
    x: f32,
    y: f32,
    scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    rotation: f32,
    dx: f32,
    dy: f32,
) -> (f32, f32) {
    let mut tx = x * scale;
    let mut ty = y * scale;

    if mirror_x {
        tx = -tx;
    }
    if mirror_y {
        ty = -ty;
    }

    let cos_r = rotation.cos();
    let sin_r = rotation.sin();
    (tx * cos_r - ty * sin_r + dx, tx * sin_r + ty * cos_r + dy)
}

fn combine_interaction_bounds(
    primitive_bounds: Option<Boundary>,
    path_region_bounds: Option<Boundary>,
) -> Option<Boundary> {
    match (primitive_bounds, path_region_bounds) {
        (Some(mut primitive_bounds), Some(path_region_bounds)) => {
            primitive_bounds.include_boundary(&path_region_bounds);
            Some(primitive_bounds)
        }
        (Some(bounds), None) | (None, Some(bounds)) => Some(bounds),
        (None, None) => None,
    }
}

fn flush_primitives_to_layer(
    primitives: &mut Vec<Primitive>,
    path_regions: &mut PathRegions,
    polarity: Polarity,
    polarity_layers: &mut Vec<PolarityLayer>,
) -> Result<(), String> {
    if !primitives.is_empty() || path_regions.has_geometry_or_source_contours() {
        try_reserve_layers(polarity_layers, 1, "polarity layer")?;
        polarity_layers.push(PolarityLayer {
            polarity,
            primitives: take(primitives),
            path_regions: take(path_regions),
        });
    }

    Ok(())
}

fn flush_path_regions_to_layer(
    path_regions: &mut PathRegions,
    polarity: Polarity,
    polarity_layers: &mut Vec<PolarityLayer>,
) -> Result<(), String> {
    if path_regions.has_geometry() {
        try_reserve_layers(polarity_layers, 1, "polarity layer")?;
        polarity_layers.push(PolarityLayer {
            polarity,
            primitives: Vec::new(),
            path_regions: take(path_regions),
        });
    }

    Ok(())
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
    block_layers: &[PolarityLayer],
    state: &ParserState,
    primitives: &mut Vec<Primitive>,
    path_regions: &mut PathRegions,
    polarity_layers: &mut Vec<PolarityLayer>,
    x: f32,
    y: f32,
) -> Result<(), String> {
    flush_primitives_to_layer(primitives, path_regions, state.polarity, polarity_layers)?;

    for sy in 0..state.sr_y {
        for sx in 0..state.sr_x {
            let flash_x = x + sx as f32 * state.sr_i;
            let flash_y = y + sy as f32 * state.sr_j;

            for block_layer in block_layers {
                let mut transformed = Vec::new();
                try_reserve_primitives(
                    &mut transformed,
                    block_layer.primitives.len(),
                    "aperture block flash",
                )?;

                for primitive in &block_layer.primitives {
                    transformed.push(transform_primitive_for_flash(
                        primitive,
                        flash_x,
                        flash_y,
                        state.layer_scale,
                        state.mirror_x,
                        state.mirror_y,
                        state.layer_rotation,
                    ));
                }

                let mut transformed_path_regions = block_layer.path_regions.clone();
                transformed_path_regions.transform_for_flash(
                    state.layer_scale,
                    state.mirror_x,
                    state.mirror_y,
                    state.layer_rotation,
                    flash_x,
                    flash_y,
                );

                if !transformed.is_empty() || transformed_path_regions.has_geometry() {
                    try_reserve_layers(polarity_layers, 1, "aperture block polarity layer")?;
                    polarity_layers.push(PolarityLayer {
                        polarity: toggled_block_polarity(block_layer.polarity, state.polarity),
                        primitives: transformed,
                        path_regions: transformed_path_regions,
                    });
                }
            }
        }
    }

    Ok(())
}

fn record_block_flash_interaction(
    interaction_layer: Option<&mut InteractionLayer>,
    block_layers: &[PolarityLayer],
    first_sublayer_idx: usize,
    aperture_code: &str,
    aperture: &Aperture,
    state: &ParserState,
    x: f32,
    y: f32,
) -> Result<(), String> {
    let Some(interaction_layer) = interaction_layer else {
        return Ok(());
    };

    let properties = InteractionFeature::gerber_properties_with_transform(
        aperture,
        state.layer_scale,
        state.mirror_x,
        state.mirror_y,
        state.layer_rotation,
    );
    let mut sublayer_idx = first_sublayer_idx;
    for sy in 0..state.sr_y {
        for sx in 0..state.sr_x {
            let flash_x = x + sx as f32 * state.sr_i;
            let flash_y = y + sy as f32 * state.sr_j;

            for block_layer in block_layers {
                let mut transformed = Vec::new();
                try_reserve_primitives(
                    &mut transformed,
                    block_layer.primitives.len(),
                    "aperture block interaction",
                )?;

                for primitive in &block_layer.primitives {
                    transformed.push(transform_primitive_for_flash(
                        primitive,
                        flash_x,
                        flash_y,
                        state.layer_scale,
                        state.mirror_x,
                        state.mirror_y,
                        state.layer_rotation,
                    ));
                }

                let has_path_regions = block_layer.path_regions.has_geometry();
                let emitted_sublayer = !transformed.is_empty() || has_path_regions;
                if !emitted_sublayer {
                    continue;
                }
                let path_region_bounds = has_path_regions
                    .then(|| {
                        InteractionFeature::bounds_for_geometry(&[], &block_layer.path_regions)
                    })
                    .flatten()
                    .map(|bounds| {
                        transformed_boundary_for_flash(
                            bounds,
                            flash_x,
                            flash_y,
                            state.layer_scale,
                            state.mirror_x,
                            state.mirror_y,
                            state.layer_rotation,
                        )
                    });
                let Some(bounds) = combine_interaction_bounds(
                    InteractionFeature::bounds_for_geometry(&transformed, &PathRegions::empty()),
                    path_region_bounds,
                ) else {
                    sublayer_idx += 1;
                    continue;
                };
                let path_region_count = block_layer.path_regions.region_count();
                let path_region_ref = has_path_regions.then_some(PathRegionRef {
                    sublayer_idx,
                    region_start: 0,
                    region_count: path_region_count,
                });
                let mut interaction_path_regions = if has_path_regions {
                    block_layer.path_regions.clone_for_interaction_pick()
                } else {
                    PathRegions::empty()
                };
                if has_path_regions {
                    interaction_path_regions.transform_for_flash(
                        state.layer_scale,
                        state.mirror_x,
                        state.mirror_y,
                        state.layer_rotation,
                        flash_x,
                        flash_y,
                    );
                }

                let feature = InteractionFeature::from_geometry_with_bounds(
                    FeatureKind::Flash,
                    aperture_name(aperture_code),
                    Some(aperture_type(aperture)),
                    aperture.macro_name.clone(),
                    toggled_block_polarity(block_layer.polarity, state.polarity),
                    transformed,
                    interaction_path_regions,
                    path_region_ref,
                    bounds,
                    properties.clone(),
                );
                interaction_layer.push(feature);
                sublayer_idx += 1;
            }
        }
    }

    Ok(())
}

/// Flash aperture at given position - add all primitives of the aperture to the position
pub fn flash_aperture(
    state: &ParserState,
    apertures: &HashMap<String, Aperture>,
    primitives: &mut Vec<Primitive>,
    path_regions: &mut PathRegions,
    polarity_layers: &mut Vec<PolarityLayer>,
    x: f32,
    y: f32,
) -> Result<(), String> {
    if let Some(aperture) = apertures.get(&state.current_aperture) {
        let repeat_count = state.step_repeat_count("aperture flash")?;
        if let Some(block_layers) = aperture.block_layers.as_ref() {
            consume_expansion(
                state,
                block_flash_work_items(block_layers)?,
                repeat_count,
                "aperture block flash",
            )?;
            flash_block_aperture(
                block_layers,
                state,
                primitives,
                path_regions,
                polarity_layers,
                x,
                y,
            )?;
            return Ok(());
        }

        if let Some(template) = aperture.triangle_template_for_transform(
            state.layer_scale,
            state.mirror_x,
            state.mirror_y,
            state.layer_rotation,
        ) {
            consume_expansion(state, 1, repeat_count, "aperture triangle template flash")?;
            try_reserve_primitives(primitives, repeat_count, "aperture triangle template flash")?;
            for sy in 0..state.sr_y {
                for sx in 0..state.sr_x {
                    primitives.push(Primitive::TriangleTemplateFlash {
                        template: Rc::clone(&template),
                        x: x + sx as f32 * state.sr_i,
                        y: y + sy as f32 * state.sr_j,
                    });
                }
            }
            return Ok(());
        }

        consume_expansion(
            state,
            aperture_flash_work_items(aperture)?,
            repeat_count,
            "aperture flash",
        )?;

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
                )?;
            }
        }
    }

    Ok(())
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
) -> Result<(), String> {
    let start_x = state.x;
    let start_y = state.y;

    if let Some(aperture) = apertures.get(&state.current_aperture) {
        let repeat_count = state.step_repeat_count("interpolation")?;
        let per_copy = if points_coincide(start_x, start_y, end_x, end_y) {
            aperture_flash_work_items(aperture)?
        } else if aperture.is_solid_circle {
            3
        } else {
            0
        };
        if per_copy > 0 {
            consume_expansion(state, per_copy, repeat_count, "interpolation")?;
        }
        for sy in 0..state.sr_y {
            for sx in 0..state.sr_x {
                let offset_x = sx as f32 * state.sr_i;
                let offset_y = sy as f32 * state.sr_j;
                append_interpolation_no_sr(
                    state,
                    aperture,
                    primitives,
                    start_x + offset_x,
                    start_y + offset_y,
                    end_x + offset_x,
                    end_y + offset_y,
                    i,
                    j,
                )?;
            }
        }
    }

    Ok(())
}

fn append_interpolation_no_sr(
    state: &ParserState,
    aperture: &Aperture,
    primitives: &mut Vec<Primitive>,
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    i: f32,
    j: f32,
) -> Result<(), String> {
    match state.interpolation_mode.as_str() {
        "linear" | "linear_x10" | "linear_x01" | "linear_x001" => {
            if points_coincide(start_x, start_y, end_x, end_y) {
                flash_aperture_no_sr(
                    aperture,
                    primitives,
                    start_x,
                    start_y,
                    state.layer_scale,
                    state.mirror_x,
                    state.mirror_y,
                    state.layer_rotation,
                )?;
                return Ok(());
            }

            // RS-274X draw objects can only be created with a solid standard circle
            // aperture. Non-zero-length draws with other apertures are non-image.
            if !aperture.is_solid_circle {
                return Ok(());
            }

            flash_aperture_no_sr(
                aperture,
                primitives,
                start_x,
                start_y,
                state.layer_scale,
                state.mirror_x,
                state.mirror_y,
                state.layer_rotation,
            )?;

            // Store line body separately from the two round cap flashes so
            // the renderer can keep it instanced and clamp screen thickness.
            let diameter = aperture.radius * 2.0 * state.layer_scale;
            if let Some(line) = line_to_body(start_x, start_y, end_x, end_y, diameter, 1.0) {
                try_reserve_primitives(primitives, 1, "linear interpolation")?;
                primitives.push(line);
            }

            flash_aperture_no_sr(
                aperture,
                primitives,
                end_x,
                end_y,
                state.layer_scale,
                state.mirror_x,
                state.mirror_y,
                state.layer_rotation,
            )?;
        }
        "clockwise" | "counterclockwise" => {
            if points_coincide(start_x, start_y, end_x, end_y) && !arc_center_offset_present(i, j) {
                flash_aperture_no_sr(
                    aperture,
                    primitives,
                    start_x,
                    start_y,
                    state.layer_scale,
                    state.mirror_x,
                    state.mirror_y,
                    state.layer_rotation,
                )?;
                return Ok(());
            }

            // RS-274X arc objects can only be created with a solid standard circle
            // aperture. Non-zero-length arcs with other apertures are non-image.
            if !aperture.is_solid_circle {
                return Ok(());
            }

            if let Some((center_x, center_y, radius, start_angle, sweep_angle)) =
                calculate_arc_parameters(state, start_x, start_y, end_x, end_y, i, j)
            {
                let thickness = aperture.radius * 2.0 * state.layer_scale;
                let end_angle = start_angle + sweep_angle;

                let cap_start_x = center_x + radius * start_angle.cos();
                let cap_start_y = center_y + radius * start_angle.sin();
                let cap_end_x = center_x + radius * end_angle.cos();
                let cap_end_y = center_y + radius * end_angle.sin();

                flash_aperture_no_sr(
                    aperture,
                    primitives,
                    cap_start_x,
                    cap_start_y,
                    state.layer_scale,
                    state.mirror_x,
                    state.mirror_y,
                    state.layer_rotation,
                )?;

                try_reserve_primitives(primitives, 1, "arc interpolation")?;
                primitives.push(Primitive::Arc {
                    x: center_x,
                    y: center_y,
                    radius,
                    start_angle,
                    end_angle: start_angle + sweep_angle,
                    thickness,
                    exposure: 1.0,
                });

                flash_aperture_no_sr(
                    aperture,
                    primitives,
                    cap_end_x,
                    cap_end_y,
                    state.layer_scale,
                    state.mirror_x,
                    state.mirror_y,
                    state.layer_rotation,
                )?;
            } else {
                flash_aperture_no_sr(
                    aperture,
                    primitives,
                    start_x,
                    start_y,
                    state.layer_scale,
                    state.mirror_x,
                    state.mirror_y,
                    state.layer_rotation,
                )?;
                if !points_coincide(start_x, start_y, end_x, end_y) {
                    flash_aperture_no_sr(
                        aperture,
                        primitives,
                        end_x,
                        end_y,
                        state.layer_scale,
                        state.mirror_x,
                        state.mirror_y,
                        state.layer_rotation,
                    )?;
                }
            }
        }
        _ => {}
    }

    Ok(())
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

fn arc_center_offset_present(i: f32, j: f32) -> bool {
    i.abs() >= 0.0001 || j.abs() >= 0.0001
}

pub fn region_contours_have_arcs(region_contours: &[RegionContour]) -> bool {
    region_contours.iter().any(|contour| contour.has_arc)
}

pub fn region_contours_to_point_slices(
    region_contours: &[RegionContour],
) -> impl Iterator<Item = &[[f32; 2]]> {
    region_contours
        .iter()
        .map(|contour| contour.points.as_slice())
}

pub fn flatten_region_contours(
    region_contours: &[RegionContour],
    arc_tessellation_quality: u32,
) -> Result<Vec<Vec<[f32; 2]>>, String> {
    let mut contours = Vec::new();
    try_reserve_values(&mut contours, region_contours.len(), "region contours")?;

    for contour in region_contours {
        let mut points = Vec::new();

        if contour.segments.is_empty() {
            try_reserve_values(&mut points, contour.points.len(), "region points")?;
            points.extend_from_slice(&contour.points);
            contours.push(points);
            continue;
        }

        for segment in &contour.segments {
            match *segment {
                RegionSegment::Line { start, end } => {
                    if points.is_empty() {
                        try_reserve_values(&mut points, 1, "region points")?;
                        points.push(start);
                    }
                    try_reserve_values(&mut points, 1, "region points")?;
                    points.push(end);
                }
                RegionSegment::Arc {
                    start,
                    end,
                    center,
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                } => {
                    if points.is_empty() {
                        try_reserve_values(&mut points, 1, "region points")?;
                        points.push(start);
                    }

                    let arc = canonical_arc_geometry(
                        start,
                        end,
                        center,
                        radius,
                        start_angle,
                        sweep_angle,
                        clamp_sweep,
                    );
                    let max_angle_step =
                        region_arc_tessellation_max_angle_step(arc_tessellation_quality);
                    let segment_count =
                        ((arc.sweep_angle.abs() / max_angle_step).ceil() as usize).clamp(1, 512);
                    try_reserve_values(&mut points, segment_count, "region arc points")?;
                    for segment_idx in 1..segment_count {
                        let t = segment_idx as f32 / segment_count as f32;
                        let angle = arc.start_angle + arc.sweep_angle * t;
                        points.push([
                            arc.center[0] + arc.radius * angle.cos(),
                            arc.center[1] + arc.radius * angle.sin(),
                        ]);
                    }
                    points.push(end);
                }
            }
        }

        contours.push(points);
    }

    Ok(contours)
}

fn region_arc_tessellation_max_angle_step(quality: u32) -> f32 {
    match quality {
        0 => std::f32::consts::PI / 18.0,
        2 => std::f32::consts::PI / 72.0,
        _ => std::f32::consts::PI / 36.0,
    }
}

#[derive(Clone, Copy)]
struct CanonicalArc {
    center: [f32; 2],
    radius: f32,
    start_angle: f32,
    sweep_angle: f32,
}

fn canonical_arc_geometry(
    start: [f32; 2],
    end: [f32; 2],
    center: [f32; 2],
    radius: f32,
    start_angle: f32,
    sweep_angle: f32,
    clamp_sweep: bool,
) -> CanonicalArc {
    if radius <= 0.0 || sweep_angle.abs() >= std::f32::consts::TAU - 0.00001 {
        return CanonicalArc {
            center,
            radius,
            start_angle,
            sweep_angle,
        };
    }

    let chord = [end[0] - start[0], end[1] - start[1]];
    let chord_length = (chord[0] * chord[0] + chord[1] * chord[1]).sqrt();
    if !chord_length.is_finite() || chord_length <= 0.0 {
        return CanonicalArc {
            center,
            radius,
            start_angle,
            sweep_angle,
        };
    }

    let midpoint = [(start[0] + end[0]) * 0.5, (start[1] + end[1]) * 0.5];
    let normal = [-chord[1] / chord_length, chord[0] / chord_length];
    let center_offset = [center[0] - midpoint[0], center[1] - midpoint[1]];
    let signed_distance = center_offset[0] * normal[0] + center_offset[1] * normal[1];
    let adjusted_center = [
        midpoint[0] + normal[0] * signed_distance,
        midpoint[1] + normal[1] * signed_distance,
    ];
    let adjusted_radius =
        ((start[0] - adjusted_center[0]).powi(2) + (start[1] - adjusted_center[1]).powi(2)).sqrt();
    if !adjusted_center[0].is_finite()
        || !adjusted_center[1].is_finite()
        || !adjusted_radius.is_finite()
        || adjusted_radius <= 0.0
    {
        return CanonicalArc {
            center,
            radius,
            start_angle,
            sweep_angle,
        };
    }

    let adjusted_start_angle = (start[1] - adjusted_center[1]).atan2(start[0] - adjusted_center[0]);
    let adjusted_end_angle = (end[1] - adjusted_center[1]).atan2(end[0] - adjusted_center[0]);
    let adjusted_sweep_angle =
        directed_sweep_angle(adjusted_start_angle, adjusted_end_angle, sweep_angle);
    let adjusted_sweep_angle =
        if clamp_sweep && adjusted_sweep_angle.abs() > sweep_angle.abs() + 0.001 {
            sweep_angle
        } else {
            adjusted_sweep_angle
        };

    CanonicalArc {
        center: adjusted_center,
        radius: adjusted_radius,
        start_angle: adjusted_start_angle,
        sweep_angle: adjusted_sweep_angle,
    }
}

fn directed_sweep_angle(start_angle: f32, end_angle: f32, reference_sweep: f32) -> f32 {
    let mut sweep = end_angle - start_angle;
    if reference_sweep >= 0.0 {
        while sweep <= 0.0 {
            sweep += std::f32::consts::TAU;
        }
    } else {
        while sweep >= 0.0 {
            sweep -= std::f32::consts::TAU;
        }
    }
    sweep
}

pub fn build_path_regions(
    region_contours: &[RegionContour],
    state: &ParserState,
    arc_tessellation_quality: u32,
    collect_pick_contours: bool,
    collect_source_contours: bool,
) -> Result<PathRegions, String> {
    let mut path_regions = PathRegions::empty();
    let repeat_count = state.step_repeat_count("path region")?;
    let work_items = path_region_work_items_per_copy(
        region_contours,
        arc_tessellation_quality,
        collect_pick_contours,
        collect_source_contours,
    )?;
    consume_expansion(state, work_items, repeat_count, "path region")?;

    for sy in 0..state.sr_y {
        for sx in 0..state.sr_x {
            let offset_x = sx as f32 * state.sr_i;
            let offset_y = sy as f32 * state.sr_j;
            append_path_region(
                &mut path_regions,
                region_contours,
                offset_x,
                offset_y,
                arc_tessellation_quality,
                collect_pick_contours,
                collect_source_contours,
            )?;
        }
    }

    Ok(path_regions)
}

fn append_path_region(
    path_regions: &mut PathRegions,
    region_contours: &[RegionContour],
    offset_x: f32,
    offset_y: f32,
    arc_tessellation_quality: u32,
    collect_pick_contours: bool,
    collect_source_contours: bool,
) -> Result<(), String> {
    let Some((min_x, max_x, min_y, max_y)) =
        path_region_bounds(region_contours, offset_x, offset_y)
    else {
        return Ok(());
    };

    let margin = 1.0e-3_f32.max((max_x - min_x).abs().max((max_y - min_y).abs()) * 1.0e-6);
    let reference = [min_x - margin, min_y - margin];
    let (clear_min_x, clear_max_x, clear_min_y, clear_max_y) =
        path_region_stencil_bounds(region_contours, offset_x, offset_y, reference)
            .unwrap_or((min_x, max_x, min_y, max_y));

    push_cover_quad(&mut path_regions.cover_vertices, min_x, max_x, min_y, max_y)?;
    push_cover_quad(
        &mut path_regions.clear_vertices,
        clear_min_x,
        clear_max_x,
        clear_min_y,
        clear_max_y,
    )?;

    for contour in region_contours {
        append_contour_segments(path_regions, contour, reference, offset_x, offset_y)?;
    }

    if collect_pick_contours {
        path_regions.pick_contours.push(path_region_pick_contours(
            region_contours,
            offset_x,
            offset_y,
            arc_tessellation_quality,
        )?);
    }
    if collect_source_contours {
        path_regions.append_source_contours(offset_region_contours(
            region_contours,
            offset_x,
            offset_y,
        )?);
    }

    path_regions
        .wedge_vertex_offsets
        .push((path_regions.wedge_vertices.len() / 2) as u32);
    path_regions
        .sector_vertex_offsets
        .push((path_regions.sector_vertices.len() / PATH_SECTOR_VERTEX_FLOATS) as u32);

    Ok(())
}

fn append_region_source_contours(
    path_regions: &mut PathRegions,
    region_contours: &[RegionContour],
    state: &ParserState,
) -> Result<(), String> {
    for sy in 0..state.sr_y {
        for sx in 0..state.sr_x {
            let offset_x = sx as f32 * state.sr_i;
            let offset_y = sy as f32 * state.sr_j;
            path_regions.append_source_contours(offset_region_contours(
                region_contours,
                offset_x,
                offset_y,
            )?);
        }
    }
    Ok(())
}

fn offset_region_contours(
    region_contours: &[RegionContour],
    offset_x: f32,
    offset_y: f32,
) -> Result<Vec<RegionContour>, String> {
    let mut contours = Vec::new();
    try_reserve_values(
        &mut contours,
        region_contours.len(),
        "region source contours",
    )?;

    for contour in region_contours {
        let mut points = Vec::new();
        try_reserve_values(&mut points, contour.points.len(), "region source points")?;
        points.extend(
            contour
                .points
                .iter()
                .map(|point| [point[0] + offset_x, point[1] + offset_y]),
        );

        let mut segments = Vec::new();
        try_reserve_values(
            &mut segments,
            contour.segments.len(),
            "region source segments",
        )?;
        for segment in &contour.segments {
            segments.push(match *segment {
                RegionSegment::Line { start, end } => RegionSegment::Line {
                    start: [start[0] + offset_x, start[1] + offset_y],
                    end: [end[0] + offset_x, end[1] + offset_y],
                },
                RegionSegment::Arc {
                    start,
                    end,
                    center,
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                } => RegionSegment::Arc {
                    start: [start[0] + offset_x, start[1] + offset_y],
                    end: [end[0] + offset_x, end[1] + offset_y],
                    center: [center[0] + offset_x, center[1] + offset_y],
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                },
            });
        }

        contours.push(RegionContour {
            points,
            segments,
            has_arc: contour.has_arc,
        });
    }

    Ok(contours)
}

fn path_region_pick_contours(
    region_contours: &[RegionContour],
    offset_x: f32,
    offset_y: f32,
    arc_tessellation_quality: u32,
) -> Result<Vec<Vec<[f32; 2]>>, String> {
    let flattened_contours;
    let contour_iter: Box<dyn Iterator<Item = &[[f32; 2]]> + '_> =
        if region_contours_have_arcs(region_contours) {
            flattened_contours =
                flatten_region_contours(region_contours, arc_tessellation_quality)?;
            Box::new(flattened_contours.iter().map(Vec::as_slice))
        } else {
            Box::new(region_contours_to_point_slices(region_contours))
        };

    let mut contours = Vec::new();
    try_reserve_values(
        &mut contours,
        region_contours.len(),
        "path region pick contours",
    )?;
    for contour in contour_iter {
        if contour.len() < 3 {
            continue;
        }
        let mut transformed = Vec::new();
        try_reserve_values(
            &mut transformed,
            contour.len(),
            "path region pick contour points",
        )?;
        transformed.extend(
            contour
                .iter()
                .map(|point| [point[0] + offset_x, point[1] + offset_y]),
        );
        contours.push(transformed);
    }

    Ok(contours)
}

fn append_contour_segments(
    path_regions: &mut PathRegions,
    contour: &RegionContour,
    reference: [f32; 2],
    offset_x: f32,
    offset_y: f32,
) -> Result<(), String> {
    for segment in &contour.segments {
        match *segment {
            RegionSegment::Line { start, end } => {
                push_wedge_triangle(
                    &mut path_regions.wedge_vertices,
                    reference,
                    offset_point(start, offset_x, offset_y),
                    offset_point(end, offset_x, offset_y),
                )?;
            }
            RegionSegment::Arc {
                start,
                end,
                center,
                radius,
                start_angle,
                sweep_angle,
                clamp_sweep,
            } => {
                let start = offset_point(start, offset_x, offset_y);
                let end = offset_point(end, offset_x, offset_y);
                let center = offset_point(center, offset_x, offset_y);
                let arc = canonical_arc_geometry(
                    start,
                    end,
                    center,
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                );
                append_arc_segment_caps(path_regions, reference, start, end, arc)?;
            }
        }
    }

    if let (Some(first), Some(last)) = (contour.points.first(), contour.points.last()) {
        if !points_coincide(first[0], first[1], last[0], last[1]) {
            push_wedge_triangle(
                &mut path_regions.wedge_vertices,
                reference,
                offset_point(*last, offset_x, offset_y),
                offset_point(*first, offset_x, offset_y),
            )?;
        }
    }

    Ok(())
}

fn path_region_bounds(
    region_contours: &[RegionContour],
    offset_x: f32,
    offset_y: f32,
) -> Option<(f32, f32, f32, f32)> {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for contour in region_contours {
        for point in &contour.points {
            let x = point[0] + offset_x;
            let y = point[1] + offset_y;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }

        for segment in &contour.segments {
            if let RegionSegment::Arc {
                start,
                end,
                center,
                radius,
                start_angle,
                sweep_angle,
                clamp_sweep,
                ..
            } = *segment
            {
                let start = offset_point(start, offset_x, offset_y);
                let end = offset_point(end, offset_x, offset_y);
                let center = offset_point(center, offset_x, offset_y);
                let arc = canonical_arc_geometry(
                    start,
                    end,
                    center,
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                );
                let (arc_min_x, arc_max_x, arc_min_y, arc_max_y) =
                    arc_curve_bounds(arc.center, arc.radius, arc.start_angle, arc.sweep_angle);
                min_x = min_x.min(arc_min_x);
                max_x = max_x.max(arc_max_x);
                min_y = min_y.min(arc_min_y);
                max_y = max_y.max(arc_max_y);
            }
        }
    }

    min_x.is_finite().then_some((min_x, max_x, min_y, max_y))
}

fn path_region_stencil_bounds(
    region_contours: &[RegionContour],
    offset_x: f32,
    offset_y: f32,
    reference: [f32; 2],
) -> Option<(f32, f32, f32, f32)> {
    let mut min_x = reference[0];
    let mut max_x = reference[0];
    let mut min_y = reference[1];
    let mut max_y = reference[1];

    for contour in region_contours {
        for point in &contour.points {
            include_point_bounds(
                &mut min_x,
                &mut max_x,
                &mut min_y,
                &mut max_y,
                offset_point(*point, offset_x, offset_y),
            );
        }

        for segment in &contour.segments {
            if let RegionSegment::Arc {
                start,
                end,
                center,
                radius,
                start_angle,
                sweep_angle,
                clamp_sweep,
                ..
            } = *segment
            {
                let start = offset_point(start, offset_x, offset_y);
                let end = offset_point(end, offset_x, offset_y);
                let center = offset_point(center, offset_x, offset_y);
                let arc = canonical_arc_geometry(
                    start,
                    end,
                    center,
                    radius,
                    start_angle,
                    sweep_angle,
                    clamp_sweep,
                );
                include_point_bounds(&mut min_x, &mut max_x, &mut min_y, &mut max_y, arc.center);
                let (sector_min_x, sector_max_x, sector_min_y, sector_max_y) =
                    arc_sector_bounds(arc.center, arc.radius, arc.start_angle, arc.sweep_angle);
                min_x = min_x.min(sector_min_x);
                max_x = max_x.max(sector_max_x);
                min_y = min_y.min(sector_min_y);
                max_y = max_y.max(sector_max_y);
            }
        }
    }

    min_x.is_finite().then_some((min_x, max_x, min_y, max_y))
}

fn offset_point(point: [f32; 2], offset_x: f32, offset_y: f32) -> [f32; 2] {
    [point[0] + offset_x, point[1] + offset_y]
}

fn push_wedge_triangle(
    vertices: &mut Vec<f32>,
    a: [f32; 2],
    b: [f32; 2],
    c: [f32; 2],
) -> Result<(), String> {
    try_reserve_values(
        vertices,
        PATH_WEDGE_VERTEX_FLOATS,
        "path region wedge vertices",
    )?;
    vertices.extend_from_slice(&[a[0], a[1], b[0], b[1], c[0], c[1]]);
    Ok(())
}

fn push_cover_quad(
    vertices: &mut Vec<f32>,
    min_x: f32,
    max_x: f32,
    min_y: f32,
    max_y: f32,
) -> Result<(), String> {
    try_reserve_values(
        vertices,
        PATH_COVER_VERTEX_FLOATS,
        "path region cover vertices",
    )?;
    vertices.extend_from_slice(&[
        min_x, min_y, max_x, min_y, min_x, max_y, min_x, max_y, max_x, min_y, max_x, max_y,
    ]);
    Ok(())
}

fn append_arc_segment_caps(
    path_regions: &mut PathRegions,
    reference: [f32; 2],
    start: [f32; 2],
    end: [f32; 2],
    arc: CanonicalArc,
) -> Result<(), String> {
    let sweep = arc
        .sweep_angle
        .clamp(-std::f32::consts::TAU, std::f32::consts::TAU);
    let segment_count = ((sweep.abs() / std::f32::consts::FRAC_PI_2).ceil() as usize).max(1);
    let chunk_sweep = sweep / segment_count as f32;
    let mut chunk_start = start;

    for segment_idx in 0..segment_count {
        let chunk_start_angle = arc.start_angle + chunk_sweep * segment_idx as f32;
        let chunk_end_angle = chunk_start_angle + chunk_sweep;
        let chunk_end = if segment_idx + 1 == segment_count {
            end
        } else {
            angle_point(arc.center, arc.radius, chunk_end_angle)
        };

        push_wedge_triangle(
            &mut path_regions.wedge_vertices,
            reference,
            chunk_start,
            chunk_end,
        )?;
        push_sector_cap_quad(
            &mut path_regions.sector_vertices,
            arc.center,
            arc.radius,
            chunk_start_angle,
            chunk_sweep,
            chunk_start,
            chunk_end,
        )?;
        chunk_start = chunk_end;
    }

    Ok(())
}

fn push_sector_cap_quad(
    vertices: &mut Vec<f32>,
    center: [f32; 2],
    radius: f32,
    start_angle: f32,
    sweep_angle: f32,
    start: [f32; 2],
    end: [f32; 2],
) -> Result<(), String> {
    let mid_angle = start_angle + sweep_angle * 0.5;
    let outward = [mid_angle.cos(), mid_angle.sin()];
    let sagitta = radius * (1.0 - (sweep_angle.abs() * 0.5).cos());
    let cover_distance = sagitta + (radius.abs() * 1.0e-4).max(1.0e-5);
    let start_outer = [
        start[0] + outward[0] * cover_distance,
        start[1] + outward[1] * cover_distance,
    ];
    let end_outer = [
        end[0] + outward[0] * cover_distance,
        end[1] + outward[1] * cover_distance,
    ];

    try_reserve_values(
        vertices,
        PATH_SECTOR_QUAD_VERTICES * PATH_SECTOR_VERTEX_FLOATS,
        "path region arc sector vertices",
    )?;
    for point in [start, end, end_outer, start, end_outer, start_outer] {
        vertices.extend_from_slice(&[point[0], point[1], center[0], center[1], radius]);
    }

    Ok(())
}

fn angle_point(center: [f32; 2], radius: f32, angle: f32) -> [f32; 2] {
    [
        center[0] + radius * angle.cos(),
        center[1] + radius * angle.sin(),
    ]
}

pub(crate) fn arc_curve_bounds(
    center: [f32; 2],
    radius: f32,
    start_angle: f32,
    sweep_angle: f32,
) -> (f32, f32, f32, f32) {
    let end_angle = start_angle + sweep_angle;
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    include_angle_point(
        &mut min_x,
        &mut max_x,
        &mut min_y,
        &mut max_y,
        center,
        radius,
        start_angle,
    );
    include_angle_point(
        &mut min_x, &mut max_x, &mut min_y, &mut max_y, center, radius, end_angle,
    );

    for angle in [
        0.0,
        std::f32::consts::FRAC_PI_2,
        std::f32::consts::PI,
        std::f32::consts::PI * 1.5,
    ] {
        if angle_in_sweep(angle, start_angle, sweep_angle) {
            include_angle_point(
                &mut min_x, &mut max_x, &mut min_y, &mut max_y, center, radius, angle,
            );
        }
    }

    (min_x, max_x, min_y, max_y)
}

pub(crate) fn canonical_arc_curve_bounds(
    start: [f32; 2],
    end: [f32; 2],
    center: [f32; 2],
    radius: f32,
    start_angle: f32,
    sweep_angle: f32,
    clamp_sweep: bool,
) -> (f32, f32, f32, f32) {
    let arc = canonical_arc_geometry(
        start,
        end,
        center,
        radius,
        start_angle,
        sweep_angle,
        clamp_sweep,
    );
    arc_curve_bounds(arc.center, arc.radius, arc.start_angle, arc.sweep_angle)
}

fn arc_sector_bounds(
    center: [f32; 2],
    radius: f32,
    start_angle: f32,
    sweep_angle: f32,
) -> (f32, f32, f32, f32) {
    let (mut min_x, mut max_x, mut min_y, mut max_y) =
        arc_curve_bounds(center, radius, start_angle, sweep_angle);
    min_x = min_x.min(center[0]);
    max_x = max_x.max(center[0]);
    min_y = min_y.min(center[1]);
    max_y = max_y.max(center[1]);
    (min_x, max_x, min_y, max_y)
}

fn include_angle_point(
    min_x: &mut f32,
    max_x: &mut f32,
    min_y: &mut f32,
    max_y: &mut f32,
    center: [f32; 2],
    radius: f32,
    angle: f32,
) {
    let x = center[0] + radius * angle.cos();
    let y = center[1] + radius * angle.sin();
    *min_x = min_x.min(x);
    *max_x = max_x.max(x);
    *min_y = min_y.min(y);
    *max_y = max_y.max(y);
}

fn include_point_bounds(
    min_x: &mut f32,
    max_x: &mut f32,
    min_y: &mut f32,
    max_y: &mut f32,
    point: [f32; 2],
) {
    *min_x = min_x.min(point[0]);
    *max_x = max_x.max(point[0]);
    *min_y = min_y.min(point[1]);
    *max_y = max_y.max(point[1]);
}

fn angle_in_sweep(angle: f32, start_angle: f32, sweep_angle: f32) -> bool {
    let full_turn = std::f32::consts::PI * 2.0;
    if sweep_angle.abs() >= full_turn - 0.00001 {
        return true;
    }

    let angle = normalize_angle(angle);
    let start = normalize_angle(start_angle);
    let end = normalize_angle(start_angle + sweep_angle);

    if sweep_angle >= 0.0 {
        if end >= start {
            angle >= start && angle <= end
        } else {
            angle >= start || angle <= end
        }
    } else if end <= start {
        angle <= start && angle >= end
    } else {
        angle <= start || angle >= end
    }
}

fn normalize_angle(angle: f32) -> f32 {
    let full_turn = std::f32::consts::PI * 2.0;
    let mut angle = angle % full_turn;
    if angle < 0.0 {
        angle += full_turn;
    }
    angle
}

fn append_region_segment(
    contour: &mut RegionContour,
    state: &ParserState,
    end_x: f32,
    end_y: f32,
    i: f32,
    j: f32,
) -> Result<(), String> {
    let start = [state.x, state.y];
    let end = [end_x, end_y];

    if state.interpolation_mode != "clockwise" && state.interpolation_mode != "counterclockwise" {
        contour.push_line(start, end)?;
        return Ok(());
    }

    let start_x = state.x;
    let start_y = state.y;

    if let Some((center_x, center_y, radius, start_angle, sweep_angle)) =
        calculate_arc_parameters(state, start_x, start_y, end_x, end_y, i, j)
    {
        contour.push_arc_with_sweep_clamp(
            start,
            end,
            [center_x, center_y],
            radius,
            start_angle,
            sweep_angle,
            state.quadrant_mode == "single",
        )?;
    } else {
        contour.push_line(start, end)?;
    }

    Ok(())
}

fn record_primitive_delta(
    interaction_layer: Option<&mut InteractionLayer>,
    kind: FeatureKind,
    aperture_code: &str,
    aperture: Option<&Aperture>,
    polarity: Polarity,
    primitives: &[Primitive],
    start_index: usize,
    layer_scale: f32,
    mirror_x: bool,
    mirror_y: bool,
    layer_rotation: f32,
    arc_command: Option<&str>,
) {
    let Some(interaction_layer) = interaction_layer else {
        return;
    };
    if start_index >= primitives.len() {
        return;
    }

    let delta = &primitives[start_index..];
    let feature = if let Some(aperture) = aperture {
        let mut properties = InteractionFeature::gerber_properties_with_transform(
            aperture,
            layer_scale,
            mirror_x,
            mirror_y,
            layer_rotation,
        );
        properties.arc_command = arc_command.map(Rc::<str>::from);
        feature_from_primitive_delta(kind, aperture_code, aperture, polarity, delta, properties)
    } else {
        let properties = FeatureProperties {
            arc_command: arc_command.map(Rc::<str>::from),
            ..FeatureProperties::default()
        };
        InteractionFeature::from_primitive_slice(
            kind,
            aperture_name(aperture_code),
            aperture.map(aperture_type),
            None,
            polarity,
            delta,
            properties,
        )
    };

    if let Some(feature) = feature {
        interaction_layer.push(feature);
    }
}

fn record_flash_interactions(
    interaction_layer: Option<&mut InteractionLayer>,
    aperture_code: &str,
    aperture: &Aperture,
    state: &ParserState,
    x: f32,
    y: f32,
) -> Result<(), String> {
    let Some(interaction_layer) = interaction_layer else {
        return Ok(());
    };

    let properties = InteractionFeature::gerber_properties_with_transform(
        aperture,
        state.layer_scale,
        state.mirror_x,
        state.mirror_y,
        state.layer_rotation,
    );
    for sy in 0..state.sr_y {
        for sx in 0..state.sr_x {
            let flash_x = x + sx as f32 * state.sr_i;
            let flash_y = y + sy as f32 * state.sr_j;
            let mut primitives = Vec::new();
            flash_aperture_no_sr(
                aperture,
                &mut primitives,
                flash_x,
                flash_y,
                state.layer_scale,
                state.mirror_x,
                state.mirror_y,
                state.layer_rotation,
            )?;

            if let Some(feature) = feature_from_primitive_delta(
                FeatureKind::Flash,
                aperture_code,
                aperture,
                state.polarity,
                &primitives,
                properties.clone(),
            ) {
                interaction_layer.push(feature);
            }
        }
    }

    Ok(())
}

fn record_interpolation_interactions(
    interaction_layer: Option<&mut InteractionLayer>,
    kind: FeatureKind,
    aperture_code: &str,
    aperture: Option<&Aperture>,
    state: &ParserState,
    primitives: &[Primitive],
    start_index: usize,
    end_x: f32,
    end_y: f32,
    i: f32,
    j: f32,
    arc_command: Option<&str>,
) -> Result<(), String> {
    if state.sr_x <= 1 && state.sr_y <= 1 {
        record_primitive_delta(
            interaction_layer,
            kind,
            aperture_code,
            aperture,
            state.polarity,
            primitives,
            start_index,
            state.layer_scale,
            state.mirror_x,
            state.mirror_y,
            state.layer_rotation,
            arc_command,
        );
        return Ok(());
    }

    let Some(interaction_layer) = interaction_layer else {
        return Ok(());
    };
    let Some(aperture) = aperture else {
        return Ok(());
    };

    let mut properties = InteractionFeature::gerber_properties_with_transform(
        aperture,
        state.layer_scale,
        state.mirror_x,
        state.mirror_y,
        state.layer_rotation,
    );
    properties.arc_command = arc_command.map(Rc::<str>::from);

    for sy in 0..state.sr_y {
        for sx in 0..state.sr_x {
            let offset_x = sx as f32 * state.sr_i;
            let offset_y = sy as f32 * state.sr_j;
            let mut copy_primitives = Vec::new();
            append_interpolation_no_sr(
                state,
                aperture,
                &mut copy_primitives,
                state.x + offset_x,
                state.y + offset_y,
                end_x + offset_x,
                end_y + offset_y,
                i,
                j,
            )?;

            if let Some(feature) = feature_from_primitive_delta(
                kind.clone(),
                aperture_code,
                aperture,
                state.polarity,
                &copy_primitives,
                properties.clone(),
            ) {
                interaction_layer.push(feature);
            }
        }
    }

    Ok(())
}

fn interpolation_feature_kind(
    state: &ParserState,
    end_x: f32,
    end_y: f32,
    i: f32,
    j: f32,
) -> (FeatureKind, Option<&'static str>) {
    let is_arc =
        state.interpolation_mode == "clockwise" || state.interpolation_mode == "counterclockwise";
    if points_coincide(state.x, state.y, end_x, end_y)
        && (!is_arc || !arc_center_offset_present(i, j))
    {
        return (FeatureKind::Flash, None);
    }

    if is_arc {
        (
            FeatureKind::ArcDraw,
            arc_command_for_interpolation(&state.interpolation_mode),
        )
    } else {
        (FeatureKind::Draw, None)
    }
}

fn arc_command_for_interpolation(interpolation_mode: &str) -> Option<&'static str> {
    match interpolation_mode {
        "clockwise" => Some("G02"),
        "counterclockwise" => Some("G03"),
        _ => None,
    }
}

/// Parse graphic commands - process G/D/XY codes
/// Example: G01X1000Y2000D01* (draw line), X1000Y2000D03* (flash), etc.
pub fn parse_graphic_command(
    line: &str,
    state: &mut ParserState,
    apertures: &HashMap<String, Aperture>,
    primitives: &mut Vec<Primitive>,
    region_contours: &mut Vec<RegionContour>,
    path_regions: &mut PathRegions,
    polarity_layers: &mut Vec<PolarityLayer>,
    mut interaction_layer: Option<&mut InteractionLayer>,
    preserve_arc_regions: bool,
    arc_tessellation_quality: u32,
    collect_interactions: bool,
    collect_region_source_contours: bool,
) -> Result<(), String> {
    let clean_line = line.trim_end_matches('*');

    // Process G-code
    if let Some(g_index) = clean_line.find('G') {
        if let Some(g_code) = parse_g_code(&clean_line[g_index..]) {
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
                    region_contours.push(RegionContour::default()); // Start new contour
                }
                37 => {
                    // G37: End region fill mode
                    state.region_mode = false;

                    if preserve_arc_regions && region_contours_have_arcs(region_contours) {
                        flush_primitives_to_layer(
                            primitives,
                            path_regions,
                            state.polarity,
                            polarity_layers,
                        )?;
                        let region_path_regions = build_path_regions(
                            region_contours,
                            state,
                            arc_tessellation_quality,
                            collect_interactions,
                            collect_region_source_contours,
                        )?;
                        if let Some(interaction_layer) = interaction_layer.as_deref_mut() {
                            let path_region_ref = PathRegionRef {
                                sublayer_idx: polarity_layers.len(),
                                region_start: path_regions.region_count(),
                                region_count: region_path_regions.region_count(),
                            };
                            let interaction_bounds =
                                InteractionFeature::bounds_for_geometry(&[], &region_path_regions);
                            let interaction_path_regions =
                                region_path_regions.clone_for_interaction_pick();
                            path_regions.append(region_path_regions);
                            if let Some(bounds) = interaction_bounds {
                                let feature = InteractionFeature::from_geometry_with_bounds(
                                    FeatureKind::Region,
                                    None,
                                    None,
                                    None,
                                    state.polarity,
                                    Vec::new(),
                                    interaction_path_regions,
                                    Some(path_region_ref),
                                    bounds,
                                    FeatureProperties::default(),
                                );
                                interaction_layer.push(feature);
                            }
                        } else {
                            path_regions.append(region_path_regions);
                        }
                    } else {
                        flush_path_regions_to_layer(path_regions, state.polarity, polarity_layers)?;
                        let primitive_start = primitives.len();
                        // Triangulate region and add to primitives with Step and Repeat
                        // Regions are always positive (add material)
                        let flattened_contours;
                        let mut contour_iter: Box<dyn Iterator<Item = &[[f32; 2]]> + '_> =
                            if region_contours_have_arcs(region_contours) {
                                flattened_contours = flatten_region_contours(
                                    region_contours,
                                    arc_tessellation_quality,
                                )?;
                                Box::new(flattened_contours.iter().map(Vec::as_slice))
                            } else {
                                Box::new(region_contours_to_point_slices(region_contours))
                            };

                        for contour in contour_iter.by_ref() {
                            if contour.len() >= 3 {
                                match triangulate_outline(contour, 1.0) {
                                    Ok(triangles) => {
                                        // Apply Step and Repeat to region triangles
                                        let repeat_count = checked_primitive_count(
                                            state.sr_x as usize,
                                            state.sr_y as usize,
                                            "region step repeat",
                                        )?;
                                        let additional = checked_primitive_count(
                                            triangles.len(),
                                            repeat_count,
                                            "region",
                                        )?;
                                        consume_expansion(state, additional, 1, "region")?;
                                        try_reserve_primitives(primitives, additional, "region")?;

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
                        if collect_region_source_contours && primitives.len() > primitive_start {
                            append_region_source_contours(path_regions, region_contours, state)?;
                        }
                        record_primitive_delta(
                            interaction_layer.as_deref_mut(),
                            FeatureKind::Region,
                            "",
                            None,
                            state.polarity,
                            primitives,
                            primitive_start,
                            state.layer_scale,
                            state.mirror_x,
                            state.mirror_y,
                            state.layer_rotation,
                            None,
                        );
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
    let x_match = extract_coordinate_value(clean_line, 'X');
    let y_match = extract_coordinate_value(clean_line, 'Y');
    let i_match = extract_coordinate_value(clean_line, 'I');
    let j_match = extract_coordinate_value(clean_line, 'J');
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
                            append_region_segment(last_contour, state, x, y, i, j)?;
                        }
                    } else {
                        flush_path_regions_to_layer(path_regions, state.polarity, polarity_layers)?;
                        let primitive_start = primitives.len();
                        execute_interpolation(state, apertures, primitives, x, y, i, j)?;
                        let aperture = apertures.get(&state.current_aperture);
                        let (kind, arc_command) = interpolation_feature_kind(state, x, y, i, j);
                        record_interpolation_interactions(
                            interaction_layer.as_deref_mut(),
                            kind,
                            &state.current_aperture,
                            aperture,
                            state,
                            primitives,
                            primitive_start,
                            x,
                            y,
                            i,
                            j,
                            arc_command,
                        )?;
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
                            region_contours.push(RegionContour::default());
                        }

                        if let Some(last_contour) = region_contours.last_mut() {
                            last_contour.push_start([x, y])?;
                        }
                    }
                }
                3 if !state.region_mode => {
                    // D03: Flash aperture at current position
                    flush_path_regions_to_layer(path_regions, state.polarity, polarity_layers)?;
                    if apertures
                        .get(&state.current_aperture)
                        .and_then(|aperture| aperture.block_layers.as_ref())
                        .is_some()
                    {
                        flush_primitives_to_layer(
                            primitives,
                            path_regions,
                            state.polarity,
                            polarity_layers,
                        )?;
                    }
                    let block_sublayer_start = polarity_layers.len();
                    flash_aperture(
                        state,
                        apertures,
                        primitives,
                        path_regions,
                        polarity_layers,
                        x,
                        y,
                    )?;
                    let aperture = apertures.get(&state.current_aperture);
                    if let Some(aperture) = aperture {
                        if let Some(block_layers) = aperture.block_layers.as_ref() {
                            record_block_flash_interaction(
                                interaction_layer.as_deref_mut(),
                                block_layers,
                                block_sublayer_start,
                                &state.current_aperture,
                                aperture,
                                state,
                                x,
                                y,
                            )?;
                        } else {
                            record_flash_interactions(
                                interaction_layer.as_deref_mut(),
                                &state.current_aperture,
                                aperture,
                                state,
                                x,
                                y,
                            )?;
                        }
                    }
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
                append_region_segment(last_contour, state, x, y, i, j)?;
            }
        } else {
            flush_path_regions_to_layer(path_regions, state.polarity, polarity_layers)?;
            let primitive_start = primitives.len();
            execute_interpolation(state, apertures, primitives, x, y, i, j)?;
            let aperture = apertures.get(&state.current_aperture);
            let (kind, arc_command) = interpolation_feature_kind(state, x, y, i, j);
            record_interpolation_interactions(
                interaction_layer,
                kind,
                &state.current_aperture,
                aperture,
                state,
                primitives,
                primitive_start,
                x,
                y,
                i,
                j,
                arc_command,
            )?;
        }
    } else {
        // No drawing operation
    }

    // Update state
    state.x = x;
    state.y = y;
    state.i = i;
    state.j = j;

    Ok(())
}

#[cfg(test)]
mod tests;
