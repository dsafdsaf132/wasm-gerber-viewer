use super::geometry::Primitive;
use super::PolarityLayer;
use crate::geometry::PathRegions;
use crate::parser::common::{
    read_word_value, CoordinateFormat as CommonCoordinateFormat,
    ZeroSuppression as CommonZeroSuppression,
};
use std::cell::Cell;
use std::mem::take;

pub(crate) const MAX_STEP_REPEAT_COPIES: usize = 100_000;
pub(crate) const MAX_GENERATED_ITEMS: usize = 5_000_000;

/// Polarity - Dark (positive) or Clear (negative)
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Polarity {
    Positive, // Dark - add geometry
    Negative, // Clear - remove geometry
}

/// Format specification for coordinate conversion
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ZeroOmission {
    Leading,
    Trailing,
}

#[derive(Clone, Debug)]
pub struct FormatSpec {
    pub x_integer_digits: u32,
    pub x_decimal_digits: u32,
    pub y_integer_digits: u32,
    pub y_decimal_digits: u32,
    pub zero_omission: ZeroOmission,
    // Cached calculation values - performance optimization
    pub x_divisor: f64,      // 10^(x_decimal_digits)
    pub y_divisor: f64,      // 10^(y_decimal_digits)
    pub x_total_digits: i32, // x_integer_digits + x_decimal_digits
    pub y_total_digits: i32, // y_integer_digits + y_decimal_digits
}

impl Default for FormatSpec {
    fn default() -> Self {
        FormatSpec {
            x_integer_digits: 2,
            x_decimal_digits: 4,
            y_integer_digits: 2,
            y_decimal_digits: 4,
            zero_omission: ZeroOmission::Leading,
            x_divisor: 10000.0, // 10^4
            y_divisor: 10000.0, // 10^4
            x_total_digits: 6,  // 2 + 4
            y_total_digits: 6,  // 2 + 4
        }
    }
}

impl FormatSpec {
    pub fn coordinate_format(&self, axis: char) -> CommonCoordinateFormat {
        let (integer_digits, decimal_digits) = match axis {
            'x' | 'X' => (self.x_integer_digits, self.x_decimal_digits),
            'y' | 'Y' => (self.y_integer_digits, self.y_decimal_digits),
            _ => (0, 4),
        };

        CommonCoordinateFormat {
            integer_digits,
            decimal_digits,
            zero_suppression: match self.zero_omission {
                ZeroOmission::Leading => CommonZeroSuppression::Leading,
                ZeroOmission::Trailing => CommonZeroSuppression::Trailing,
            },
        }
    }
}

#[derive(Clone)]
pub struct ParserState {
    pub x: f32,
    pub y: f32,
    pub current_aperture: String,
    pub interpolation_mode: String,
    pub quadrant_mode: String,
    pub region_mode: bool,
    pub coordinate_mode: String,
    pub scale: f32,
    pub unit_multiplier: f32, // 1.0 for mm, 25.4 for inch
    pub i: f32,
    pub j: f32,
    pub pen_state: String,
    pub polarity: Polarity,
    pub format_spec: FormatSpec,
    // Step and Repeat settings
    pub sr_x: u32,
    pub sr_y: u32,
    pub sr_i: f32,
    pub sr_j: f32,
    // Layer Scaling
    pub layer_scale: f32,
    // Layer Mirroring
    pub mirror_x: bool,
    pub mirror_y: bool,
    // Layer Rotation
    pub layer_rotation: f32,
    generated_items: Cell<usize>,
}

