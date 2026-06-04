use crate::shape::{
    Arcs, Boundary, Circles, GerberData, Lines, PathRegions, Thermals, TriangleTemplateInstances,
    Triangles,
};
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

#[derive(Clone, Copy, Debug, PartialEq)]
enum ZeroSuppression {
    Leading,
    Trailing,
}

#[derive(Clone, Copy, Debug)]
struct CoordinateFormat {
    integer_digits: u32,
    decimal_digits: u32,
    zero_suppression: ZeroSuppression,
}

impl CoordinateFormat {
    fn new(unit: Unit) -> Self {
        Self {
            integer_digits: unit.default_integer_digits(),
            decimal_digits: unit.default_decimal_digits(),
            zero_suppression: ZeroSuppression::Leading,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Drill,
    Rout,
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

#[derive(Default, Debug)]
struct CoordinateWords {
    x: Option<f32>,
    y: Option<f32>,
    i: Option<f32>,
    j: Option<f32>,
    a: Option<f32>,
}

struct DrillParser {
    unit: Unit,
    coordinate_format: CoordinateFormat,
    mode: Mode,
    is_absolute: bool,
    routing_down: bool,
    current_tool: Option<u32>,
    current_x: f32,
    current_y: f32,
    tools: BTreeMap<u32, Tool>,
    fill: DrillGeometry,
    outline: DrillGeometry,
    outline_width_mm: f32,
    offset_x: f32,
    offset_y: f32,
}

impl DrillParser {
    fn new(outline_width_mm: f32, offset_x: f32, offset_y: f32) -> Result<Self, JsValue> {
        if !offset_x.is_finite() || !offset_y.is_finite() {
            return Err(JsValue::from_str("Drill layer offset must be finite"));
        }

        Ok(Self {
            unit: Unit::Metric,
            coordinate_format: CoordinateFormat::new(Unit::Metric),
            mode: Mode::Drill,
            is_absolute: true,
            routing_down: false,
            current_tool: None,
            current_x: 0.0,
            current_y: 0.0,
            tools: BTreeMap::new(),
            fill: DrillGeometry::new(),
            outline: DrillGeometry::new(),
            outline_width_mm: outline_width_mm.max(0.0),
            offset_x,
            offset_y,
        })
    }

    fn parse(mut self, content: &str) -> Result<DrillParseResult, JsValue> {
        for raw_line in content.lines() {
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

        if let Some(code) = parse_tool_selection(line) {
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
            if let Some(words) = parse_coordinate_words(line, self.unit, self.coordinate_format)? {
                let (x, y) = self.resolve_xy(words.x, words.y);
                self.current_x = x;
                self.current_y = y;
            }
            return Ok(());
        }

        if g_code == Some(1) {
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

        if g_code == Some(85) {
            let word_sets = parse_coordinate_word_sets(line, self.unit, self.coordinate_format)?;
            if word_sets.is_empty() {
                return Ok(());
            }
            let (start_x, start_y, end_words) = if word_sets.len() >= 2 {
                let (start_x, start_y) = self.resolve_xy(word_sets[0].x, word_sets[0].y);
                (start_x, start_y, &word_sets[1])
            } else {
                (self.current_x, self.current_y, &word_sets[0])
            };
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
            let Some(words) = parse_coordinate_words(line, self.unit, self.coordinate_format)?
            else {
                return Ok(());
            };
            let (end_x, end_y) = self.resolve_xy(words.x, words.y);
            if self.mode == Mode::Rout && self.routing_down {
                self.push_arc(end_x, end_y, words, g_code == Some(3))?;
            }
            self.current_x = end_x;
            self.current_y = end_y;
            return Ok(());
        }

        if let Some(words) = parse_coordinate_words(line, self.unit, self.coordinate_format)? {
            let (x, y) = self.resolve_xy(words.x, words.y);
            if self.mode == Mode::Drill {
                self.push_hit(x, y)?;
            } else if self.mode == Mode::Rout && self.routing_down {
                self.push_slot(x, y)?;
            }
            self.current_x = x;
            self.current_y = y;
        }

        Ok(())
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
        let mut format = CoordinateFormat::new(unit);
        for token in line.split(',').skip(1) {
            match token {
                "LZ" => format.zero_suppression = ZeroSuppression::Leading,
                "TZ" => format.zero_suppression = ZeroSuppression::Trailing,
                _ => {
                    if let Some((integer_digits, decimal_digits)) = parse_format_token(token)? {
                        format.integer_digits = integer_digits;
                        format.decimal_digits = decimal_digits;
                    }
                }
            }
        }
        self.coordinate_format = format;
        Ok(())
    }

    fn set_unit_code(&mut self, unit: Unit) {
        if self.unit != unit {
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
        if let Some(tool) = self.tools.get_mut(&code) {
            tool.hit_count = tool.hit_count.saturating_add(1);
        }
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
    DrillParser::new(outline_width_mm, offset_x, offset_y)?.parse(content)
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

fn parse_tool_declaration(line: &str, unit: Unit) -> Result<Option<(u32, f32)>, JsValue> {
    if !line.starts_with('T') || !line.contains('C') {
        return Ok(None);
    }

    let c_index = line
        .find('C')
        .ok_or_else(|| JsValue::from_str("Invalid drill tool declaration"))?;
    let code = parse_tool_code(&line[1..c_index])
        .ok_or_else(|| JsValue::from_str("Invalid drill tool number"))?;
    let diameter_token = read_number(&line[c_index + 1..])
        .ok_or_else(|| JsValue::from_str("Invalid drill tool diameter"))?;
    let diameter = parse_decimal_number(diameter_token)? * unit.multiplier();
    if diameter <= 0.0 || !diameter.is_finite() {
        return Err(JsValue::from_str("Drill tool diameter must be positive"));
    }

    Ok(Some((code, diameter)))
}

fn parse_tool_selection(line: &str) -> Option<u32> {
    let line = line.strip_prefix("G54").unwrap_or(line);
    if !line.starts_with('T') || line.len() < 2 {
        return None;
    }

    line[1..]
        .chars()
        .all(|ch| ch.is_ascii_digit())
        .then(|| parse_tool_code(&line[1..]))
        .flatten()
}

fn parse_tool_code(token: &str) -> Option<u32> {
    let trimmed = token.trim_start_matches('0');
    if trimmed.is_empty() {
        Some(0)
    } else {
        trimmed.parse::<u32>().ok()
    }
}

fn parse_g_code(line: &str) -> Option<u32> {
    let rest = line.strip_prefix('G')?;
    let digits_end = rest
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit())
        .map(|(index, ch)| index + ch.len_utf8())
        .last()
        .unwrap_or(0);
    if digits_end == 0 {
        return None;
    }

    rest[..digits_end].parse::<u32>().ok()
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
        let token = read_number(&line[value_start..]).ok_or_else(|| {
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
    let token = read_number(&line[value_start..]).ok_or_else(|| {
        JsValue::from_str(&format!("Invalid drill coordinate word {word} in `{line}`"))
    })?;

    Ok(Some(parse_coordinate_number(token, unit, format)?))
}

fn read_number(text: &str) -> Option<&str> {
    let end = text
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit() || matches!(ch, '.' | '+' | '-'))
        .map(|(index, ch)| index + ch.len_utf8())
        .last()
        .unwrap_or(0);

    (end > 0).then_some(&text[..end])
}

fn parse_coordinate_number(
    token: &str,
    unit: Unit,
    format: CoordinateFormat,
) -> Result<f32, JsValue> {
    let value = if token.contains('.') {
        parse_decimal_number(token)?
    } else {
        parse_omitted_decimal_number(token, format)?
    };

    Ok(value * unit.multiplier())
}

fn parse_decimal_number(token: &str) -> Result<f32, JsValue> {
    token
        .parse::<f32>()
        .map_err(|_| JsValue::from_str(&format!("Invalid drill number `{token}`")))
}

fn parse_omitted_decimal_number(token: &str, format: CoordinateFormat) -> Result<f32, JsValue> {
    let sign = if token.starts_with('-') { -1.0 } else { 1.0 };
    let digits = token.trim_start_matches(['+', '-']);
    if digits.is_empty() || !digits.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(JsValue::from_str(&format!(
            "Invalid drill number `{token}`"
        )));
    }

    let value_token = match format.zero_suppression {
        ZeroSuppression::Leading => digits.to_string(),
        ZeroSuppression::Trailing => {
            let total_digits = (format.integer_digits + format.decimal_digits) as usize;
            if digits.len() >= total_digits {
                digits.to_string()
            } else {
                format!("{digits:0<total_digits$}")
            }
        }
    };
    let value = value_token
        .parse::<i64>()
        .map_err(|_| JsValue::from_str(&format!("Invalid drill number `{token}`")))?;
    let divisor = 10_i64.pow(format.decimal_digits) as f32;
    Ok(sign * value as f32 / divisor)
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
mod tests {
    use super::parse_drill_with_offset;

    fn assert_approx_eq(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.0001,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn parses_xnc_drill_hits_and_metadata() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.6
T02C0.8
%
G05
T01
X9.01Y3.3375
X9.01Y4.3125
T02
X8.01Y4.8
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("XNC drill file should parse");

        assert_eq!(parsed.fill_layer.circles.x.len(), 3);
        assert_eq!(parsed.metadata.hit_count, 3);
        assert_eq!(parsed.metadata.tools.len(), 2);
        assert_approx_eq(parsed.fill_layer.circles.radius[0], 0.3);
        assert_approx_eq(parsed.outline_layer.circles.radius[0], 0.35);
    }

    #[test]
    fn parses_xnc_linear_rout_as_slot() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.8
%
T01
G00X8.01Y3.825
M15
G01X6.54Y3.825
M16
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("XNC rout file should parse");

        assert_eq!(parsed.fill_layer.circles.x.len(), 2);
        assert_eq!(parsed.outline_layer.circles.x.len(), 2);
        assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
        assert_eq!(parsed.metadata.slot_count, 1);
        assert_approx_eq(parsed.fill_layer.lines.width[0], 0.8);
        assert_approx_eq(parsed.outline_layer.lines.width[0], 0.9);
    }

    #[test]
    fn parses_g85_as_slot_from_current_position() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.8
%
T01
X1.0Y2.0
G85X4.0Y2.0
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("G85 slot command should parse");

        assert_eq!(parsed.fill_layer.circles.x.len(), 3);
        assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
        assert_eq!(parsed.metadata.hit_count, 1);
        assert_eq!(parsed.metadata.slot_count, 1);
        assert_approx_eq(parsed.fill_layer.lines.start_x[0], 1.0);
        assert_approx_eq(parsed.fill_layer.lines.start_y[0], 2.0);
        assert_approx_eq(parsed.fill_layer.lines.end_x[0], 4.0);
        assert_approx_eq(parsed.fill_layer.lines.end_y[0], 2.0);
        assert_approx_eq(parsed.fill_layer.lines.width[0], 0.8);
    }

    #[test]
    fn parses_inline_g85_start_and_end_coordinates() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.8
%
T01
G85X1.0Y2.0X4.0Y2.0
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("Inline G85 slot endpoints should parse");

        assert_eq!(parsed.fill_layer.circles.x.len(), 2);
        assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
        assert_eq!(parsed.metadata.hit_count, 0);
        assert_eq!(parsed.metadata.slot_count, 1);
        assert_approx_eq(parsed.fill_layer.lines.start_x[0], 1.0);
        assert_approx_eq(parsed.fill_layer.lines.start_y[0], 2.0);
        assert_approx_eq(parsed.fill_layer.lines.end_x[0], 4.0);
        assert_approx_eq(parsed.fill_layer.lines.end_y[0], 2.0);
    }

    #[test]
    fn parses_short_g_rout_commands_as_slot() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.8
%
T01
G0X8.01Y3.825
M15
G1X6.54Y3.825
M16
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("Short Excellon rout commands should parse");

        assert_eq!(parsed.fill_layer.circles.x.len(), 2);
        assert_eq!(parsed.fill_layer.lines.start_x.len(), 1);
        assert_eq!(parsed.metadata.hit_count, 0);
        assert_eq!(parsed.metadata.slot_count, 1);
        assert_approx_eq(parsed.fill_layer.lines.start_x[0], 8.01);
        assert_approx_eq(parsed.fill_layer.lines.end_x[0], 6.54);
    }

    #[test]
    fn accepts_g54_prefixed_tool_selection() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.6
%
G54T01
X9.0Y3.0
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("G54-prefixed tool selection should parse");

        assert_eq!(parsed.fill_layer.circles.x.len(), 1);
        assert_eq!(parsed.metadata.hit_count, 1);
        assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
    }

    #[test]
    fn preserves_modal_rout_coordinate_moves() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.8
%
T01
G00X1.0Y1.0
M15
G01X2.0Y1.0
X3.0Y1.0
M16
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("Modal coordinate-only rout move should parse as a slot");

        assert_eq!(parsed.fill_layer.circles.x.len(), 4);
        assert_eq!(parsed.fill_layer.lines.start_x.len(), 2);
        assert_eq!(parsed.metadata.hit_count, 0);
        assert_eq!(parsed.metadata.slot_count, 2);
        assert_approx_eq(parsed.fill_layer.lines.start_x[0], 1.0);
        assert_approx_eq(parsed.fill_layer.lines.end_x[0], 2.0);
        assert_approx_eq(parsed.fill_layer.lines.start_x[1], 2.0);
        assert_approx_eq(parsed.fill_layer.lines.end_x[1], 3.0);
    }

    #[test]
    fn routes_g01_after_m15_without_prior_g00() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.8
%
T01
M15
G01X2.0Y1.0
X3.0Y1.0
M16
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("G01 after M15 should start a routed slot");

        assert_eq!(parsed.fill_layer.circles.x.len(), 4);
        assert_eq!(parsed.fill_layer.lines.start_x.len(), 2);
        assert_eq!(parsed.metadata.hit_count, 0);
        assert_eq!(parsed.metadata.slot_count, 2);
        assert_approx_eq(parsed.fill_layer.lines.start_x[0], 0.0);
        assert_approx_eq(parsed.fill_layer.lines.end_x[0], 2.0);
        assert_approx_eq(parsed.fill_layer.lines.start_x[1], 2.0);
        assert_approx_eq(parsed.fill_layer.lines.end_x[1], 3.0);
    }

    #[test]
    fn incremental_coordinates_keep_omitted_axis_current() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.6
%
T01
X10.0Y10.0
G91
X1.0
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("Incremental omitted axes should preserve current coordinate");

        assert_eq!(parsed.fill_layer.circles.x.len(), 2);
        assert_approx_eq(parsed.fill_layer.circles.x[0], 10.0);
        assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
        assert_approx_eq(parsed.fill_layer.circles.x[1], 11.0);
        assert_approx_eq(parsed.fill_layer.circles.y[1], 10.0);
    }

