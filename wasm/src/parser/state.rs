use super::geometry::Primitive;
use super::PolarityLayer;
use crate::shape::PathRegions;
use std::mem::take;

/// Polarity - Dark (positive) or Clear (negative)
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Polarity {
    Positive, // Dark - add geometry
    Negative, // Clear - remove geometry
}

/// Format specification for coordinate conversion
#[derive(Clone, Debug)]
pub struct FormatSpec {
    pub x_integer_digits: u32,
    pub x_decimal_digits: u32,
    pub y_integer_digits: u32,
    pub y_decimal_digits: u32,
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
            x_divisor: 10000.0, // 10^4
            y_divisor: 10000.0, // 10^4
            x_total_digits: 6,  // 2 + 4
            y_total_digits: 6,  // 2 + 4
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
        }
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

    // L/T: Leading (L) or Trailing (T) zeros
    let _leading_type = chars[pos];
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
pub fn parse_sr(line: &str, state: &mut ParserState) {
    // Extract SRX3Y2I10J20 part from %SRX3Y2I10J20*% format
    let spec_str = line
        .trim_start_matches('%')
        .trim_end_matches('%')
        .trim_end_matches('*');

    if !spec_str.starts_with("SR") {
        return;
    }

    let spec_content = &spec_str[2..]; // "X3Y2I10J20" part

    // If no parameters, disable step and repeat (reset to default)
    if spec_content.is_empty() {
        state.sr_x = 1;
        state.sr_y = 1;
        state.sr_i = 0.0;
        state.sr_j = 0.0;
        return;
    }

    // Extract X count
    if let Some(x_pos) = spec_content.find('X') {
        let x_part = &spec_content[x_pos + 1..];
        let x_end = x_part
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(x_part.len());
        if let Ok(x_count) = x_part[..x_end].parse::<u32>() {
            state.sr_x = x_count;
        }
    }

    // Extract Y count
    if let Some(y_pos) = spec_content.find('Y') {
        let y_part = &spec_content[y_pos + 1..];
        let y_end = y_part
            .find(|c: char| !c.is_ascii_digit() && c != '-' && c != '+' && c != '.')
            .unwrap_or(y_part.len());
        if let Ok(y_count) = y_part[..y_end].parse::<u32>() {
            state.sr_y = y_count;
        }
    }

    // Extract I step (X direction spacing)
    if let Some(i_pos) = spec_content.find('I') {
        let i_part = &spec_content[i_pos + 1..];
        let i_end = i_part
            .find(|c: char| !c.is_ascii_digit() && c != '-' && c != '+' && c != '.')
            .unwrap_or(i_part.len());
        if let Ok(i_step) = i_part[..i_end].parse::<f32>() {
            state.sr_i = i_step * state.unit_multiplier;
        }
    }

    // Extract J step (Y direction spacing)
    if let Some(j_pos) = spec_content.find('J') {
        let j_part = &spec_content[j_pos + 1..];
        let j_end = j_part
            .find(|c: char| !c.is_ascii_digit() && c != '-' && c != '+' && c != '.')
            .unwrap_or(j_part.len());
        if let Ok(j_step) = j_part[..j_end].parse::<f32>() {
            state.sr_j = j_step * state.unit_multiplier;
        }
    }
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
        && (!current_primitives.is_empty() || current_path_regions.has_geometry())
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