impl Default for ParserState {
    fn default() -> Self {
        ParserState {
            x: 0.0,
            y: 0.0,
            current_aperture: String::new(),
            interpolation_mode: "linear".to_string(),
            quadrant_mode: "single".to_string(),
            region_mode: false,
            coordinate_mode: "absolute".to_string(),
            scale: 1.0,
            unit_multiplier: 1.0, // Default to mm
            i: 0.0,
            j: 0.0,
            pen_state: "up".to_string(),
            polarity: Polarity::Positive,
            format_spec: FormatSpec::default(),
            sr_x: 1,
            sr_y: 1,
            sr_i: 0.0,
            sr_j: 0.0,
            layer_scale: 1.0,
            mirror_x: false,
            mirror_y: false,
            layer_rotation: 0.0,
            generated_items: Cell::new(0),
        }
    }
}

impl ParserState {
    pub(crate) fn step_repeat_count(&self, context: &str) -> Result<usize, String> {
        let count = (self.sr_x as usize)
            .checked_mul(self.sr_y as usize)
            .ok_or_else(|| format!("Gerber {context} step-repeat count overflow"))?;
        if count > MAX_STEP_REPEAT_COPIES {
            return Err(format!(
                "Gerber {context} step-repeat count {count} exceeds the supported limit of {MAX_STEP_REPEAT_COPIES}"
            ));
        }
        Ok(count)
    }

    pub(crate) fn consume_generated_items(
        &self,
        additional: usize,
        context: &str,
    ) -> Result<(), String> {
        let next = self
            .generated_items
            .get()
            .checked_add(additional)
            .ok_or_else(|| format!("Gerber {context} generated geometry count overflow"))?;
        if next > MAX_GENERATED_ITEMS {
            return Err(format!(
                "Gerber generated geometry exceeds the supported limit of {MAX_GENERATED_ITEMS} items while processing {context}"
            ));
        }
        self.generated_items.set(next);
        Ok(())
    }

    pub(crate) fn generated_items(&self) -> usize {
        self.generated_items.get()
    }

    pub(crate) fn set_generated_items(&self, value: usize) {
        self.generated_items.set(value);
    }
}

/// Parse Format specification - %FSLAX24Y24*%
/// Format: %FS[L|T][A|I][X_int_digits][X_dec_digits][Y_int_digits][Y_dec_digits]*%
/// Example: %FSLAX24Y24*% = Leading, Absolute, 2 integer digits + 4 decimal digits
pub fn parse_format_spec(line: &str, state: &mut ParserState) {
    // Extract FSLAX24Y24 part from %FSLAX24Y24*% format
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("FS") {
        return;
    }

    let spec_content = &spec_str[2..]; // "LAX24Y24" part

    // Position tracking
    let mut pos = 0;
    let chars: Vec<char> = spec_content.chars().collect();

    if pos >= chars.len() {
        return;
    }

    // L/T: Leading (L) or Trailing (T) zero omission
    state.format_spec.zero_omission = if chars[pos] == 'T' {
        ZeroOmission::Trailing
    } else {
        ZeroOmission::Leading
    };
    pos += 1;

    if pos >= chars.len() {
        return;
    }

    // A/I: Absolute (A) or Incremental (I) mode
    let mode = chars[pos];
    pos += 1;

    // X coordinates format: X + digits
    if pos < chars.len() && chars[pos] == 'X' {
        pos += 1;
        if pos + 1 < chars.len() {
            if let (Ok(int_digits), Ok(dec_digits)) = (
                chars[pos].to_string().parse::<u32>(),
                chars[pos + 1].to_string().parse::<u32>(),
            ) {
                state.format_spec.x_integer_digits = int_digits;
                state.format_spec.x_decimal_digits = dec_digits;
            }
            pos += 2;
        }
    }

    // Y coordinates format: Y + digits
    if pos < chars.len() && chars[pos] == 'Y' {
        pos += 1;
        if pos + 1 < chars.len() {
            if let (Ok(int_digits), Ok(dec_digits)) = (
                chars[pos].to_string().parse::<u32>(),
                chars[pos + 1].to_string().parse::<u32>(),
            ) {
                state.format_spec.y_integer_digits = int_digits;
                state.format_spec.y_decimal_digits = dec_digits;
            }
        }
    }

    // Save mode
    if mode == 'I' {
        state.coordinate_mode = "incremental".to_string();
    } else {
        state.coordinate_mode = "absolute".to_string();
    }

    // Calculate cached values - performance optimization
    state.format_spec.x_divisor = 10_f64.powi(state.format_spec.x_decimal_digits as i32);
    state.format_spec.y_divisor = 10_f64.powi(state.format_spec.y_decimal_digits as i32);
    state.format_spec.x_total_digits =
        (state.format_spec.x_integer_digits + state.format_spec.x_decimal_digits) as i32;
    state.format_spec.y_total_digits =
        (state.format_spec.y_integer_digits + state.format_spec.y_decimal_digits) as i32;
}

