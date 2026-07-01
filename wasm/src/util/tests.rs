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
