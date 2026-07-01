use super::{
    find_g_code_index, line_has_g_code, parse_coordinate_number, parse_g_code, read_number,
    read_word_value, CoordinateFormat, ZeroSuppression,
};

#[test]
fn parses_g_code_words() {
    assert_eq!(parse_g_code("G03X1Y2"), Some(3));
    assert_eq!(parse_g_code("G85X1Y2"), Some(85));
    assert_eq!(parse_g_code("X1Y2"), None);
    assert_eq!(find_g_code_index("X1G85Y2", 85), Some(2));
    assert!(line_has_g_code("G00X1G85Y2", 85));
}

#[test]
fn reads_coordinate_number_tokens() {
    assert_eq!(read_number("-12.340Y1", true), Some("-12.340"));
    assert_eq!(read_number("-12340Y1", false), Some("-12340"));
    assert_eq!(read_word_value("X-10.5Y2", 'X', true), Some("-10.5"));
    assert_eq!(read_word_value("X-10.5Y2", 'Y', true), Some("2"));
}

#[test]
fn parses_zero_suppressed_coordinates() {
    let leading = CoordinateFormat {
        integer_digits: 3,
        decimal_digits: 3,
        zero_suppression: ZeroSuppression::Leading,
    };
    let trailing = CoordinateFormat {
        integer_digits: 3,
        decimal_digits: 3,
        zero_suppression: ZeroSuppression::Trailing,
    };

    assert_eq!(
        parse_coordinate_number("009", leading, 1.0, "test").unwrap(),
        0.009
    );
    assert_eq!(
        parse_coordinate_number("009", trailing, 1.0, "test").unwrap(),
        9.0
    );
    assert_eq!(
        parse_coordinate_number("1.5", leading, 25.4, "test").unwrap(),
        38.1
    );
}
