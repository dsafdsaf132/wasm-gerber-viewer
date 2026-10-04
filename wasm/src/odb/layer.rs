//! Drives a `GerberParser` with ODB++ feature records: every pad, line, arc and
//! surface becomes primitives or region contours through the same builders the
//! Gerber `D01`/`D03`/`G36` handlers use, so the result is ordinary
//! `GerberData` with feature-picking metadata.

use super::envelope::{Envelope, LayerKind};
use super::features::{
    normalize_angle, parse_features, Arc, Features, Line, Orient, Pad, Polygon, Record, Segment,
    Surface,
};
use super::symbols::{
    is_empty_shape, parse_standard_symbol, pen_diameter, resize_shape, shape_key,
    shape_to_aperture, solid_circle_diameter, Shape, ShapeKey,
};
use super::{store_diagnostics, Diagnostics};
use crate::geometry::RegionContour;
use crate::interaction::FeatureKind;
use crate::parser::geometry::{
    append_region_segment, execute_interpolation, finish_region_contours, flash_aperture,
    flush_path_regions_to_layer, flush_primitives_to_layer, interpolation_feature_kind,
    record_interpolation_interactions, record_primitive_delta, Primitive,
};
use crate::parser::{GerberParser, Polarity, PolarityLayer};
use std::collections::HashMap;

/// Nested user symbols deeper than this are reported instead of expanded.
pub(crate) const MAX_USER_SYMBOL_DEPTH: usize = 8;
/// Upper bound on records produced by expanding user symbols in one layer.
pub(crate) const MAX_EXPANDED_RECORDS: usize = 2_000_000;
/// Pen used to stroke the step profile.
const PROFILE_OUTLINE_WIDTH_MM: f32 = 0.1;

pub(crate) fn drive(parser: &mut GerberParser, envelope: &Envelope) -> Result<(), String> {
    let layer = FileContext::new(parse_features(envelope.features));
    let symbols: HashMap<String, FileContext> = envelope
        .symbols
        .iter()
        .map(|(name, text)| (name.clone(), FileContext::new(parse_features(text))))
        .collect();

    let mut driver = Driver {
        parser,
        symbols: &symbols,
        outline_mode: envelope.kind == LayerKind::Profile,
        apertures_by_shape: HashMap::new(),
        next_aperture_code: 10,
        expanded_records: 0,
        diagnostics: Diagnostics::default(),
    };
    driver.diagnostics.texts = layer.features.counts.texts;
    driver.diagnostics.barcodes = layer.features.counts.barcodes;

    let state = &mut driver.parser.current_state;
    state.quadrant_mode = "multi".to_string();
    state.unit_multiplier = 1.0;

    for record in &layer.features.records {
        driver.emit(record, &layer, 0)?;
    }
    driver.reset_transform();
    store_diagnostics(&driver.diagnostics);
    Ok(())
}

/// A parsed features file with its symbol table resolved to standard shapes
/// (`None` marks a user-defined symbol).
struct FileContext {
    features: Features,
    shapes: HashMap<i64, Option<Shape>>,
}

impl FileContext {
    fn new(features: Features) -> Self {
        let shapes = features
            .symbols
            .iter()
            .map(|(index, symbol)| {
                let shape =
                    parse_standard_symbol(&symbol.name, features.symbol_scale).map(|shape| {
                        if symbol.resize != 0.0 {
                            resize_shape(&shape, symbol.resize * features.symbol_scale)
                        } else {
                            shape
                        }
                    });
                (*index, shape)
            })
            .collect();
        FileContext { features, shapes }
    }

    fn shape(&self, sym: i64, resize: f32) -> Option<Shape> {
        let shape = self.shapes.get(&sym)?.as_ref()?;
        Some(if resize != 0.0 {
            resize_shape(shape, resize * self.features.symbol_scale)
        } else {
            shape.clone()
        })
    }

    fn is_user_symbol(&self, sym: i64) -> bool {
        matches!(self.shapes.get(&sym), Some(None))
    }
}

struct Driver<'a> {
    parser: &'a mut GerberParser,
    symbols: &'a HashMap<String, FileContext>,
    outline_mode: bool,
    apertures_by_shape: HashMap<ShapeKey, String>,
    next_aperture_code: u32,
    expanded_records: usize,
    diagnostics: Diagnostics,
}

