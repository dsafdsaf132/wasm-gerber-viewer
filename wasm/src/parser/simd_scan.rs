//! SIMD-accelerated byte scanning for delimiter search and command counting.

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::*;

#[cfg(all(target_arch = "wasm64", target_feature = "simd128"))]
use core::arch::wasm64::*;

#[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
use core::arch::x86_64::*;

/// Count occurrences of `b'*'` in `data` using 16-byte SIMD chunk scanning.
#[inline]
pub fn count_stars_simd(data: &[u8]) -> usize {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        count_stars_wasm(data)
    }
    #[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
    {
        count_stars_x86(data)
    }
    #[cfg(not(any(
        all(target_arch = "wasm32", target_feature = "simd128"),
        all(target_arch = "x86_64", target_feature = "sse2")
    )))]
    {
        count_stars_scalar(data)
    }
}

/// Find index of the first occurrence of `b'*'` in `data` using 16-byte SIMD chunk scanning.
#[inline]
pub fn find_star_simd(data: &[u8]) -> Option<usize> {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        find_star_wasm(data)
    }
    #[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
    {
        find_star_x86(data)
    }
    #[cfg(not(any(
        all(target_arch = "wasm32", target_feature = "simd128"),
        all(target_arch = "x86_64", target_feature = "sse2")
    )))]
    {
        find_star_scalar(data)
    }
}

/// Find index of the last occurrence of `target` byte in `data` scanning backwards using SIMD.
#[inline]
pub fn rfind_byte_simd(data: &[u8], target: u8) -> Option<usize> {
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        rfind_byte_wasm(data, target)
    }
    #[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
    {
        rfind_byte_x86(data, target)
    }
    #[cfg(not(any(
        all(target_arch = "wasm32", target_feature = "simd128"),
        all(target_arch = "x86_64", target_feature = "sse2")
    )))]
    {
        rfind_byte_scalar(data, target)
    }
}

#[inline]
fn count_stars_scalar(data: &[u8]) -> usize {
    data.iter().filter(|&&b| b == b'*').count()
}

#[inline]
fn find_star_scalar(data: &[u8]) -> Option<usize> {
    data.iter().position(|&b| b == b'*')
}

#[inline]
fn rfind_byte_scalar(data: &[u8], target: u8) -> Option<usize> {
    data.iter().rposition(|&b| b == target)
}

/// Parse up to 16 ASCII decimal digits. On wasm SIMD targets validation and
/// decimal-pair formation are vectorized; the final small reduction stays
/// scalar. The padded load is always exactly 16 readable stack bytes, on both
/// wasm32 and wasm64.
#[inline]
pub(crate) fn parse_decimal_digits(data: &[u8]) -> Option<u64> {
    // Gerber coordinates are commonly only 5–7 digits. For those, the SIMD
    // setup and stack padding cost more than the small scalar fold.
    if data.len() < 8 || data.len() > 16 {
        return parse_decimal_digits_scalar(data);
    }

    #[cfg(all(
        any(target_arch = "wasm32", target_arch = "wasm64"),
        target_feature = "simd128"
    ))]
    {
        parse_decimal_digits_wasm(data)
    }

    #[cfg(not(all(
        any(target_arch = "wasm32", target_arch = "wasm64"),
        target_feature = "simd128"
    )))]
    {
        parse_decimal_digits_scalar(data)
    }
}

#[inline]
fn parse_decimal_digits_scalar(data: &[u8]) -> Option<u64> {
    let mut value = 0u64;
    // At most 18 decimal digits fit in u64; avoid overflow checks on the
    // common short-coordinate path.
    if data.len() <= 18 {
        for &byte in data {
            let digit = byte.wrapping_sub(b'0');
            if digit > 9 {
                return None;
            }
            value = value * 10 + digit as u64;
        }
        return Some(value);
    }
    for &byte in data {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((byte - b'0') as u64)?;
    }
    Some(value)
}

