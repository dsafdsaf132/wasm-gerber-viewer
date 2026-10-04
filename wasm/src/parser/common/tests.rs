// Large differential cases use stack buffers and a fixed seed.
use super::super::simd_scan::{
    count_stars_simd, find_star_simd, parse_decimal_digits, rfind_byte_simd,
};

fn next(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
}

fn digit_edges() -> u32 {
    let mut cases = 0;
    // All byte values, every digit position, and every alignment. In
    // particular, non-ASCII bytes must not wrap into a decimal digit.
    for len in 1..=20 {
        for alignment in 0..16 {
            let mut buffer = [b'0'; 64];
            for position in 0..len {
                for byte in 0..=255u8 {
                    buffer[alignment + position] = byte;
                    let input = &buffer[alignment..alignment + len];
                    let expected = if byte.is_ascii_digit() {
                        Some((byte - b'0') as u64).and_then(|digit| {
                            digit.checked_mul(10u64.checked_pow((len - position - 1) as u32)?)
                        })
                    } else {
                        None
                    };
                    assert_eq!(parse_decimal_digits(input), expected);
                    cases += 1;
                }
                buffer[alignment + position] = b'0';
            }
        }
    }
    for input in [
        "18446744073709551615",
        "18446744073709551616",
        "99999999999999999999",
        "000000000000000000001",
        "00018446744073709551615",
    ] {
        assert_eq!(
            parse_decimal_digits(input.as_bytes()),
            input.parse::<u64>().ok()
        );
        cases += 1;
    }
    cases
}

fn coordinate_matrix() -> u32 {
    let mut seed = 0x1234_5678_9abc_def0;
    let mut cases = 0;
    for len in 1..=18 {
        for _ in 0..2048 {
            let value = next(&mut seed) % 10u64.pow(len as u32);
            let mut token = [b'0'; 20];
            let mut remaining = value;
            for index in (1..=len).rev() {
                token[index] = b'0' + (remaining % 10) as u8;
                remaining /= 10;
            }
            for decimal_digits in [0, 4, 9, 10] {
                for suppression in [ZeroSuppression::Leading, ZeroSuppression::Trailing] {
                    let format = CoordinateFormat {
                        integer_digits: 18 - decimal_digits,
                        decimal_digits,
                        zero_suppression: suppression,
                    };
                    let padded = if suppression == ZeroSuppression::Trailing {
                        value.checked_mul(10u64.pow((18 - len) as u32))
                    } else {
                        Some(value)
                    };
                    for sign in [b' ', b'+', b'-'] {
                        token[0] = sign;
                        let input =
                            std::str::from_utf8(&token[usize::from(sign == b' ')..=len]).unwrap();
                        for unit in [1.0f32, 25.4] {
                            let actual =
                                parse_coordinate_number(input, format, unit, "test").unwrap();
                            let magnitude =
                                padded.unwrap() as f32 / 10f32.powi(decimal_digits as i32);
                            let expected = if sign == b'-' { -magnitude } else { magnitude } * unit;
                            assert_eq!(actual.to_bits(), expected.to_bits(), "{input}");
                            cases += 1;
                        }
                    }
                }
            }
        }
    }
    cases
}

