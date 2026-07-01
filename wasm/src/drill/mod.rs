use crate::geometry::{
    Arcs, Boundary, Circles, GerberData, Lines, PathRegions, Thermals, TriangleTemplateInstances,
    Triangles,
};
use crate::interaction::{drill_hit_feature, drill_slot_feature, InteractionLayer};
use crate::parser::common::{
    find_g_code_index, line_has_g_code, parse_coordinate_number as parse_common_coordinate_number,
    parse_decimal_number as parse_common_decimal_number, parse_g_code, read_number,
    CoordinateFormat, ZeroSuppression,
};
use crate::parser::geometry::Primitive;
use js_sys::{Array, Object, Reflect};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

const INCH_TO_MM: f32 = 25.4;
const TWO_PI: f32 = std::f32::consts::PI * 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Unit {
    Metric,
    Inch,
}

impl Unit {
    fn multiplier(self) -> f32 {
        match self {
            Unit::Metric => 1.0,
            Unit::Inch => INCH_TO_MM,
        }
    }

    fn default_decimal_digits(self) -> u32 {
        match self {
            Unit::Metric => 3,
            Unit::Inch => 4,
        }
    }

    fn default_integer_digits(self) -> u32 {
        match self {
            Unit::Metric => 3,
            Unit::Inch => 2,
        }
    }
}