impl Driver<'_> {
    fn emit(&mut self, record: &Record, context: &FileContext, depth: usize) -> Result<(), String> {
        match record {
            Record::Pad(pad) => self.emit_pad(pad, context, depth),
            Record::Line(line) => self.emit_line(line, context),
            Record::Arc(arc) => self.emit_arc(arc, context),
            Record::Surface(surface) => self.emit_surface(surface, None),
            Record::Text | Record::Barcode => Ok(()),
        }
    }

    fn aperture_code(&mut self, shape: &Shape) -> String {
        let key = shape_key(shape);
        if let Some(code) = self.apertures_by_shape.get(&key) {
            return code.clone();
        }
        let code = self.next_aperture_code.to_string();
        self.next_aperture_code += 1;
        self.parser
            .apertures
            .insert(code.clone(), shape_to_aperture(shape));
        self.apertures_by_shape.insert(key, code.clone());
        code
    }

    fn circle_code(&mut self, diameter: f32) -> String {
        self.aperture_code(&Shape::Circle { d: diameter })
    }

    fn set_polarity(&mut self, negative: bool) -> Result<(), String> {
        let polarity = if negative {
            Polarity::Negative
        } else {
            Polarity::Positive
        };
        let parser = &mut *self.parser;
        if parser.current_state.polarity != polarity
            && (!parser.current_primitives.is_empty()
                || parser
                    .current_path_regions
                    .has_geometry_or_source_contours())
        {
            parser.polarity_layers.try_reserve(1).map_err(|_| {
                "ODB++ layer is too large to parse: not enough memory for polarity layer list"
                    .to_string()
            })?;
            parser.polarity_layers.push(PolarityLayer {
                polarity: parser.current_state.polarity,
                primitives: std::mem::take(&mut parser.current_primitives),
                path_regions: std::mem::take(&mut parser.current_path_regions),
            });
        }
        parser.current_state.polarity = polarity;
        Ok(())
    }

    /// ODB++ rotates a pad clockwise first and mirrors second; mirroring is
    /// "along the x-axis (left to right, changing x coordinates)", i.e.
    /// `x -> -x`. The flash transform applies mirroring before rotation and
    /// rotates counter-clockwise, and `M · R(t) = R(-t) · M`, so a mirrored
    /// pad keeps the ODB angle while an unmirrored pad negates it.
    fn set_transform(&mut self, orient: Orient) {
        let rotation = if orient.mirror {
            orient.angle_deg
        } else {
            -orient.angle_deg
        };
        let state = &mut self.parser.current_state;
        state.mirror_x = orient.mirror;
        state.mirror_y = false;
        state.layer_rotation = normalize_angle(rotation).to_radians();
    }

    fn reset_transform(&mut self) {
        let state = &mut self.parser.current_state;
        state.mirror_x = false;
        state.mirror_y = false;
        state.layer_rotation = 0.0;
    }

    fn emit_pad(&mut self, pad: &Pad, context: &FileContext, depth: usize) -> Result<(), String> {
        let Some(shape) = context.shape(pad.sym, pad.resize) else {
            let name = context.features.symbol_name(pad.sym);
            if context.is_user_symbol(pad.sym) {
                if let Some(symbol) = self.symbols.get(&name.to_lowercase()) {
                    if depth < MAX_USER_SYMBOL_DEPTH {
                        return self.expand_user_symbol(pad, &name, symbol, depth);
                    }
                }
            }
            self.diagnostics.missing_symbol(&name);
            return Ok(());
        };
        if let Shape::Unsupported = shape {
            self.diagnostics
                .unknown_symbol(&context.features.symbol_name(pad.sym));
        }
        if is_empty_shape(&shape) {
            return Ok(());
        }

        let code = self.aperture_code(&shape);
        self.set_polarity(pad.neg)?;
        self.set_transform(pad.orient);
        let parser = &mut *self.parser;
        parser.current_state.current_aperture = code;
        flush_path_regions_to_layer(
            &mut parser.current_path_regions,
            parser.current_state.polarity,
            &mut parser.polarity_layers,
        )?;
        let flashed_from = parser.current_primitives.len();
        flash_aperture(
            &parser.current_state,
            &parser.apertures,
            &mut parser.current_primitives,
            &mut parser.current_path_regions,
            &mut parser.polarity_layers,
            pad.x,
            pad.y,
        )?;
        // Feature picking reads the primitives the flash just produced instead
        // of building the same geometry a second time. ODB++ has no step and
        // repeat, so the flash always appends exactly one feature's worth.
        let state = &parser.current_state;
        record_primitive_delta(
            parser.interaction_layer.as_mut(),
            FeatureKind::Flash,
            &state.current_aperture,
            parser.apertures.get(&state.current_aperture),
            state.polarity,
            &parser.current_primitives,
            flashed_from,
            state.layer_scale,
            state.mirror_x,
            state.mirror_y,
            state.layer_rotation,
            None,
        );
        Ok(())
    }

    /// Draw every record of a user symbol at the pad that references it.
    fn expand_user_symbol(
        &mut self,
        pad: &Pad,
        name: &str,
        symbol: &FileContext,
        depth: usize,
    ) -> Result<(), String> {
        let count = symbol.features.records.len();
        if self.expanded_records + count > MAX_EXPANDED_RECORDS {
            self.diagnostics.expansion_truncated = true;
            self.diagnostics.missing_symbol(name);
            return Ok(());
        }
        if pad.resize != 0.0 {
            self.diagnostics.resized_user_symbol(name);
        }
        self.expanded_records += count;
        self.diagnostics.texts += symbol.features.counts.texts;
        self.diagnostics.barcodes += symbol.features.counts.barcodes;
        let placement = Placement::new(pad);
        for record in &symbol.features.records {
            match record {
                // Surfaces carry every polygon and segment, so they are placed
                // while they are drawn instead of being copied per pad.
                Record::Surface(surface) => self.emit_surface(surface, Some(&placement))?,
                other => {
                    let placed = place_record(other, &placement);
                    self.emit(&placed, symbol, depth + 1)?;
                }
            }
        }
        Ok(())
    }

    fn pen_for(&mut self, sym: i64, context: &FileContext) -> Option<(String, bool)> {
        let Some(shape) = context.shape(sym, 0.0) else {
            let name = context.features.symbol_name(sym);
            self.diagnostics.missing_symbol(&name);
            return None;
        };
        if let Shape::Unsupported = shape {
            self.diagnostics
                .unknown_symbol(&context.features.symbol_name(sym));
            return None;
        }
        if let Some(diameter) = solid_circle_diameter(&shape) {
            return Some((self.circle_code(diameter), true));
        }
        // Non-round pens: flash the exact symbol for zero-length lines, else a
        // round pen of the smaller dimension.
        Some((self.aperture_code(&shape), false))
    }

    fn emit_line(&mut self, line: &Line, context: &FileContext) -> Result<(), String> {
        let zero_length = line.xs == line.xe && line.ys == line.ye;
        let Some((code, round)) = self.pen_for(line.sym, context) else {
            return Ok(());
        };
        let shape = context
            .shape(line.sym, 0.0)
            .unwrap_or(Shape::Circle { d: 0.0 });
        if is_empty_shape(&shape) {
            return Ok(());
        }
        self.set_polarity(line.neg)?;
        self.reset_transform();

        if !round && !zero_length {
            if let Shape::Rect { w, h } = shape {
                if (w - h).abs() < 1e-6 {
                    return self.emit_square_stroke(line, w, &code);
                }
            }
            self.diagnostics.non_round_lines += 1;
            let diameter = pen_diameter(&shape);
            if diameter <= 0.0 {
                return Ok(());
            }
            let round_code = self.circle_code(diameter);
            return self.interpolate(&round_code, line.xs, line.ys, line.xe, line.ye, None);
        }
        self.interpolate(&code, line.xs, line.ys, line.xe, line.ye, None)
    }

    fn emit_arc(&mut self, arc: &Arc, context: &FileContext) -> Result<(), String> {
        let Some((code, round)) = self.pen_for(arc.sym, context) else {
            return Ok(());
        };
        let shape = context
            .shape(arc.sym, 0.0)
            .unwrap_or(Shape::Circle { d: 0.0 });
        if is_empty_shape(&shape) {
            return Ok(());
        }
        let code = if round {
            code
        } else {
            self.diagnostics.non_round_lines += 1;
            let diameter = pen_diameter(&shape);
            if diameter <= 0.0 {
                return Ok(());
            }
            self.circle_code(diameter)
        };
        self.set_polarity(arc.neg)?;
        self.reset_transform();
        self.interpolate(
            &code,
            arc.xs,
            arc.ys,
            arc.xe,
            arc.ye,
            Some((arc.xc, arc.yc, arc.cw)),
        )
    }

    /// A Gerber `D01` with the given aperture: a straight draw, or an arc when
    /// a centre is given (multi-quadrant, explicit centre).
    fn interpolate(
        &mut self,
        code: &str,
        xs: f32,
        ys: f32,
        xe: f32,
        ye: f32,
        arc: Option<(f32, f32, bool)>,
    ) -> Result<(), String> {
        let parser = &mut *self.parser;
        let state = &mut parser.current_state;
        state.current_aperture = code.to_string();
        state.x = xs;
        state.y = ys;
        let (i, j) = match arc {
            Some((xc, yc, cw)) => {
                state.interpolation_mode =
                    if cw { "clockwise" } else { "counterclockwise" }.to_string();
                (xc - xs, yc - ys)
            }
            None => {
                state.interpolation_mode = "linear".to_string();
                (0.0, 0.0)
            }
        };
        flush_path_regions_to_layer(
            &mut parser.current_path_regions,
            state.polarity,
            &mut parser.polarity_layers,
        )?;
        let primitive_start = parser.current_primitives.len();
        execute_interpolation(
            state,
            &parser.apertures,
            &mut parser.current_primitives,
            xe,
            ye,
            i,
            j,
        )?;
        let (kind, arc_command) = interpolation_feature_kind(state, xe, ye, i, j);
        record_interpolation_interactions(
            parser.interaction_layer.as_mut(),
            kind,
            code,
            parser.apertures.get(code),
            state,
            &parser.current_primitives,
            primitive_start,
            xe,
            ye,
            i,
            j,
            arc_command,
        )?;
        state.x = xe;
        state.y = ye;
        state.interpolation_mode = "linear".to_string();
        Ok(())
    }

    /// A line drawn with a square pen: a rectangle with square end caps.
    fn emit_square_stroke(&mut self, line: &Line, width: f32, code: &str) -> Result<(), String> {
        let dx = line.xe - line.xs;
        let dy = line.ye - line.ys;
        let length = dx.hypot(dy);
        if length <= f32::EPSILON || length.is_nan() {
            // Degenerate line: flash the square instead of dividing by zero.
            return self.interpolate(code, line.xs, line.ys, line.xs, line.ys, None);
        }
        let (ux, uy) = (dx / length, dy / length);
        let half = width / 2.0;
        let (nx, ny) = (-uy * half, ux * half);
        let (sx, sy) = (line.xs - ux * half, line.ys - uy * half);
        let (ex, ey) = (line.xe + ux * half, line.ye + uy * half);
        let corners = [
            [sx + nx, sy + ny],
            [ex + nx, ey + ny],
            [ex - nx, ey - ny],
            [sx - nx, sy - ny],
        ];
        let parser = &mut *self.parser;
        flush_path_regions_to_layer(
            &mut parser.current_path_regions,
            parser.current_state.polarity,
            &mut parser.polarity_layers,
        )?;
        parser
            .current_state
            .consume_generated_items(2, "ODB++ square line")?;
        let primitive_start = parser.current_primitives.len();
        parser.current_primitives.try_reserve(2).map_err(|_| {
            "ODB++ layer is too large to parse: not enough memory for line primitives".to_string()
        })?;
        for vertices in [
            [corners[0], corners[1], corners[2]],
            [corners[0], corners[2], corners[3]],
        ] {
            parser.current_primitives.push(Primitive::Triangle {
                vertices,
                exposure: 1.0,
                hole_x: 0.0,
                hole_y: 0.0,
                hole_radius: 0.0,
            });
        }
        let state = &parser.current_state;
        record_primitive_delta(
            parser.interaction_layer.as_mut(),
            FeatureKind::Draw,
            code,
            parser.apertures.get(code),
            state.polarity,
            &parser.current_primitives,
            primitive_start,
            state.layer_scale,
            state.mirror_x,
            state.mirror_y,
            state.layer_rotation,
            None,
        );
        Ok(())
    }

    /// Draw a surface, optionally moved into the coordinate system of the pad
    /// that flashes the user symbol it belongs to.
    fn emit_surface(
        &mut self,
        surface: &Surface,
        placement: Option<&Placement>,
    ) -> Result<(), String> {
        let negative = surface.neg != placement.is_some_and(|placement| placement.neg);
        self.set_polarity(negative)?;
        self.reset_transform();
        if self.outline_mode {
            return self.stroke_surface(surface, placement);
        }

        // Each island with the holes that follow it forms one region group.
        let mut group: Vec<RegionContour> = Vec::new();
        for polygon in &surface.polygons {
            if polygon.segments.is_empty() {
                continue;
            }
            if polygon.hole {
                if !group.is_empty() {
                    group.push(self.contour(polygon, placement)?);
                }
                continue;
            }
            self.finish_group(&group)?;
            group.clear();
            group.push(self.contour(polygon, placement)?);
        }
        self.finish_group(&group)
    }

    fn finish_group(&mut self, group: &[RegionContour]) -> Result<(), String> {
        if group.is_empty() {
            return Ok(());
        }
        let parser = &mut *self.parser;
        let collect_interactions = parser.interaction_layer.is_some();
        finish_region_contours(
            group,
            &parser.current_state,
            &mut parser.current_primitives,
            &mut parser.current_path_regions,
            &mut parser.polarity_layers,
            parser.interaction_layer.as_mut(),
            parser.preserve_arc_regions,
            parser.arc_tessellation_quality,
            collect_interactions,
            parser.preserve_region_source_contours,
            true,
        )
    }

    /// One polygon as a region contour, arcs kept as arcs.
    fn contour(
        &mut self,
        polygon: &Polygon,
        placement: Option<&Placement>,
    ) -> Result<RegionContour, String> {
        let mut contour = RegionContour::default();
        let (x0, y0) = placed_point(placement, polygon.x0, polygon.y0);
        contour.push_start([x0, y0])?;
        let state = &mut self.parser.current_state;
        state.x = x0;
        state.y = y0;
        for segment in &polygon.segments {
            let (x, y, i, j) = match *segment {
                Segment::Line { x, y } => {
                    state.interpolation_mode = "linear".to_string();
                    let (x, y) = placed_point(placement, x, y);
                    (x, y, 0.0, 0.0)
                }
                Segment::Arc { x, y, cx, cy, cw } => {
                    let cw = placed_cw(placement, cw);
                    state.interpolation_mode =
                        if cw { "clockwise" } else { "counterclockwise" }.to_string();
                    let (x, y) = placed_point(placement, x, y);
                    let (cx, cy) = placed_point(placement, cx, cy);
                    (x, y, cx - state.x, cy - state.y)
                }
            };
            if x == state.x && y == state.y && i == 0.0 && j == 0.0 {
                continue;
            }
            append_region_segment(&mut contour, state, x, y, i, j)?;
            state.x = x;
            state.y = y;
        }
        state.interpolation_mode = "linear".to_string();
        Ok(contour)
    }

    /// Stroke every island and hole contour instead of filling (step profile).
    fn stroke_surface(
        &mut self,
        surface: &Surface,
        placement: Option<&Placement>,
    ) -> Result<(), String> {
        let code = self.circle_code(PROFILE_OUTLINE_WIDTH_MM);
        for polygon in &surface.polygons {
            if polygon.segments.is_empty() {
                continue;
            }
            let (x0, y0) = placed_point(placement, polygon.x0, polygon.y0);
            let (mut x, mut y) = (x0, y0);
            for segment in &polygon.segments {
                match *segment {
                    Segment::Line { x: nx, y: ny } => {
                        let (nx, ny) = placed_point(placement, nx, ny);
                        if nx != x || ny != y {
                            self.interpolate(&code, x, y, nx, ny, None)?;
                        }
                        x = nx;
                        y = ny;
                    }
                    Segment::Arc {
                        x: nx,
                        y: ny,
                        cx,
                        cy,
                        cw,
                    } => {
                        let (nx, ny) = placed_point(placement, nx, ny);
                        let (cx, cy) = placed_point(placement, cx, cy);
                        self.interpolate(
                            &code,
                            x,
                            y,
                            nx,
                            ny,
                            Some((cx, cy, placed_cw(placement, cw))),
                        )?;
                        x = nx;
                        y = ny;
                    }
                }
            }
            if x != x0 || y != y0 {
                self.interpolate(&code, x, y, x0, y0, None)?;
            }
        }
        // Keep polarity layers in step with the Gerber path.
        let parser = &mut *self.parser;
        let _ = flush_primitives_to_layer;
        let _ = &parser.current_primitives;
        Ok(())
    }
}

