pub(crate) fn format_count(value: usize) -> String {
    let digits = value.to_string();
    let mut formatted = String::with_capacity(digits.len() + digits.len() / 3);
    let first_group_len = digits.len() % 3;

    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && index >= first_group_len && (index - first_group_len).is_multiple_of(3) {
            formatted.push(',');
        }
        formatted.push(ch);
    }

    formatted
}

pub(crate) fn format_bytes(bytes: usize) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let bytes = bytes as f64;

    if bytes >= GIB {
        format!("{:.1} GB", bytes / GIB)
    } else if bytes >= MIB {
        format!("{:.1} MB", bytes / MIB)
    } else if bytes >= KIB {
        format!("{:.1} KB", bytes / KIB)
    } else {
        format!("{} B", bytes as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::{format_bytes, format_count};

    #[test]
    fn count_formatting_groups_digits_without_underflow() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(12), "12");
        assert_eq!(format_count(123), "123");
        assert_eq!(format_count(1_234), "1,234");
        assert_eq!(format_count(12_345), "12,345");
        assert_eq!(format_count(123_456), "123,456");
        assert_eq!(format_count(24_000_000), "24,000,000");
    }

    #[test]
    fn byte_formatting_uses_binary_thresholds() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
        assert_eq!(format_bytes(1024 * 1024 * 1024), "1.0 GB");
    }
}