    #[test]
    fn treats_t00_as_tool_unload() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.6
%
T01
X9.0Y3.0
T00
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("T00 should unload the current drill tool");

        assert_eq!(parsed.fill_layer.circles.x.len(), 1);
        assert_eq!(parsed.metadata.hit_count, 1);
    }

    #[test]
    fn honors_trailing_zero_suppressed_metric_coordinates() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC,TZ
T01C0.6
%
T01
X009Y010
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("METRIC,TZ omitted-decimal coordinates should parse");

        assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
        assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
    }

    #[test]
    fn ignores_fmat_and_preserves_tz_after_m71() {
        let parsed = parse_drill_with_offset(
            "\
M48
FMAT,2
METRIC,TZ
T01C0.6
%
M71
T01
X009Y010
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("LibrePCB-style drill header should parse");

        assert_eq!(parsed.fill_layer.circles.x.len(), 1);
        assert_approx_eq(parsed.fill_layer.circles.x[0], 9.0);
        assert_approx_eq(parsed.fill_layer.circles.y[0], 10.0);
    }

    #[test]
    fn parses_xnc_circular_rout_as_arc() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C0.8
%
T01
G00X5.05Y2.6
M15
G03X6.0Y1.6A1.0
M16
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("XNC circular rout should parse as analytic arc");

        assert_eq!(parsed.fill_layer.lines.start_x.len(), 0);
        assert_eq!(parsed.fill_layer.arcs.x.len(), 1);
        assert_eq!(parsed.metadata.slot_count, 1);
        assert_approx_eq(parsed.fill_layer.arcs.radius[0], 1.0);
        assert_approx_eq(parsed.fill_layer.arcs.thickness[0], 0.8);
    }

    #[test]
    fn routed_arc_bounds_follow_sweep() {
        let parsed = parse_drill_with_offset(
            "\
M48
METRIC
T01C1.0
%
T01
G00X10.0Y0.0
M15
G03X0.0Y10.0I-10.0J0.0
M16
M30",
            0.05,
            0.0,
            0.0,
        )
        .expect("Routed arc should parse");

        assert_eq!(parsed.fill_layer.arcs.x.len(), 1);
        assert_approx_eq(parsed.fill_layer.boundary.min_x, -0.5);
        assert_approx_eq(parsed.fill_layer.boundary.max_x, 10.5);
        assert_approx_eq(parsed.fill_layer.boundary.min_y, -0.5);
        assert_approx_eq(parsed.fill_layer.boundary.max_y, 10.5);
    }
}