/// The placement of a pad that references a user symbol. ODB++ rotates the
/// symbol clockwise about its origin first, then mirrors it "along the
/// x-axis (left to right, changing x coordinates)", i.e. `x -> -x`, and then
/// moves it to the pad position.
pub(crate) struct Placement {
    x: f32,
    y: f32,
    angle_deg: f32,
    mirror: bool,
    neg: bool,
    cos: f32,
    sin: f32,
}

/// A point of a user symbol in the coordinate system of the pad that flashes
/// it (unchanged when the record is not part of a symbol).
fn placed_point(placement: Option<&Placement>, x: f32, y: f32) -> (f32, f32) {
    match placement {
        Some(placement) => placement.point(x, y),
        None => (x, y),
    }
}

/// Mirroring a symbol reverses the direction of its arcs.
fn placed_cw(placement: Option<&Placement>, cw: bool) -> bool {
    match placement {
        Some(placement) if placement.mirror => !cw,
        _ => cw,
    }
}

impl Placement {
    pub(crate) fn new(pad: &Pad) -> Self {
        let radians = pad.orient.angle_deg.to_radians();
        Placement {
            x: pad.x,
            y: pad.y,
            angle_deg: pad.orient.angle_deg,
            mirror: pad.orient.mirror,
            neg: pad.neg,
            cos: radians.cos(),
            sin: radians.sin(),
        }
    }