/// Parse Step and Repeat - %SRX3Y2I10J20*%
/// Format: %SR[X count][Y count][I x_step][J y_step]*%
/// %SR* without parameters disables step and repeat
pub fn parse_sr(line: &str, state: &mut ParserState) -> Result<(), String> {
    // Extract SRX3Y2I10J20 part from %SRX3Y2I10J20*% format
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("SR") {
        return Ok(());
    }

    let spec_content = &spec_str[2..]; // "X3Y2I10J20" part

    // If no parameters, disable step and repeat (reset to default)
    if spec_content.is_empty() {
        state.sr_x = 1;
        state.sr_y = 1;
        state.sr_i = 0.0;
        state.sr_j = 0.0;
        return Ok(());
    }

    let parse_count = |word: char, current: u32| -> Result<u32, String> {
        let Some(raw) = read_word_value(spec_content, word, false) else {
            if spec_content.contains(word) {
                return Err(format!(
                    "Invalid Gerber step-repeat {word} count: missing numeric value"
                ));
            }
            return Ok(current);
        };
        let value = raw
            .parse::<u32>()
            .map_err(|_| format!("Invalid Gerber step-repeat {word} count `{raw}`"))?;
        if value == 0 {
            return Err(format!(
                "Gerber step-repeat {word} count must be at least 1"
            ));
        }
        Ok(value)
    };
    let parse_step = |word: char, current: f32| -> Result<f32, String> {
        let Some(raw) = read_word_value(spec_content, word, true) else {
            if spec_content.contains(word) {
                return Err(format!(
                    "Invalid Gerber step-repeat {word} distance: missing numeric value"
                ));
            }
            return Ok(current);
        };
        let value = raw
            .parse::<f32>()
            .map_err(|_| format!("Invalid Gerber step-repeat {word} distance `{raw}`"))?;
        if !value.is_finite() || value < 0.0 {
            return Err(format!(
                "Gerber step-repeat {word} distance must be finite and non-negative"
            ));
        }
        Ok(value * state.unit_multiplier)
    };

    let next_x = parse_count('X', state.sr_x)?;
    let next_y = parse_count('Y', state.sr_y)?;
    let next_i = parse_step('I', state.sr_i)?;
    let next_j = parse_step('J', state.sr_j)?;
    let repeat_count = (next_x as usize)
        .checked_mul(next_y as usize)
        .ok_or_else(|| "Gerber step-repeat count overflow".to_string())?;
    if repeat_count > MAX_STEP_REPEAT_COPIES {
        return Err(format!(
            "Gerber step-repeat count {repeat_count} exceeds the supported limit of {MAX_STEP_REPEAT_COPIES}"
        ));
    }

    state.sr_x = next_x;
    state.sr_y = next_y;
    state.sr_i = next_i;
    state.sr_j = next_j;
    Ok(())
}