#[cfg(all(
    any(target_arch = "wasm32", target_arch = "wasm64"),
    target_feature = "simd128"
))]
#[inline]
fn parse_decimal_digits_wasm(data: &[u8]) -> Option<u64> {
    let bytes = if data.len() == 8 {
        unsafe {
            v128_or(
                v128_load64_zero(data.as_ptr().cast::<u64>()),
                u64x2(0, 0x3030_3030_3030_3030),
            )
        }
    } else {
        let mut padded = [b'0'; 16];
        padded[16 - data.len()..].copy_from_slice(data);
        unsafe { v128_load(padded.as_ptr().cast::<v128>()) }
    };

    let digits = u8x16_sub(bytes, u8x16_splat(b'0'));
    if u8x16_bitmask(u8x16_gt(digits, u8x16_splat(9))) != 0 {
        return None;
    }

    // Widen the low eight digits and form 2-digit groups in parallel:
    // 10*a + b. The vector width and grouping are identical for wasm32/64.
    let factors = u16x8(10, 1, 10, 1, 10, 1, 10, 1);
    let high_digits = u16x8_extend_low_u8x16(digits);
    let high_pairs = u32x4_extadd_pairwise_u16x8(u16x8_mul(high_digits, factors));
    let high_weighted = u32x4_mul(high_pairs, u32x4(1_000_000, 10_000, 100, 1));
    let high = u32x4_extract_lane::<0>(high_weighted)
        + u32x4_extract_lane::<1>(high_weighted)
        + u32x4_extract_lane::<2>(high_weighted)
        + u32x4_extract_lane::<3>(high_weighted);

    if data.len() <= 8 {
        return Some(high as u64);
    }

    // Memory64 still uses the same 128-bit lanes; only the address and
    // slice indices above are pointer-width-sized (usize).
    let low_digits = u16x8_extend_high_u8x16(digits);
    let low_pairs = u32x4_extadd_pairwise_u16x8(u16x8_mul(low_digits, factors));
    let low_weighted = u32x4_mul(low_pairs, u32x4(1_000_000, 10_000, 100, 1));
    let low = u32x4_extract_lane::<0>(low_weighted)
        + u32x4_extract_lane::<1>(low_weighted)
        + u32x4_extract_lane::<2>(low_weighted)
        + u32x4_extract_lane::<3>(low_weighted);
    Some(high as u64 * 100_000_000 + low as u64)
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn count_stars_wasm(data: &[u8]) -> usize {
    let chunks = data.len() / 16;
    let mut count = 0usize;
    let star_v = u8x16_splat(b'*');
    let ptr = data.as_ptr();

    for i in 0..chunks {
        unsafe {
            let chunk = v128_load(ptr.add(i * 16) as *const v128);
            let eq = u8x16_eq(chunk, star_v);
            let mask = u8x16_bitmask(eq);
            count += mask.count_ones() as usize;
        }
    }

    let remainder = chunks * 16;
    if remainder < data.len() {
        count += count_stars_scalar(&data[remainder..]);
    }

    count
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn find_star_wasm(data: &[u8]) -> Option<usize> {
    let chunks = data.len() / 16;
    let star_v = u8x16_splat(b'*');
    let ptr = data.as_ptr();

    for i in 0..chunks {
        let mask = unsafe {
            let chunk = v128_load(ptr.add(i * 16) as *const v128);
            let eq = u8x16_eq(chunk, star_v);
            u8x16_bitmask(eq)
        };
        if mask != 0 {
            return Some(i * 16 + mask.trailing_zeros() as usize);
        }
    }

    let remainder = chunks * 16;
    find_star_scalar(&data[remainder..]).map(|pos| remainder + pos)
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn rfind_byte_wasm(data: &[u8], target: u8) -> Option<usize> {
    let chunks = data.len() / 16;
    let target_v = u8x16_splat(target);
    let ptr = data.as_ptr();

    let remainder = chunks * 16;
    if remainder < data.len() {
        if let Some(pos) = rfind_byte_scalar(&data[remainder..], target) {
            return Some(remainder + pos);
        }
    }

    for i in (0..chunks).rev() {
        let mask = unsafe {
            let chunk = v128_load(ptr.add(i * 16) as *const v128);
            let eq = u8x16_eq(chunk, target_v);
            u8x16_bitmask(eq)
        };
        if mask != 0 {
            let bit_pos = 31 - (mask as u32).leading_zeros() as usize;
            return Some(i * 16 + bit_pos);
        }
    }

    None
}

#[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
#[inline]
fn count_stars_x86(data: &[u8]) -> usize {
    let chunks = data.len() / 16;
    let mut count = 0usize;
    unsafe {
        let star_v = _mm_set1_epi8(b'*' as i8);
        let ptr = data.as_ptr();

        for i in 0..chunks {
            let chunk = _mm_loadu_si128(ptr.add(i * 16) as *const __m128i);
            let eq = _mm_cmpeq_epi8(chunk, star_v);
            let mask = _mm_movemask_epi8(eq) as u32;
            count += mask.count_ones() as usize;
        }
    }

    let remainder = chunks * 16;
    if remainder < data.len() {
        count += count_stars_scalar(&data[remainder..]);
    }

    count
}

#[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
#[inline]
fn find_star_x86(data: &[u8]) -> Option<usize> {
    let chunks = data.len() / 16;
    let ptr = data.as_ptr();

    unsafe {
        let star_v = _mm_set1_epi8(b'*' as i8);
        for i in 0..chunks {
            let chunk = _mm_loadu_si128(ptr.add(i * 16) as *const __m128i);
            let eq = _mm_cmpeq_epi8(chunk, star_v);
            let mask = _mm_movemask_epi8(eq) as u32;
            if mask != 0 {
                return Some(i * 16 + mask.trailing_zeros() as usize);
            }
        }
    }

    let remainder = chunks * 16;
    find_star_scalar(&data[remainder..]).map(|pos| remainder + pos)
}

#[cfg(all(target_arch = "x86_64", target_feature = "sse2"))]
#[inline]
fn rfind_byte_x86(data: &[u8], target: u8) -> Option<usize> {
    let chunks = data.len() / 16;
    let ptr = data.as_ptr();

    let remainder = chunks * 16;
    if remainder < data.len() {
        if let Some(pos) = rfind_byte_scalar(&data[remainder..], target) {
            return Some(remainder + pos);
        }
    }

    unsafe {
        let target_v = _mm_set1_epi8(target as i8);
        for i in (0..chunks).rev() {
            let chunk = _mm_loadu_si128(ptr.add(i * 16) as *const __m128i);
            let eq = _mm_cmpeq_epi8(chunk, target_v);
            let mask = _mm_movemask_epi8(eq) as u32;
            if mask != 0 {
                let bit_pos = 31 - mask.leading_zeros() as usize;
                return Some(i * 16 + bit_pos);
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_decimal_digits() {
        let digits = b"1234567890123456";
        for len in 1..=digits.len() {
            assert_eq!(
                parse_decimal_digits(&digits[..len]),
                parse_decimal_digits_scalar(&digits[..len]),
                "digit width {len}"
            );
        }
        assert_eq!(parse_decimal_digits(b"0"), Some(0));
        assert_eq!(parse_decimal_digits(b"000123"), Some(123));
        assert_eq!(
            parse_decimal_digits(b"12345678901234567"),
            Some(12_345_678_901_234_567)
        );
        assert_eq!(parse_decimal_digits(b"12x4"), None);
        assert_eq!(parse_decimal_digits(b""), Some(0));
    }

    #[test]
    fn test_parse_decimal_digits_rejects_invalid_byte_at_every_simd_lane() {
        for len in 8..=16 {
            for index in 0..len {
                for invalid in [b'/', b':', 0, 255] {
                    let mut input = *b"1234567890123456";
                    input[index] = invalid;
                    assert_eq!(parse_decimal_digits(&input[..len]), None);
                }
            }
        }
    }

    #[test]
    fn test_count_stars_simd() {
        let text = b"X100Y200D01*X300Y400D01*D02*";
        assert_eq!(count_stars_simd(text), 3);

        let empty = b"";
        assert_eq!(count_stars_simd(empty), 0);

        let exact_16 = b"0123456789abcde*";
        assert_eq!(count_stars_simd(exact_16), 1);

        let exactly_32 = b"0123456789abcde*0123456789abcde*";
        assert_eq!(count_stars_simd(exactly_32), 2);

        let thirty_three = b"0123456789abcde*0123456789abcde**";
        assert_eq!(count_stars_simd(thirty_three), 3);
    }

    #[test]
    fn test_find_star_simd() {
        let text = b"X100Y200D01*X300Y400D01*";
        assert_eq!(find_star_simd(text), Some(11));

        let none = b"X100Y200D01";
        assert_eq!(find_star_simd(none), None);

        let at_0 = b"*abc";
        assert_eq!(find_star_simd(at_0), Some(0));

        let at_15 = b"0123456789abcde*";
        assert_eq!(find_star_simd(at_15), Some(15));

        let at_16 = b"0123456789abcdef*";
        assert_eq!(find_star_simd(at_16), Some(16));
    }

    #[test]
    fn test_rfind_byte_simd() {
        let text = b"abc%def%ghi";
        assert_eq!(rfind_byte_simd(text, b'%'), Some(7));

        let none = b"abcdefghi";
        assert_eq!(rfind_byte_simd(none, b'%'), None);

        let at_start = b"%abcdef";
        assert_eq!(rfind_byte_simd(at_start, b'%'), Some(0));

        let at_15 = b"0123456789abcde%";
        assert_eq!(rfind_byte_simd(at_15, b'%'), Some(15));

        let at_16 = b"0123456789abcdef%rest";
        assert_eq!(rfind_byte_simd(at_16, b'%'), Some(16));

        let multiple_in_chunk = b"%123456789abcd%";
        assert_eq!(rfind_byte_simd(multiple_in_chunk, b'%'), Some(14));
    }
}
