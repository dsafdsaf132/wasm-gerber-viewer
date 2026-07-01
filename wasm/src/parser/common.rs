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
    let end = text
        .char_indices()
        .take_while(|(_, ch)| {
            ch.is_ascii_digit() || matches!(ch, '+' | '-') || (allow_decimal && *ch == '.')
        })
        .map(|(index, ch)| index + ch.len_utf8())
        .last()
        .unwrap_or(0);

    (end > 0).then_some(&text[..end])
}

pub fn read_word_value(line: &str, word: char, allow_decimal: bool) -> Option<&str> {
    let index = line.find(word)?;
    read_number(&line[index + word.len_utf8()..], allow_decimal)
}

pub fn parse_g_code(line: &str) -> Option<u32> {
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

pub fn parse_omitted_decimal_number(
    token: &str,
    format: CoordinateFormat,
    context: &str,
) -> Result<f32, String> {
    let sign = if token.starts_with('-') { -1.0 } else { 1.0 };
    let digits = token.trim_start_matches(['+', '-']);
    if digits.is_empty() || !digits.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(format!("Invalid {context} number `{token}`"));
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
        .map_err(|_| format!("Invalid {context} number `{token}`"))?;
    let divisor = 10_i64.pow(format.decimal_digits) as f32;
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