fn coordinate_edges() -> u32 {
    let leading = CoordinateFormat {
        integer_digits: 8,
        decimal_digits: 4,
        zero_suppression: ZeroSuppression::Leading,
    };
    let trailing = CoordinateFormat {
        zero_suppression: ZeroSuppression::Trailing,
        ..leading
    };
    let mut cases = 0;
    for invalid in [
        "",
        "+",
        "-",
        "++12345678",
        "--12345678",
        "+-12345678",
        "1234-5678",
        "12345678x",
        " 12345678",
        "12345678 ",
        "１２３４５６７８",
        "1234567\0",
        "9223372036854775808",
        "-9223372036854775808",
        "18446744073709551615",
        "18446744073709551616",
    ] {
        assert!(
            parse_coordinate_number(invalid, leading, 1.0, "test").is_err(),
            "{invalid:?}"
        );
        cases += 1;
    }
    for input in [
        "0",
        "+0",
        "00000000",
        "+0000000000000000",
        "9223372036854775807",
    ] {
        let expected = input.parse::<i64>().unwrap() as f32 / 10000.0;
        assert_eq!(
            parse_coordinate_number(input, leading, 1.0, "test")
                .unwrap()
                .to_bits(),
            expected.to_bits()
        );
        cases += 1;
    }
    for input in ["-0", "-00000000", "-0000000000000000"] {
        assert_eq!(
            parse_coordinate_number(input, trailing, 25.4, "test")
                .unwrap()
                .to_bits(),
            (-0.0f32).to_bits()
        );
        cases += 1;
    }
    for input in ["1.25", "-1.25", "+0.125"] {
        assert_eq!(
            parse_coordinate_number(input, trailing, 25.4, "test")
                .unwrap()
                .to_bits(),
            (input.parse::<f32>().unwrap() * 25.4).to_bits()
        );
        cases += 1;
    }
    let padding_overflow = CoordinateFormat {
        integer_digits: 19,
        decimal_digits: 0,
        zero_suppression: ZeroSuppression::Trailing,
    };
    assert!(parse_coordinate_number("99", padding_overflow, 1.0, "test").is_err());
    cases + 1
}

fn large_delimiter_input() -> u32 {
    let mut input = [0u8; 65_536];
    let mut seed = 0xdead_beef_1234_5678;
    for byte in &mut input {
        *byte = next(&mut seed) as u8;
    }
    let mut cases = 0;
    for offset in 0..16 {
        for len in [0, 1, 15, 16, 17, 31, 32, 33, 255, 256, 257, 65_520] {
            let bytes = &input[offset..offset + len];
            assert_eq!(
                count_stars_simd(bytes),
                bytes.iter().filter(|&&b| b == b'*').count()
            );
            assert_eq!(find_star_simd(bytes), bytes.iter().position(|&b| b == b'*'));
            for target in [0, b'*', b'%', 255] {
                assert_eq!(
                    rfind_byte_simd(bytes, target),
                    bytes.iter().rposition(|&b| b == target)
                );
                cases += 1;
            }
            cases += 2;
        }
    }
    cases
}

#[test]
fn exhaustive_digit_edges() {
    digit_edges();
}
#[test]
fn large_coordinate_matrix() {
    coordinate_matrix();
}
#[test]
fn signed_coordinate_edges() {
    coordinate_edges();
}
#[test]
fn large_aligned_delimiter_inputs() {
    large_delimiter_input();
}

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

#[test]
fn extracts_command_tokens_accurately() {
    use super::{extract_command_tokens, CommandTokens};

    let line = "X1000Y-2000D01*";
    let tokens = extract_command_tokens(line);
    assert_eq!(
        tokens,
        CommandTokens {
            x: Some("1000"),
            y: Some("-2000"),
            i: None,
            j: None,
            d: Some("01"),
        }
    );

    let line2 = "G02X500Y600I100J-200D01*";
    let tokens2 = extract_command_tokens(line2);
    assert_eq!(
        tokens2,
        CommandTokens {
            x: Some("500"),
            y: Some("600"),
            i: Some("100"),
            j: Some("-200"),
            d: Some("01"),
        }
    );

    let line3 = "D02*";
    let tokens3 = extract_command_tokens(line3);
    assert_eq!(
        tokens3,
        CommandTokens {
            x: None,
            y: None,
            i: None,
            j: None,
            d: Some("02"),
        }
    );
}

#[test]
fn handles_numeric_overflow_gracefully() {
    let fmt = CoordinateFormat {
        integer_digits: 4,
        decimal_digits: 6,
        zero_suppression: ZeroSuppression::Leading,
    };
    // Huge digit string that exceeds i64::MAX
    let huge = "9999999999999999999999999999999999999999";
    assert!(super::parse_omitted_decimal_number(huge, fmt, "test").is_err());

    // Format spec with enormous missing digits that would overflow 10^missing
    let extreme_fmt = CoordinateFormat {
        integer_digits: 50,
        decimal_digits: 50,
        zero_suppression: ZeroSuppression::Trailing,
    };
    assert!(super::parse_omitted_decimal_number("123", extreme_fmt, "test").is_err());
}