    pub(crate) fn point(&self, px: f32, py: f32) -> (f32, f32) {
        let rx = px * self.cos + py * self.sin;
        let ry = -px * self.sin + py * self.cos;
        (self.x + if self.mirror { -rx } else { rx }, self.y + ry)
    }
}

/// Move one record of a user symbol into the coordinate system of the pad that
/// flashes it. Polarity is relative to the pad, arc direction flips under
/// mirroring, and nested pad orientations compose as
/// `M^m · R(θ) · M^mi · R(θi) = M^(m⊕mi) · R(mi ? θi − θ : θi + θ)`:
/// moving the inner mirror `M^mi` past the outer rotation negates that
/// rotation.
pub(crate) fn place_record(record: &Record, placement: &Placement) -> Record {
    match record {
        Record::Pad(pad) => {
            let (x, y) = placement.point(pad.x, pad.y);
            let angle = if pad.orient.mirror {
                pad.orient.angle_deg - placement.angle_deg
            } else {
                pad.orient.angle_deg + placement.angle_deg
            };
            Record::Pad(Pad {
                x,
                y,
                neg: pad.neg != placement.neg,
                orient: Orient {
                    angle_deg: normalize_angle(angle),
                    mirror: pad.orient.mirror != placement.mirror,
                },
                ..pad.clone()
            })
        }
        Record::Line(line) => {
            let (xs, ys) = placement.point(line.xs, line.ys);
            let (xe, ye) = placement.point(line.xe, line.ye);
            Record::Line(Line {
                xs,
                ys,
                xe,
                ye,
                neg: line.neg != placement.neg,
                ..line.clone()
            })
        }
        Record::Arc(arc) => {
            let (xs, ys) = placement.point(arc.xs, arc.ys);
            let (xe, ye) = placement.point(arc.xe, arc.ye);
            let (xc, yc) = placement.point(arc.xc, arc.yc);
            Record::Arc(Arc {
                xs,
                ys,
                xe,
                ye,
                xc,
                yc,
                neg: arc.neg != placement.neg,
                cw: if placement.mirror { !arc.cw } else { arc.cw },
                ..arc.clone()
            })
        }
        Record::Surface(surface) => Record::Surface(Surface {
            neg: surface.neg != placement.neg,
            polygons: surface
                .polygons
                .iter()
                .map(|polygon| {
                    let (x0, y0) = placement.point(polygon.x0, polygon.y0);
                    Polygon {
                        hole: polygon.hole,
                        x0,
                        y0,
                        segments: polygon
                            .segments
                            .iter()
                            .map(|segment| match *segment {
                                Segment::Line { x, y } => {
                                    let (x, y) = placement.point(x, y);
                                    Segment::Line { x, y }
                                }
                                Segment::Arc { x, y, cx, cy, cw } => {
                                    let (x, y) = placement.point(x, y);
                                    let (cx, cy) = placement.point(cx, cy);
                                    Segment::Arc {
                                        x,
                                        y,
                                        cx,
                                        cy,
                                        cw: if placement.mirror { !cw } else { cw },
                                    }
                                }
                            })
                            .collect(),
                    }
                })
                .collect(),
        }),
        Record::Text => Record::Text,
        Record::Barcode => Record::Barcode,
    }
}
