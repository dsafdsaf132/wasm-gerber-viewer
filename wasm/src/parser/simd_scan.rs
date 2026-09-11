//! SIMD-accelerated byte scanning for delimiter search and command counting.

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::*;

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
