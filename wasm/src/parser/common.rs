#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ZeroSuppression {
    Leading,
    Trailing,
}

#[derive(Clone, Copy, Debug)]
pub struct CoordinateFormat {
    pub integer_digits: u32,
    pub decimal_digits: u32,
    pub zero_suppression: ZeroSuppression,
}

pub fn read_number(text: &str, allow_decimal: bool) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut end = 0;
    while end < bytes.len() {
        let b = bytes[end];
        if b.is_ascii_digit() || b == b'+' || b == b'-' || (allow_decimal && b == b'.') {
            end += 1;
        } else {
            break;
        }
    }

    (end > 0).then_some(&text[..end])
}

pub fn read_word_value(line: &str, word: char, allow_decimal: bool) -> Option<&str> {
    let index = line.find(word)?;
    read_number(&line[index + word.len_utf8()..], allow_decimal)
}

pub fn parse_g_code(line: &str) -> Option<u32> {
    let rest = line.strip_prefix('G')?;
    let bytes = rest.as_bytes();
    let mut end = 0;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == 0 {
        return None;
    }

    rest[..end].parse::<u32>().ok()
}

pub fn line_has_g_code(line: &str, code: u32) -> bool {
    line.char_indices()
        .filter(|(_, ch)| *ch == 'G')
        .any(|(index, _)| parse_g_code(&line[index..]) == Some(code))
}

pub fn find_g_code_index(line: &str, code: u32) -> Option<usize> {
    line.char_indices()
        .filter(|(_, ch)| *ch == 'G')
        .find_map(|(index, _)| (parse_g_code(&line[index..]) == Some(code)).then_some(index))
}

pub fn parse_decimal_number(token: &str, context: &str) -> Result<f32, String> {
    token
        .parse::<f32>()
        .map_err(|_| format!("Invalid {context} number `{token}`"))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CommandTokens<'a> {
    pub x: Option<&'a str>,
    pub y: Option<&'a str>,
    pub i: Option<&'a str>,
    pub j: Option<&'a str>,
    pub d: Option<&'a str>,
}

#[inline]
fn scan_coord<'a>(line: &'a str, bytes: &[u8], idx: &mut usize) -> Option<&'a str> {
    *idx += 1;
    let start = *idx;
    while *idx < bytes.len() {
        let b = bytes[*idx];
        if b.is_ascii_digit() || b == b'+' || b == b'-' || b == b'.' {
            *idx += 1;
        } else {
            break;
        }
    }
    (*idx > start).then(|| &line[start..*idx])
}

#[inline]
fn scan_digits<'a>(line: &'a str, bytes: &[u8], idx: &mut usize) -> Option<&'a str> {
    *idx += 1;
    let start = *idx;
    while *idx < bytes.len() && bytes[*idx].is_ascii_digit() {
        *idx += 1;
    }
    (*idx > start).then(|| &line[start..*idx])
}

/// Zero-allocation extractor for X, Y, I, J, D coordinate and action tokens.
/// Single linear pass over bytes, avoiding all heap allocations.
#[inline]
pub fn extract_command_tokens(line: &str) -> CommandTokens<'_> {
    let bytes = line.as_bytes();
    let len = bytes.len();
    let mut tokens = CommandTokens::default();
    let mut idx = 0;

    while idx < len {
        match bytes[idx] {
            b'X' if tokens.x.is_none() => tokens.x = scan_coord(line, bytes, &mut idx),
            b'Y' if tokens.y.is_none() => tokens.y = scan_coord(line, bytes, &mut idx),
            b'I' if tokens.i.is_none() => tokens.i = scan_coord(line, bytes, &mut idx),
            b'J' if tokens.j.is_none() => tokens.j = scan_coord(line, bytes, &mut idx),
            b'D' if tokens.d.is_none() => tokens.d = scan_digits(line, bytes, &mut idx),
            _ => idx += 1,
        }
    }

    tokens
}

pub fn parse_omitted_decimal_number(
    token: &str,
    format: CoordinateFormat,
    context: &str,
) -> Result<f32, String> {
    let sign = if token.starts_with('-') { -1.0 } else { 1.0 };
    let digits = token.trim_start_matches(['+', '-']);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("Invalid {context} number `{token}`"));
    }

    let mut value = 0i64;
    for b in digits.bytes() {
        value = value
            .checked_mul(10)
            .and_then(|v| v.checked_add((b - b'0') as i64))
            .ok_or_else(|| format!("Invalid {context} number `{token}` (integer overflow)"))?;
    }

    if let ZeroSuppression::Trailing = format.zero_suppression {
        let total_digits = (format.integer_digits + format.decimal_digits) as usize;
        if digits.len() < total_digits {
            let missing = (total_digits - digits.len()) as u32;
            let multiplier = 10_i64
                .checked_pow(missing)
                .ok_or_else(|| format!("Invalid {context} format specifier (missing digits too large)"))?;
            value = value
                .checked_mul(multiplier)
                .ok_or_else(|| format!("Invalid {context} number `{token}` (trailing padding overflow)"))?;
        }
    }

    let divisor = 10.0f32.powi(format.decimal_digits as i32);
    Ok(sign * value as f32 / divisor)
}

pub fn parse_coordinate_number(
    token: &str,
    format: CoordinateFormat,
    unit_multiplier: f32,
    context: &str,
) -> Result<f32, String> {
    let value = if token.contains('.') {
        parse_decimal_number(token, context)?
    } else {
        parse_omitted_decimal_number(token, format, context)?
    };

    Ok(value * unit_multiplier)
}

#[cfg(test)]
mod tests;