fn default_coordinate_format(unit: Unit) -> CoordinateFormat {
    CoordinateFormat {
        integer_digits: unit.default_integer_digits(),
        decimal_digits: unit.default_decimal_digits(),
        zero_suppression: ZeroSuppression::Leading,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Drill,
    Rout,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum RoutingInterpolation {
    Linear,
    ClockwiseArc,
    CounterClockwiseArc,
}

impl RoutingInterpolation {
    fn is_arc(self) -> bool {
        matches!(
            self,
            RoutingInterpolation::ClockwiseArc | RoutingInterpolation::CounterClockwiseArc
        )
    }
}

#[derive(Clone, Debug)]
struct Tool {
    diameter_mm: f32,
    hit_count: u32,
    slot_count: u32,
}

#[derive(Debug)]
pub struct DrillToolMetadata {
    code: u32,
    diameter_mm: f32,
    hit_count: u32,
    slot_count: u32,
}

impl DrillToolMetadata {
    fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        set_property(&object, "code", JsValue::from_f64(self.code as f64))?;
        set_property(
            &object,
            "diameterMm",
            JsValue::from_f64(self.diameter_mm as f64),
        )?;
        set_property(
            &object,
            "hitCount",
            JsValue::from_f64(self.hit_count as f64),
        )?;
        set_property(
            &object,
            "slotCount",
            JsValue::from_f64(self.slot_count as f64),
        )?;
        Ok(object.into())
    }
}

#[derive(Debug)]
pub struct DrillMetadata {
    tools: Vec<DrillToolMetadata>,
    hit_count: u32,
    slot_count: u32,
}

impl DrillMetadata {
    pub fn to_js(&self) -> Result<JsValue, JsValue> {
        let object = Object::new();
        let tools = Array::new();
        for tool in &self.tools {
            tools.push(&tool.to_js()?);
        }

        set_property(&object, "tools", tools.into())?;
        set_property(
            &object,
            "hitCount",
            JsValue::from_f64(self.hit_count as f64),
        )?;
        set_property(
            &object,
            "slotCount",
            JsValue::from_f64(self.slot_count as f64),
        )?;
        Ok(object.into())
    }
}

pub struct DrillParseResult {
    pub fill_layer: GerberData,
    pub outline_layer: GerberData,
    pub metadata: DrillMetadata,
    pub interaction_layer: Option<InteractionLayer>,
}

#[derive(Default)]
struct DrillGeometry {
    circle_x: Vec<f32>,
    circle_y: Vec<f32>,
    circle_radius: Vec<f32>,
    line_start_x: Vec<f32>,
    line_start_y: Vec<f32>,
    line_end_x: Vec<f32>,
    line_end_y: Vec<f32>,
    line_width: Vec<f32>,
    arc_x: Vec<f32>,
    arc_y: Vec<f32>,
    arc_radius: Vec<f32>,
    arc_start_angle: Vec<f32>,
    arc_sweep_angle: Vec<f32>,
    arc_thickness: Vec<f32>,
    min_x: f32,
    max_x: f32,
    min_y: f32,
    max_y: f32,
    has_geometry: bool,
}

impl DrillGeometry {
    fn new() -> Self {
        Self {
            min_x: f32::INFINITY,
            max_x: f32::NEG_INFINITY,
            min_y: f32::INFINITY,
            max_y: f32::NEG_INFINITY,
            ..Self::default()
        }
    }

    fn push_circle(&mut self, x: f32, y: f32, radius: f32) {
        self.circle_x.push(x);
        self.circle_y.push(y);
        self.circle_radius.push(radius);
        self.include_circle_bounds(x, y, radius);
    }

    fn push_line(&mut self, start_x: f32, start_y: f32, end_x: f32, end_y: f32, width: f32) {
        self.line_start_x.push(start_x);
        self.line_start_y.push(start_y);
        self.line_end_x.push(end_x);
        self.line_end_y.push(end_y);
        self.line_width.push(width);

        let radius = width / 2.0;
        self.include_circle_bounds(start_x, start_y, radius);
        self.include_circle_bounds(end_x, end_y, radius);
    }

    fn push_arc(
        &mut self,
        center_x: f32,
        center_y: f32,
        radius: f32,
        start_angle: f32,
        sweep_angle: f32,
        thickness: f32,
    ) {
        self.arc_x.push(center_x);
        self.arc_y.push(center_y);
        self.arc_radius.push(radius);
        self.arc_start_angle.push(start_angle);
        self.arc_sweep_angle.push(sweep_angle);
        self.arc_thickness.push(thickness);
        self.include_arc_bounds(
            center_x,
            center_y,
            radius,
            start_angle,
            sweep_angle,
            thickness,
        );
    }

    fn include_circle_bounds(&mut self, x: f32, y: f32, radius: f32) {
        self.min_x = self.min_x.min(x - radius);
        self.max_x = self.max_x.max(x + radius);
        self.min_y = self.min_y.min(y - radius);
        self.max_y = self.max_y.max(y + radius);
        self.has_geometry = true;
    }

    fn include_arc_bounds(
        &mut self,
        center_x: f32,
        center_y: f32,
        radius: f32,
        start_angle: f32,
        sweep_angle: f32,
        thickness: f32,
    ) {
        let cap_radius = thickness / 2.0;
        if sweep_angle.abs() >= TWO_PI - 0.000001 {
            self.include_circle_bounds(center_x, center_y, radius + cap_radius);
            return;
        }

        self.include_arc_point_bounds(center_x, center_y, radius, start_angle, cap_radius);
        self.include_arc_point_bounds(
            center_x,
            center_y,
            radius,
            start_angle + sweep_angle,
            cap_radius,
        );

        for angle in [
            0.0,
            std::f32::consts::FRAC_PI_2,
            std::f32::consts::PI,
            std::f32::consts::PI * 1.5,
        ] {
            if angle_is_on_sweep(angle, start_angle, sweep_angle) {
                self.include_arc_point_bounds(center_x, center_y, radius, angle, cap_radius);
            }
        }
    }

    fn include_arc_point_bounds(
        &mut self,
        center_x: f32,
        center_y: f32,
        radius: f32,
        angle: f32,
        cap_radius: f32,
    ) {
        self.include_circle_bounds(
            center_x + angle.cos() * radius,
            center_y + angle.sin() * radius,
            cap_radius,
        );
    }

    fn boundary(&self) -> Boundary {
        if !self.has_geometry {
            return Boundary::new(0.0, 0.0, 0.0, 0.0);
        }

        Boundary::new(self.min_x, self.max_x, self.min_y, self.max_y)
    }

    fn into_layer(self) -> GerberData {
        let boundary = self.boundary();
        GerberData::new(
            Triangles::new(Vec::new(), Vec::new(), Vec::new(), Vec::new()),
            Vec::<TriangleTemplateInstances>::new(),
            Lines::new(
                self.line_start_x,
                self.line_start_y,
                self.line_end_x,
                self.line_end_y,
                self.line_width,
            ),
            Circles::new(
                self.circle_x,
                self.circle_y,
                self.circle_radius,
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            Arcs::new(
                self.arc_x,
                self.arc_y,
                self.arc_radius,
                self.arc_start_angle,
                self.arc_sweep_angle,
                self.arc_thickness,
            ),
            Thermals::new(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            PathRegions::empty(),
            boundary,
            false,
        )
    }
}

#[derive(Clone, Copy, Default, Debug)]
struct CoordinateWords {
    x: Option<f32>,
    y: Option<f32>,
    i: Option<f32>,
    j: Option<f32>,
    a: Option<f32>,
}

impl CoordinateWords {
    fn has_xy(self) -> bool {
        self.x.is_some() || self.y.is_some()
    }

    fn has_arc_definition(self) -> bool {
        self.a.is_some() || self.i.is_some() || self.j.is_some()
    }
}

struct DrillParser {
    unit: Unit,
    coordinate_format: CoordinateFormat,
    coordinate_format_from_comment: bool,
    mode: Mode,
    routing_interpolation: RoutingInterpolation,
    modal_arc_words: CoordinateWords,
    is_absolute: bool,
    routing_down: bool,
    current_tool: Option<u32>,
    current_x: f32,
    current_y: f32,
    last_hit: Option<(f32, f32)>,
    tools: BTreeMap<u32, Tool>,
    fill: DrillGeometry,
    outline: DrillGeometry,
    outline_width_mm: f32,
    offset_x: f32,
    offset_y: f32,
    interaction_layer: Option<InteractionLayer>,
}

impl DrillParser {
    fn new(
        outline_width_mm: f32,
        offset_x: f32,
        offset_y: f32,
        collect_interactions: bool,
    ) -> Result<Self, JsValue> {
        if !offset_x.is_finite() || !offset_y.is_finite() {
            return Err(JsValue::from_str("Drill layer offset must be finite"));
        }

        Ok(Self {
            unit: Unit::Metric,
            coordinate_format: default_coordinate_format(Unit::Metric),
            coordinate_format_from_comment: false,
            mode: Mode::Drill,
            routing_interpolation: RoutingInterpolation::Linear,
            modal_arc_words: CoordinateWords::default(),
            is_absolute: true,
            routing_down: false,
            current_tool: None,
            current_x: 0.0,
            current_y: 0.0,
            last_hit: None,
            tools: BTreeMap::new(),
            fill: DrillGeometry::new(),
            outline: DrillGeometry::new(),
            outline_width_mm: outline_width_mm.max(0.0),
            offset_x,
            offset_y,
            interaction_layer: collect_interactions.then(InteractionLayer::new),
        })
    }

    fn parse(mut self, content: &str) -> Result<DrillParseResult, JsValue> {
        for raw_line in content.lines() {
            if let Some((integer_digits, decimal_digits)) = parse_file_format_comment(raw_line) {
                self.coordinate_format.integer_digits = integer_digits;
                self.coordinate_format.decimal_digits = decimal_digits;
                self.coordinate_format_from_comment = true;
                continue;
            }
            let line = sanitize_line(raw_line);
            if line.is_empty() {
                continue;
            }
            self.parse_line(&line)?;
        }

        if !self.fill.has_geometry {
            return Err(JsValue::from_str(
                "File does not contain valid drill data (no holes found)",
            ));
        }

        let hit_count = self.tools.values().map(|tool| tool.hit_count).sum();
        let slot_count = self.tools.values().map(|tool| tool.slot_count).sum();
        let tools = self
            .tools
            .iter()
            .filter_map(|(&code, tool)| {
                (tool.hit_count > 0 || tool.slot_count > 0).then_some(DrillToolMetadata {
                    code,
                    diameter_mm: tool.diameter_mm,
                    hit_count: tool.hit_count,
                    slot_count: tool.slot_count,
                })
            })
            .collect();

        Ok(DrillParseResult {
            fill_layer: self.fill.into_layer(),
            outline_layer: self.outline.into_layer(),
            metadata: DrillMetadata {
                tools,
                hit_count,
                slot_count,
            },
            interaction_layer: self.interaction_layer,
        })
    }

    fn parse_line(&mut self, line: &str) -> Result<(), JsValue> {
        if line == "M48" || line == "%" || line == "M30" || line.starts_with("FMAT") {
            return Ok(());
        }

        let g_code = parse_g_code(line);

        if g_code == Some(5) {
            self.mode = Mode::Drill;
            self.routing_down = false;
            return Ok(());
        }
        if line == "M15" {
            self.mode = Mode::Rout;
            self.routing_down = true;
            return Ok(());
        }
        if line == "M16" {
            self.routing_down = false;
            return Ok(());
        }
        if line == "G90" {
            self.is_absolute = true;
            return Ok(());
        }
        if line == "G91" {
            self.is_absolute = false;
            return Ok(());
        }
        if line == "ICI,ON" {
            self.is_absolute = false;
            return Ok(());
        }
        if line == "ICI,OFF" {
            self.is_absolute = true;
            return Ok(());
        }
        if line == "LZ" {
            self.coordinate_format.zero_suppression = zero_suppression_from_excellon_token(line)
                .unwrap_or(self.coordinate_format.zero_suppression);
            return Ok(());
        }
        if line == "TZ" {
            self.coordinate_format.zero_suppression = zero_suppression_from_excellon_token(line)
                .unwrap_or(self.coordinate_format.zero_suppression);
            return Ok(());
        }
        if line.starts_with("METRIC") {
            self.set_unit(Unit::Metric, line)?;
            return Ok(());
        }
        if line == "M71" {
            self.set_unit_code(Unit::Metric);
            return Ok(());
        }
        if line.starts_with("INCH") {
            self.set_unit(Unit::Inch, line)?;
            return Ok(());
        }
        if line == "M72" {
            self.set_unit_code(Unit::Inch);
            return Ok(());
        }

        if let Some((code, diameter)) = parse_tool_declaration(line, self.unit)? {
            self.tools.insert(
                code,
                Tool {
                    diameter_mm: diameter,
                    hit_count: 0,
                    slot_count: 0,
                },
            );
            return Ok(());
        }

        if let Some(code) =
            parse_tool_selection(line).map_err(|message| JsValue::from_str(&message))?
        {
            if code == 0 {
                self.current_tool = None;
                return Ok(());
            }
            if !self.tools.contains_key(&code) {
                return Err(JsValue::from_str(&format!(
                    "Drill file selects undefined tool T{code}"
                )));
            }
            self.current_tool = Some(code);
            return Ok(());
        }

        if g_code == Some(0) {
            self.mode = Mode::Rout;
            self.routing_interpolation = RoutingInterpolation::Linear;
            if let Some(words) = parse_coordinate_words(line, self.unit, self.coordinate_format)? {
                let (x, y) = self.resolve_xy(words.x, words.y);
                self.current_x = x;
                self.current_y = y;
            }
            return Ok(());
        }

        if g_code == Some(1) {
            self.routing_interpolation = RoutingInterpolation::Linear;
            let Some(words) = parse_coordinate_words(line, self.unit, self.coordinate_format)?
            else {
                return Ok(());
            };
            let (end_x, end_y) = self.resolve_xy(words.x, words.y);
            if self.routing_down {
                self.mode = Mode::Rout;
                self.push_slot(end_x, end_y)?;
            }
            self.current_x = end_x;
            self.current_y = end_y;
            return Ok(());
        }

        if g_code == Some(85) || line_has_g_code(line, 85) {
            let Some((start_words, end_words)) =
                parse_g85_words(line, self.unit, self.coordinate_format)?
            else {
                return Ok(());
            };
            let (start_x, start_y) = start_words
                .map(|words| self.resolve_xy(words.x, words.y))
                .unwrap_or((self.current_x, self.current_y));
            let (end_x, end_y) = if self.is_absolute {
                (
                    end_words.x.unwrap_or(start_x),
                    end_words.y.unwrap_or(start_y),
                )
            } else {
                (
                    start_x + end_words.x.unwrap_or(0.0),
                    start_y + end_words.y.unwrap_or(0.0),
                )
            };
            self.push_slot_between(start_x, start_y, end_x, end_y)?;
            self.current_x = end_x;
            self.current_y = end_y;
            return Ok(());
        }

        if matches!(g_code, Some(2) | Some(3)) {
            self.routing_interpolation = if g_code == Some(3) {
                RoutingInterpolation::CounterClockwiseArc
            } else {
                RoutingInterpolation::ClockwiseArc
            };
            let Some(words) = parse_coordinate_words(line, self.unit, self.coordinate_format)?
            else {
                return Ok(());
            };
            self.update_modal_arc_words(words);
            if !words.has_xy() {
                return Ok(());
            }
            let (end_x, end_y) = self.resolve_xy(words.x, words.y);
            if self.mode == Mode::Rout && self.routing_down {
                self.push_arc(
                    end_x,
                    end_y,
                    self.words_with_modal_arc(words),
                    self.routing_interpolation == RoutingInterpolation::CounterClockwiseArc,
                )?;
            }
            self.current_x = end_x;
            self.current_y = end_y;
            return Ok(());
        }

        if self.mode == Mode::Drill {
            if let Some((count, spacing)) =
                parse_repeat_hole(line, self.unit, self.coordinate_format)
                    .map_err(|message| JsValue::from_str(&message))?
            {
                self.push_repeated_hits(count, spacing)?;
                return Ok(());
            }
        }

        if let Some(words) = parse_coordinate_words(line, self.unit, self.coordinate_format)? {
            if !words.has_xy() && words.has_arc_definition() {
                self.update_modal_arc_words(words);
                return Ok(());
            }
            let (x, y) = self.resolve_xy(words.x, words.y);
            if self.mode == Mode::Drill {
                self.push_hit(x, y)?;
            } else if self.mode == Mode::Rout && self.routing_down {
                if self.routing_interpolation.is_arc() && !words.has_xy() {
                    self.update_modal_arc_words(words);
                    return Ok(());
                }
                self.push_modal_rout(x, y, words)?;
            }
            self.current_x = x;
            self.current_y = y;
        }

        Ok(())
    }

    fn push_modal_rout(
        &mut self,
        end_x: f32,
        end_y: f32,
        words: CoordinateWords,
    ) -> Result<(), JsValue> {
        match self.routing_interpolation {
            RoutingInterpolation::Linear => self.push_slot(end_x, end_y),
            RoutingInterpolation::ClockwiseArc => {
                self.update_modal_arc_words(words);
                self.push_arc(end_x, end_y, self.words_with_modal_arc(words), false)
            }
            RoutingInterpolation::CounterClockwiseArc => {
                self.update_modal_arc_words(words);
                self.push_arc(end_x, end_y, self.words_with_modal_arc(words), true)
            }
        }
    }

    fn update_modal_arc_words(&mut self, words: CoordinateWords) {
        if words.a.is_some() {
            self.modal_arc_words.a = words.a;
            self.modal_arc_words.i = None;
            self.modal_arc_words.j = None;
            return;
        }
        if words.i.is_some() || words.j.is_some() {
            if words.i.is_some() {
                self.modal_arc_words.i = words.i;
            }
            if words.j.is_some() {
                self.modal_arc_words.j = words.j;
            }
            self.modal_arc_words.a = None;
        }
    }

    fn words_with_modal_arc(&self, mut words: CoordinateWords) -> CoordinateWords {
        if words.a.is_some() {
            return words;
        }
        if words.i.is_some() || words.j.is_some() {
            if words.i.is_none() {
                words.i = self.modal_arc_words.i;
            }
            if words.j.is_none() {
                words.j = self.modal_arc_words.j;
            }
            return words;
        }
        if !words.has_arc_definition() {
            words.a = self.modal_arc_words.a;
            words.i = self.modal_arc_words.i;
            words.j = self.modal_arc_words.j;
        }
        words
    }

    fn resolve_xy(&self, x: Option<f32>, y: Option<f32>) -> (f32, f32) {
        if self.is_absolute {
            (x.unwrap_or(self.current_x), y.unwrap_or(self.current_y))
        } else {
            (
                self.current_x + x.unwrap_or(0.0),
                self.current_y + y.unwrap_or(0.0),
            )
        }
    }

    fn set_unit(&mut self, unit: Unit, line: &str) -> Result<(), JsValue> {
        self.unit = unit;
        let mut format = default_coordinate_format(unit);
        if self.coordinate_format_from_comment {
            format.integer_digits = self.coordinate_format.integer_digits;
            format.decimal_digits = self.coordinate_format.decimal_digits;
        }
        for token in line.split(',').skip(1) {
            if let Some(zero_suppression) = zero_suppression_from_excellon_token(token) {
                format.zero_suppression = zero_suppression;
            } else if let Some((integer_digits, decimal_digits)) = parse_format_token(token)? {
                format.integer_digits = integer_digits;
                format.decimal_digits = decimal_digits;
                self.coordinate_format_from_comment = false;
            }
        }
        self.coordinate_format = format;
        Ok(())
    }

    fn set_unit_code(&mut self, unit: Unit) {
        if self.unit != unit && !self.coordinate_format_from_comment {
            self.coordinate_format.integer_digits = unit.default_integer_digits();
            self.coordinate_format.decimal_digits = unit.default_decimal_digits();
        }
        self.unit = unit;
    }

    fn selected_tool(&self) -> Result<(u32, f32), JsValue> {
        let code = self
            .current_tool
            .ok_or_else(|| JsValue::from_str("Drill hit appears before tool selection"))?;
        let tool = self.tools.get(&code).ok_or_else(|| {
            JsValue::from_str(&format!("Selected drill tool T{code} is undefined"))
        })?;
        Ok((code, tool.diameter_mm))
    }

    fn push_repeated_hits(&mut self, count: u32, spacing: CoordinateWords) -> Result<(), JsValue> {
        let dx = spacing.x.unwrap_or(0.0);
        let dy = spacing.y.unwrap_or(0.0);
        let Some((mut x, mut y)) = self.last_hit else {
            return Err(JsValue::from_str(
                "Repeat drill record appears before an initial drill hit",
            ));
        };

        for _ in 0..count {
            x += dx;
            y += dy;
            self.push_hit(x, y)?;
        }

        self.current_x = x;
        self.current_y = y;
        self.last_hit = Some((x, y));
        Ok(())
    }

    fn push_hit(&mut self, x: f32, y: f32) -> Result<(), JsValue> {
        let (code, diameter_mm) = self.selected_tool()?;
        if diameter_mm <= 0.0 || !diameter_mm.is_finite() {
            return Err(JsValue::from_str(&format!(
                "Drill tool T{code} has invalid diameter"
            )));
        }

        let x = x + self.offset_x;
        let y = y + self.offset_y;
        let radius = diameter_mm / 2.0;
        self.outline
            .push_circle(x, y, radius + self.outline_width_mm);
        self.fill.push_circle(x, y, radius);
        if let Some(interaction_layer) = &mut self.interaction_layer {
            if let Some(feature) = drill_hit_feature(code, diameter_mm, x, y) {
                interaction_layer.push(feature);
            }
        }
        if let Some(tool) = self.tools.get_mut(&code) {
            tool.hit_count = tool.hit_count.saturating_add(1);
        }
        self.last_hit = Some((x - self.offset_x, y - self.offset_y));
        Ok(())
    }

    fn push_slot(&mut self, end_x: f32, end_y: f32) -> Result<(), JsValue> {
        self.push_slot_between(self.current_x, self.current_y, end_x, end_y)
    }

    fn push_slot_between(
        &mut self,
        start_x: f32,
        start_y: f32,
        end_x: f32,
        end_y: f32,
    ) -> Result<(), JsValue> {
        let (code, diameter_mm) = self.selected_tool()?;
        if diameter_mm <= 0.0 || !diameter_mm.is_finite() {
            return Err(JsValue::from_str(&format!(
                "Drill tool T{code} has invalid diameter"
            )));
        }

        let start_x = start_x + self.offset_x;
        let start_y = start_y + self.offset_y;
        let end_x = end_x + self.offset_x;
        let end_y = end_y + self.offset_y;
        let outline_radius = diameter_mm / 2.0 + self.outline_width_mm;
        let fill_radius = diameter_mm / 2.0;
        self.outline.push_line(
            start_x,
            start_y,
            end_x,
            end_y,
            diameter_mm + self.outline_width_mm * 2.0,
        );
        self.outline.push_circle(start_x, start_y, outline_radius);
        self.outline.push_circle(end_x, end_y, outline_radius);
        self.fill
            .push_line(start_x, start_y, end_x, end_y, diameter_mm);
        self.fill.push_circle(start_x, start_y, fill_radius);
        self.fill.push_circle(end_x, end_y, fill_radius);
        if let Some(interaction_layer) = &mut self.interaction_layer {
            if let Some(feature) = drill_slot_feature(
                code,
                diameter_mm,
                vec![
                    Primitive::Line {
                        start_x,
                        start_y,
                        end_x,
                        end_y,
                        width: diameter_mm,
                        exposure: 1.0,
                    },
                    Primitive::Circle {
                        x: start_x,
                        y: start_y,
                        radius: fill_radius,
                        exposure: 1.0,
                        hole_x: 0.0,
                        hole_y: 0.0,
                        hole_radius: 0.0,
                    },
                    Primitive::Circle {
                        x: end_x,
                        y: end_y,
                        radius: fill_radius,
                        exposure: 1.0,
                        hole_x: 0.0,
                        hole_y: 0.0,
                        hole_radius: 0.0,
                    },
                ],
            ) {
                interaction_layer.push(feature);
            }
        }
        if let Some(tool) = self.tools.get_mut(&code) {
            tool.slot_count = tool.slot_count.saturating_add(1);
        }
        Ok(())
    }

    fn push_arc(
        &mut self,
        end_x: f32,
        end_y: f32,
        words: CoordinateWords,
        ccw: bool,
    ) -> Result<(), JsValue> {
        let (code, diameter_mm) = self.selected_tool()?;
        if diameter_mm <= 0.0 || !diameter_mm.is_finite() {
            return Err(JsValue::from_str(&format!(
                "Drill tool T{code} has invalid diameter"
            )));
        }

        let arc = if let Some(radius) = words.a {
            arc_from_radius(self.current_x, self.current_y, end_x, end_y, radius, ccw)?
        } else if let (Some(i), Some(j)) = (words.i, words.j) {
            arc_from_center_offset(self.current_x, self.current_y, end_x, end_y, i, j, ccw)?
        } else {
            return Err(JsValue::from_str(
                "Circular drill rout requires A radius or I/J center offset",
            ));
        };

        let center_x = arc.center_x + self.offset_x;
        let center_y = arc.center_y + self.offset_y;
        self.outline.push_arc(
            center_x,
            center_y,
            arc.radius,
            arc.start_angle,
            arc.sweep_angle,
            diameter_mm + self.outline_width_mm * 2.0,
        );
        self.fill.push_arc(
            center_x,
            center_y,
            arc.radius,
            arc.start_angle,
            arc.sweep_angle,
            diameter_mm,
        );
        if let Some(interaction_layer) = &mut self.interaction_layer {
            let start_x = self.current_x + self.offset_x;
            let start_y = self.current_y + self.offset_y;
            let end_x = end_x + self.offset_x;
            let end_y = end_y + self.offset_y;
            let fill_radius = diameter_mm * 0.5;
            if let Some(feature) = drill_slot_feature(
                code,
                diameter_mm,
                vec![
                    Primitive::Arc {
                        x: center_x,
                        y: center_y,
                        radius: arc.radius,
                        start_angle: arc.start_angle,
                        end_angle: arc.start_angle + arc.sweep_angle,
                        thickness: diameter_mm,
                        exposure: 1.0,
                    },
                    Primitive::Circle {
                        x: start_x,
                        y: start_y,
                        radius: fill_radius,
                        exposure: 1.0,
                        hole_x: 0.0,
                        hole_y: 0.0,
                        hole_radius: 0.0,
                    },
                    Primitive::Circle {
                        x: end_x,
                        y: end_y,
                        radius: fill_radius,
                        exposure: 1.0,
                        hole_x: 0.0,
                        hole_y: 0.0,
                        hole_radius: 0.0,
                    },
                ],
            ) {
                interaction_layer.push(feature);
            }
        }
        if let Some(tool) = self.tools.get_mut(&code) {
            tool.slot_count = tool.slot_count.saturating_add(1);
        }
        Ok(())
    }
}

struct DrillArc {
    center_x: f32,
    center_y: f32,
    radius: f32,
    start_angle: f32,
    sweep_angle: f32,
}

pub fn parse_drill_with_offset(
    content: &str,
    outline_width_mm: f32,
    offset_x: f32,
    offset_y: f32,
) -> Result<DrillParseResult, JsValue> {
    DrillParser::new(outline_width_mm, offset_x, offset_y, false)?.parse(content)
}

pub fn parse_drill_with_offset_and_interactions(
    content: &str,
    outline_width_mm: f32,
    offset_x: f32,
    offset_y: f32,
) -> Result<DrillParseResult, JsValue> {
    DrillParser::new(outline_width_mm, offset_x, offset_y, true)?.parse(content)
}

fn set_property(object: &Object, key: &str, value: JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), &value)
        .map(|_| ())
        .map_err(|_| JsValue::from_str(&format!("Failed to set drill metadata field `{key}`")))
}

fn sanitize_line(raw_line: &str) -> String {
    raw_line
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .replace(char::is_whitespace, "")
        .to_ascii_uppercase()
}

fn parse_file_format_comment(raw_line: &str) -> Option<(u32, u32)> {
    let comment = raw_line.trim_start().strip_prefix(';')?;
    let normalized = comment
        .trim()
        .replace(char::is_whitespace, "")
        .to_ascii_uppercase();
    let value = normalized.strip_prefix("FILE_FORMAT=")?;
    let (integer, decimal) = value.split_once(':').or_else(|| value.split_once('.'))?;
    let integer_digits = integer.parse::<u32>().ok()?;
    let decimal_digits = decimal.parse::<u32>().ok()?;
    (integer_digits > 0 && decimal_digits > 0).then_some((integer_digits, decimal_digits))
}

fn parse_tool_declaration(line: &str, unit: Unit) -> Result<Option<(u32, f32)>, JsValue> {
    if !line.starts_with('T') || !line.contains('C') {
        return Ok(None);
    }

    let c_index = line
        .find('C')
        .ok_or_else(|| JsValue::from_str("Invalid drill tool declaration"))?;
    let code = parse_tool_code(&line[1..c_index])
        .ok_or_else(|| JsValue::from_str("Invalid drill tool number"))?;
    let diameter_token = read_number(&line[c_index + 1..], true)
        .ok_or_else(|| JsValue::from_str("Invalid drill tool diameter"))?;
    let diameter = parse_decimal_number(diameter_token)? * unit.multiplier();
    if diameter <= 0.0 || !diameter.is_finite() {
        return Err(JsValue::from_str("Drill tool diameter must be positive"));
    }

    Ok(Some((code, diameter)))
}

fn parse_tool_selection(line: &str) -> Result<Option<u32>, String> {
    let line = line.strip_prefix("G54").unwrap_or(line);
    let Some(rest) = line.strip_prefix('T') else {
        return Ok(None);
    };
    let digits_end = rest
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .map(|(index, ch)| index + ch.len_utf8())
        .last()
        .unwrap_or(0);
    if digits_end == 0 {
        return Err("Invalid drill tool selection".to_string());
    }

    let code = parse_tool_code(&rest[..digits_end])
        .ok_or_else(|| "Invalid drill tool selection".to_string())?;
    parse_tool_selection_suffix(&rest[digits_end..])?;
    Ok(Some(code))
}

fn parse_tool_selection_suffix(mut suffix: &str) -> Result<(), String> {
    while !suffix.is_empty() {
        let Some(word) = suffix.chars().next() else {
            return Ok(());
        };
        if !matches!(word, 'F' | 'S') {
            return Err(format!("Invalid drill tool selection suffix `{suffix}`"));
        }
        let value_start = word.len_utf8();
        let Some(token) = read_number(&suffix[value_start..], true) else {
            return Err(format!("Invalid drill tool selection suffix `{suffix}`"));
        };
        let value = token
            .parse::<f32>()
            .map_err(|_| format!("Invalid drill tool selection suffix `{suffix}`"))?;
        if !value.is_finite() || value < 0.0 {
            return Err(format!("Invalid drill tool selection suffix `{suffix}`"));
        }
        suffix = &suffix[value_start + token.len()..];
    }
    Ok(())
}

fn parse_tool_code(token: &str) -> Option<u32> {
    let trimmed = token.trim_start_matches('0');
    if trimmed.is_empty() {
        Some(0)
    } else {
        trimmed.parse::<u32>().ok()
    }
}

fn parse_g85_words(
    line: &str,
    unit: Unit,
    format: CoordinateFormat,
) -> Result<Option<(Option<CoordinateWords>, CoordinateWords)>, JsValue> {
    let Some(g85_index) = find_g_code_index(line, 85) else {
        return Ok(None);
    };
    let start_words = parse_coordinate_words(&line[..g85_index], unit, format)?;
    let suffix = &line[g85_index..];
    let suffix_sets = parse_coordinate_word_sets(suffix, unit, format)?;
    if suffix_sets.len() >= 2 && start_words.is_none() {
        return Ok(Some((Some(suffix_sets[0]), suffix_sets[1])));
    }
    if let Some(end_words) = suffix_sets.into_iter().next() {
        return Ok(Some((start_words, end_words)));
    }
    Ok(None)
}

fn zero_suppression_from_excellon_token(token: &str) -> Option<ZeroSuppression> {
    match token {
        "LZ" => Some(ZeroSuppression::Trailing),
        "TZ" => Some(ZeroSuppression::Leading),
        _ => None,
    }
}

fn parse_repeat_hole(
    line: &str,
    unit: Unit,
    format: CoordinateFormat,
) -> Result<Option<(u32, CoordinateWords)>, String> {
    let Some(rest) = line.strip_prefix('R') else {
        return Ok(None);
    };
    let digits_end = rest
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .map(|(index, ch)| index + ch.len_utf8())
        .last()
        .unwrap_or(0);
    if digits_end == 0 {
        return Ok(None);
    }
    if digits_end > 4 {
        return Err(format!(
            "Repeat drill count must be 1 to 4 digits in `{line}`"
        ));
    }

    let count = rest[..digits_end]
        .parse::<u32>()
        .map_err(|_| format!("Invalid repeat drill count in `{line}`"))?;
    if count == 0 {
        return Err(format!("Repeat drill count must be positive in `{line}`"));
    }
    let words = parse_repeat_hole_spacing(&rest[digits_end..], unit, format, line)?;

    Ok(Some((count, words)))
}

fn parse_repeat_hole_spacing(
    suffix: &str,
    unit: Unit,
    format: CoordinateFormat,
    line: &str,
) -> Result<CoordinateWords, String> {
    if suffix.is_empty() || !matches!(suffix.chars().next(), Some('X' | 'Y')) {
        return Err(format!(
            "Repeat drill record requires X or Y spacing in `{line}`"
        ));
    }

    let mut words = CoordinateWords::default();
    let mut index = 0;
    while index < suffix.len() {
        let word = suffix[index..].chars().next().unwrap_or_default();
        if !matches!(word, 'X' | 'Y') {
            return Err(format!(
                "Repeat drill record only supports X/Y spacing in `{line}`"
            ));
        }
        let value_start = index + word.len_utf8();
        let token = read_number(&suffix[value_start..], true)
            .ok_or_else(|| format!("Invalid repeat drill spacing in `{line}`"))?;
        let value = parse_coordinate_number(token, unit, format)
            .map_err(|_| format!("Invalid repeat drill spacing in `{line}`"))?;
        match word {
            'X' if words.x.is_none() => words.x = Some(value),
            'Y' if words.y.is_none() => words.y = Some(value),
            _ => {
                return Err(format!(
                    "Repeat drill record has duplicate spacing word in `{line}`"
                ));
            }
        }
        index = value_start + token.len();
    }

    Ok(words)
}

fn parse_coordinate_words(
    line: &str,
    unit: Unit,
    format: CoordinateFormat,
) -> Result<Option<CoordinateWords>, JsValue> {
    let x = parse_word_value(line, 'X', unit, format)?;
    let y = parse_word_value(line, 'Y', unit, format)?;
    let i = parse_word_value(line, 'I', unit, format)?;
    let j = parse_word_value(line, 'J', unit, format)?;
    let a = parse_word_value(line, 'A', unit, format)?;
    Ok(
        (x.is_some() || y.is_some() || i.is_some() || j.is_some() || a.is_some())
            .then_some(CoordinateWords { x, y, i, j, a }),
    )
}

fn parse_coordinate_word_sets(
    line: &str,
    unit: Unit,
    format: CoordinateFormat,
) -> Result<Vec<CoordinateWords>, JsValue> {
    let mut words = Vec::new();
    let mut current = CoordinateWords::default();
    let mut has_current = false;
    let mut index = 0;

    while index < line.len() {
        let Some((relative_index, word)) = line[index..]
            .char_indices()
            .find(|(_, ch)| matches!(ch, 'X' | 'Y' | 'I' | 'J' | 'A'))
        else {
            break;
        };
        index += relative_index;

        let starts_new_set = matches!(
            (word, current.x, current.y, current.i, current.j, current.a),
            ('X', Some(_), _, _, _, _)
                | ('Y', _, Some(_), _, _, _)
                | ('I', _, _, Some(_), _, _)
                | ('J', _, _, _, Some(_), _)
                | ('A', _, _, _, _, Some(_))
        );
        if starts_new_set && has_current {
            words.push(current);
            current = CoordinateWords::default();
        }

        let value_start = index + word.len_utf8();
        let token = read_number(&line[value_start..], true).ok_or_else(|| {
            JsValue::from_str(&format!("Invalid drill coordinate word {word} in `{line}`"))
        })?;
        let value = parse_coordinate_number(token, unit, format)?;
        match word {
            'X' => current.x = Some(value),
            'Y' => current.y = Some(value),
            'I' => current.i = Some(value),
            'J' => current.j = Some(value),
            'A' => current.a = Some(value),
            _ => {}
        }
        has_current = true;
        index = value_start + token.len();
    }

    if has_current {
        words.push(current);
    }

    Ok(words)
}

fn parse_word_value(
    line: &str,
    word: char,
    unit: Unit,
    format: CoordinateFormat,
) -> Result<Option<f32>, JsValue> {
    let Some(index) = line.find(word) else {
        return Ok(None);
    };
    let value_start = index + word.len_utf8();
    let token = read_number(&line[value_start..], true).ok_or_else(|| {
        JsValue::from_str(&format!("Invalid drill coordinate word {word} in `{line}`"))
    })?;

    Ok(Some(parse_coordinate_number(token, unit, format)?))
}

fn parse_coordinate_number(
    token: &str,
    unit: Unit,
    format: CoordinateFormat,
) -> Result<f32, JsValue> {
    parse_common_coordinate_number(token, format, unit.multiplier(), "drill")
        .map_err(|message| JsValue::from_str(&message))
}

fn parse_decimal_number(token: &str) -> Result<f32, JsValue> {
    parse_common_decimal_number(token, "drill").map_err(|message| JsValue::from_str(&message))
}

fn parse_format_token(token: &str) -> Result<Option<(u32, u32)>, JsValue> {
    let Some(dot_index) = token.find('.') else {
        return Ok(None);
    };
    let before = &token[..dot_index];
    let after = &token[dot_index + 1..];
    if before.is_empty() || after.is_empty() {
        return Ok(None);
    }

    if before.chars().all(|ch| ch == '0') && after.chars().all(|ch| ch == '0') {
        return Ok(Some((before.len() as u32, after.len() as u32)));
    }

    if before.chars().all(|ch| ch.is_ascii_digit()) && after.chars().all(|ch| ch.is_ascii_digit()) {
        let integer_digits = before
            .parse::<u32>()
            .map_err(|_| JsValue::from_str("Invalid drill coordinate format"))?;
        let decimal_digits = after
            .parse::<u32>()
            .map_err(|_| JsValue::from_str("Invalid drill coordinate format"))?;
        if integer_digits > 0 && decimal_digits > 0 {
            return Ok(Some((integer_digits, decimal_digits)));
        }
    }

    Ok(None)
}

fn arc_from_center_offset(
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    center_offset_x: f32,
    center_offset_y: f32,
    ccw: bool,
) -> Result<DrillArc, JsValue> {
    let center_x = start_x + center_offset_x;
    let center_y = start_y + center_offset_y;
    let radius = ((start_x - center_x).powi(2) + (start_y - center_y).powi(2)).sqrt();
    if radius <= 0.0 || !radius.is_finite() {
        return Err(JsValue::from_str(
            "Circular drill rout radius must be positive",
        ));
    }
    Ok(arc_from_center(
        start_x, start_y, end_x, end_y, center_x, center_y, radius, ccw,
    ))
}

fn arc_from_radius(
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    radius: f32,
    ccw: bool,
) -> Result<DrillArc, JsValue> {
    if radius <= 0.0 || !radius.is_finite() {
        return Err(JsValue::from_str(
            "Circular drill rout radius must be positive",
        ));
    }

    let dx = end_x - start_x;
    let dy = end_y - start_y;
    let chord = (dx * dx + dy * dy).sqrt();
    if chord <= f32::EPSILON {
        return Err(JsValue::from_str(
            "Circular drill rout with A radius requires different start and end points",
        ));
    }
    if chord > radius * 2.0 + 0.0001 {
        return Err(JsValue::from_str(
            "Circular drill rout radius is too small for its end points",
        ));
    }

    let midpoint_x = (start_x + end_x) * 0.5;
    let midpoint_y = (start_y + end_y) * 0.5;
    let height = (radius * radius - (chord * 0.5).powi(2)).max(0.0).sqrt();
    let perp_x = -dy / chord;
    let perp_y = dx / chord;
    let candidates = [
        (midpoint_x + perp_x * height, midpoint_y + perp_y * height),
        (midpoint_x - perp_x * height, midpoint_y - perp_y * height),
    ];

    candidates
        .into_iter()
        .map(|(center_x, center_y)| {
            arc_from_center(
                start_x, start_y, end_x, end_y, center_x, center_y, radius, ccw,
            )
        })
        .find(|arc| arc.sweep_angle.abs() <= std::f32::consts::PI + 0.0001)
        .ok_or_else(|| JsValue::from_str("Circular drill rout arc exceeds 180 degrees"))
}

fn arc_from_center(
    start_x: f32,
    start_y: f32,
    end_x: f32,
    end_y: f32,
    center_x: f32,
    center_y: f32,
    radius: f32,
    ccw: bool,
) -> DrillArc {
    let start_angle = (start_y - center_y).atan2(start_x - center_x);
    let end_angle = (end_y - center_y).atan2(end_x - center_x);
    let ccw_sweep = positive_angle_delta(end_angle - start_angle);
    let sweep_angle = if ccw {
        if ccw_sweep == 0.0 {
            TWO_PI
        } else {
            ccw_sweep
        }
    } else if ccw_sweep == 0.0 {
        -TWO_PI
    } else {
        ccw_sweep - TWO_PI
    };

    DrillArc {
        center_x,
        center_y,
        radius,
        start_angle,
        sweep_angle,
    }
}

fn positive_angle_delta(angle: f32) -> f32 {
    let mut normalized = angle % TWO_PI;
    if normalized < 0.0 {
        normalized += TWO_PI;
    }
    if normalized.abs() < 0.000001 {
        0.0
    } else {
        normalized
    }
}

fn angle_is_on_sweep(angle: f32, start_angle: f32, sweep_angle: f32) -> bool {
    let epsilon = 0.000001;
    if sweep_angle.abs() >= TWO_PI - epsilon {
        return true;
    }

    let delta = if sweep_angle >= 0.0 {
        positive_angle_delta(angle - start_angle)
    } else {
        positive_angle_delta(start_angle - angle)
    };
    delta <= sweep_angle.abs() + epsilon
}

#[cfg(test)]
mod tests;