/// Parse Polarity - %LPD* (positive) or %LPC* (negative)
/// Save the primitives accumulated so far each time the polarity changes
pub fn parse_lp(
    line: &str,
    state: &mut ParserState,
    current_primitives: &mut Vec<Primitive>,
    current_path_regions: &mut PathRegions,
    polarity_layers: &mut Vec<PolarityLayer>,
) -> Result<(), String> {
    // Extract D or C from %LPD* or %LPC* format
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("LP") {
        return Ok(());
    }

    let polarity_char = spec_str.chars().nth(2);

    let new_polarity = match polarity_char {
        Some('D') => Polarity::Positive, // Dark mode
        Some('C') => Polarity::Negative, // Clear mode
        _ => return Ok(()),
    };

    // Check if polarity has changed
    if state.polarity != new_polarity
        && (!current_primitives.is_empty()
            || current_path_regions.has_geometry_or_source_contours())
    {
        polarity_layers.try_reserve(1).map_err(|_| {
            "Gerber layer is too large to parse: not enough memory for polarity layer list"
                .to_string()
        })?;
        polarity_layers.push(PolarityLayer {
            polarity: state.polarity,
            primitives: take(current_primitives),
            path_regions: take(current_path_regions),
        });
    }

    // Set new polarity
    state.polarity = new_polarity;

    Ok(())
}

pub fn parse_if(line: &str, state: &mut ParserState) {
    // %IFPOS*% or %IFNEG*% format
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("IF") {
        return;
    }

    let polarity_str = &spec_str[2..]; // "POS" or "NEG" part

    let new_polarity = if polarity_str == "POS" {
        Polarity::Positive
    } else if polarity_str == "NEG" {
        Polarity::Negative
    } else {
        return;
    };

    state.polarity = new_polarity;
}

/// Parse Unit mode - %MOMM* (millimeters) or %MOIN* (inches)
pub fn parse_mo(line: &str, state: &mut ParserState) {
    // Extract MM or IN from %MOMM*% or %MOIN*% format
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("MO") {
        return;
    }

    let unit_str = &spec_str[2..]; // "MM" or "IN" part

    state.unit_multiplier = if unit_str == "MM" {
        1.0 // mm
    } else if unit_str == "IN" {
        25.4 // inch to mm
    } else {
        return;
    };
}

/// Parse Layer Scaling - %LS0.8*
/// Format: %LS[scale_factor]*%
/// Example: %LS0.5* scales subsequent aperture shapes by 0.5
pub fn parse_ls(line: &str, state: &mut ParserState) {
    // Extract scale value from %LS0.8*% format
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("LS") {
        return;
    }

    let scale_str = &spec_str[2..]; // "0.8" part

    if let Ok(new_scale) = scale_str.parse::<f32>() {
        if new_scale > 0.0 {
            state.layer_scale = new_scale;
        }
    }
}

/// Parse Layer Rotation - %LR90.0*%
/// Format: %LR[rotation_degrees]*%
/// Rotation is counterclockwise in degrees and replaces the previous value.
pub fn parse_lr(line: &str, state: &mut ParserState) {
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("LR") {
        return;
    }

    let rotation_str = &spec_str[2..];

    if let Ok(new_rotation) = rotation_str.parse::<f32>() {
        if new_rotation.is_finite() {
            state.layer_rotation = new_rotation.to_radians();
        }
    }
}

/// Parse Layer Mirroring - %LMN*%, %LMX*%, %LMY*%, %LMXY*%
/// Format: %LM[N|X|Y|XY]*%
/// - N: No mirroring (default)
/// - X: Mirror on X axis (x → -x)
/// - Y: Mirror on Y axis (y → -y)
/// - XY: Mirror on both axes (x → -x, y → -y)
pub fn parse_lm(line: &str, state: &mut ParserState) {
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("LM") {
        return;
    }

    let mirror_str = &spec_str[2..]; // "N", "X", "Y", or "XY" part

    match mirror_str {
        "N" => {
            state.mirror_x = false;
            state.mirror_y = false;
        }
        "X" => {
            state.mirror_x = true;
            state.mirror_y = false;
        }
        "Y" => {
            state.mirror_x = false;
            state.mirror_y = true;
        }
        "XY" => {
            state.mirror_x = true;
            state.mirror_y = true;
        }
        _ => {}
    }
}
