use super::buffer::Fbo;
use crate::geometry::Boundary;
use wasm_bindgen::prelude::*;
use web_sys::WebGlTexture;

pub(crate) const MIN_COMPOSITE_SOURCES: usize = 2;
pub(crate) const MAX_COMPOSITE_SOURCES: usize = 24;

/// The renderer-facing kind of a layer that can eventually produce a binary
/// mask. Composite creation currently accepts only `Gerber`; keeping the
/// resolved kind here prevents the dependency/render path from baking that
/// policy into every call site.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MaskSourceKind {
    Gerber,
    Composite,
    InternalOutline,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedMaskSource {
    layer_id: usize,
    kind: MaskSourceKind,
}

impl Default for ResolvedMaskSource {
    fn default() -> Self {
        Self::new(0, MaskSourceKind::Gerber)
    }
}

impl ResolvedMaskSource {
    pub(crate) fn new(layer_id: usize, kind: MaskSourceKind) -> Self {
        Self { layer_id, kind }
    }

    pub(crate) fn layer_id(self) -> usize {
        self.layer_id
    }

    pub(crate) fn kind(self) -> MaskSourceKind {
        self.kind
    }
}

/// Identity of a cached outline fill. Parsed definitions retain a compact
/// SHA-256 revision plus every parse input, without retaining or duplicating
/// source text. Byte-identical definitions share one mask and reference count.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum OutlineMaskCacheKey {
    Bounds {
        min_x: u32,
        max_x: u32,
        min_y: u32,
        max_y: u32,
    },
    Layer {
        layer_id: usize,
    },
    Parsed {
        layer_id: usize,
        content_sha256: [u8; 32],
        content_len: usize,
        offset_x: u32,
        offset_y: u32,
        preserve_arc_regions: bool,
        arc_tessellation_quality: u32,
    },
}

impl OutlineMaskCacheKey {
    pub(crate) fn references_layer(&self, layer_id: usize) -> bool {
        matches!(
            self,
            Self::Layer {
                layer_id: cached_layer_id
            } | Self::Parsed {
                layer_id: cached_layer_id,
                ..
            } if *cached_layer_id == layer_id
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CompositePreset {
    Union,
    Intersection,
    Difference,
}

impl CompositePreset {
    pub(crate) fn parse(value: &str) -> Result<Self, JsValue> {
        match value {
            "union" => Ok(Self::Union),
            "intersection" => Ok(Self::Intersection),
            "difference" => Ok(Self::Difference),
            _ => Err(JsValue::from_str(
                "Composite preset must be 'union', 'intersection', or 'difference'",
            )),
        }
    }
}

pub(crate) fn bitset_len(source_count: usize) -> Result<usize, JsValue> {
    validate_source_count(source_count)?;
    Ok((1usize << source_count).div_ceil(8))
}

pub(crate) fn validate_source_count(source_count: usize) -> Result<(), JsValue> {
    if !(MIN_COMPOSITE_SOURCES..=MAX_COMPOSITE_SOURCES).contains(&source_count) {
        return Err(JsValue::from_str(
            "Composite layers require between 2 and 24 Gerber sources",
        ));
    }
    Ok(())
}

pub(crate) fn validate_bitset(source_count: usize, bits: &[u8]) -> Result<(), JsValue> {
    let expected = bitset_len(source_count)?;
    if bits.len() != expected {
        return Err(JsValue::from_str(&format!(
            "Composite visible bitset length mismatch: expected {expected} bytes, got {}",
            bits.len()
        )));
    }
    Ok(())
}

pub(crate) fn normalize_fallback_bounds(mut bounds: Boundary) -> Result<Boundary, String> {
    for (label, value) in [
        ("min_x", bounds.min_x),
        ("max_x", bounds.max_x),
        ("min_y", bounds.min_y),
        ("max_y", bounds.max_y),
    ] {
        if !value.is_finite() {
            return Err(format!("Composite fallback bounds {label} must be finite"));
        }
    }
    if bounds.min_x > bounds.max_x || bounds.min_y > bounds.max_y {
        return Err("Composite fallback bounds must not be reversed".to_string());
    }

    if bounds.min_x == bounds.max_x {
        let padding = fallback_axis_padding(bounds.min_x);
        bounds.min_x -= padding;
        bounds.max_x += padding;
    }
    if bounds.min_y == bounds.max_y {
        let padding = fallback_axis_padding(bounds.min_y);
        bounds.min_y -= padding;
        bounds.max_y += padding;
    }
    if !bounds.min_x.is_finite()
        || !bounds.max_x.is_finite()
        || !bounds.min_y.is_finite()
        || !bounds.max_y.is_finite()
        || bounds.min_x >= bounds.max_x
        || bounds.min_y >= bounds.max_y
    {
        return Err("Composite fallback bounds cannot be expanded to positive area".to_string());
    }
    Ok(bounds)
}

fn fallback_axis_padding(value: f32) -> f32 {
    (value.abs().max(1.0) * f32::EPSILON * 8.0).max(0.000_001)
}

pub(crate) fn preset_bitset(
    source_count: usize,
    preset: CompositePreset,
) -> Result<Vec<u8>, JsValue> {
    let len = bitset_len(source_count)?;
    let mut bits = try_zeroed_bitset(len).map_err(JsValue::from_str)?;
    match preset {
        CompositePreset::Union => {
            bits.fill(0xff);
            bits[0] &= !1;
        }
        CompositePreset::Intersection => set_bit(&mut bits, (1usize << source_count) - 1, true),
        CompositePreset::Difference => set_bit(&mut bits, 1, true),
    }
    Ok(bits)
}

fn try_zeroed_bitset(len: usize) -> Result<Vec<u8>, &'static str> {
    let mut bits = Vec::new();
    bits.try_reserve_exact(len)
        .map_err(|_| "Unable to allocate composite visible-area preset")?;
    bits.resize(len, 0);
    Ok(bits)
}

pub(crate) fn get_bit(bits: &[u8], code: usize) -> bool {
    bits.get(code >> 3)
        .is_some_and(|byte| byte & (1 << (code & 7)) != 0)
}

pub(crate) fn set_bit(bits: &mut [u8], code: usize, visible: bool) {
    let byte = &mut bits[code >> 3];
    let mask = 1 << (code & 7);
    if visible {
        *byte |= mask;
    } else {
        *byte &= !mask;
    }
}

/// Add a new highest bit slot. Both new branches inherit the old visibility,
/// so adding a source never changes the current rendered result.
#[cfg(test)]
pub(crate) fn add_source(bits: &[u8], source_count: usize) -> Result<Vec<u8>, JsValue> {
    validate_bitset(source_count, bits)?;
    if source_count >= MAX_COMPOSITE_SOURCES {
        return Err(JsValue::from_str("Composite source limit is 24"));
    }
    let old_codes = 1usize << source_count;
    let mut next = vec![0u8; bitset_len(source_count + 1)?];
    for code in 0..old_codes {
        let visible = get_bit(bits, code);
        set_bit(&mut next, code, visible);
        set_bit(&mut next, code | old_codes, visible);
    }
    Ok(next)
}

/// Remove one bit slot and compact the remaining code. The two old branches
/// are OR-merged so an area that was visible cannot disappear on removal.
#[cfg(test)]
pub(crate) fn remove_source(
    bits: &[u8],
    source_count: usize,
    removed_slot: usize,
) -> Result<Vec<u8>, JsValue> {
    validate_bitset(source_count, bits)?;
    if source_count <= MIN_COMPOSITE_SOURCES {
        return Err(JsValue::from_str(
            "A composite layer must keep at least two sources",
        ));
    }
    if removed_slot >= source_count {
        return Err(JsValue::from_str("Composite source slot is out of range"));
    }

    let next_source_count = source_count - 1;
    let mut next = vec![0u8; bitset_len(next_source_count)?];
    let low_mask = (1usize << removed_slot) - 1;
    for code in 0..(1usize << next_source_count) {
        let low = code & low_mask;
        let high = code & !low_mask;
        let without_removed = low | (high << 1);
        let with_removed = without_removed | (1usize << removed_slot);
        set_bit(
            &mut next,
            code,
            get_bit(bits, without_removed) || get_bit(bits, with_removed),
        );
    }
    Ok(next)
}

/// Reordering changes display/Difference command order only. Bit slots remain
/// stable, so the authoritative visibility bitset does not need remapping.
#[cfg(test)]
pub(crate) fn reorder_sources<T: Clone>(sources: &[T], order: &[usize]) -> Result<Vec<T>, JsValue> {
    if sources.len() != order.len() {
        return Err(JsValue::from_str("Composite source order length mismatch"));
    }
    let mut seen = vec![false; sources.len()];
    let mut reordered = Vec::with_capacity(sources.len());
    for &index in order {
        if index >= sources.len() || seen[index] {
            return Err(JsValue::from_str(
                "Composite source order must be a permutation",
            ));
        }
        seen[index] = true;
        reordered.push(sources[index].clone());
    }
    Ok(reordered)
}

pub(crate) struct CompositeLayerMetadata {
    pub(crate) sources: Vec<ResolvedMaskSource>,
    pub(crate) visible_bits: Vec<u8>,
    pub(crate) outline_mask_id: usize,
    pub(crate) outline_cache_key: OutlineMaskCacheKey,
    pub(crate) boundary: Boundary,
    pub(crate) inverted: bool,
    pub(crate) output_fbo: Option<Fbo>,
    pub(crate) output_is_r8: bool,
    pub(crate) lookup_texture: Option<WebGlTexture>,
    pub(crate) lookup_width: i32,
    pub(crate) dirty: bool,
    pub(crate) membership_dirty: bool,
    pub(crate) source_generations: Vec<u64>,
    pub(crate) outline_generation: Option<u64>,
    pub(crate) transform: Option<[f32; 9]>,
    pub(crate) membership_encode_count: u64,
    pub(crate) membership_encode_pass_count: u64,
    pub(crate) last_membership_encode_pass_count: usize,
    pub(crate) lookup_render_count: u64,
}

pub(crate) struct CompositeDiagnostics {
    pub(crate) viewport_width: u32,
    pub(crate) viewport_height: u32,
    pub(crate) source_count: usize,
    pub(crate) encode_pass_count: usize,
    pub(crate) cpu_bitset_bytes: usize,
    pub(crate) gpu_lookup_bytes: usize,
    pub(crate) output_mask_bytes: usize,
    pub(crate) shared_membership_bytes: usize,
    pub(crate) shared_outline_bytes: usize,
    pub(crate) output_format: &'static str,
    pub(crate) membership_encode_count: u64,
    pub(crate) membership_encode_pass_count: u64,
    pub(crate) render_scratch_growth_count: u64,
    pub(crate) lookup_render_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn visible_codes(bits: &[u8], count: usize) -> Vec<usize> {
        (0..(1usize << count))
            .filter(|&code| get_bit(bits, code))
            .collect()
    }

    #[derive(Clone, Copy)]
    struct XorShift64(u64);

    impl XorShift64 {
        fn next(&mut self) -> u64 {
            let mut value = self.0;
            value ^= value << 13;
            value ^= value >> 7;
            value ^= value << 17;
            self.0 = value;
            value
        }

        fn index(&mut self, upper: usize) -> usize {
            (self.next() as usize) % upper
        }
    }

    fn deterministic_codes(code_count: usize, rng: &mut XorShift64) -> Vec<usize> {
        if code_count <= 4096 {
            return (0..code_count).collect();
        }
        let mut codes = vec![0, 1, code_count / 2, code_count - 1];
        for _ in 0..256 {
            codes.push(rng.index(code_count));
        }
        codes.sort_unstable();
        codes.dedup();
        codes
    }

    #[test]
    fn presets_cover_2_8_16_24_sources() {
        for count in [2, 8, 16, 24] {
            let union = preset_bitset(count, CompositePreset::Union).unwrap();
            assert!(!get_bit(&union, 0));
            assert!(get_bit(&union, 1));
            assert!(get_bit(&union, (1usize << count) - 1));

            let intersection = preset_bitset(count, CompositePreset::Intersection).unwrap();
            assert!(get_bit(&intersection, (1usize << count) - 1));
            assert_eq!(
                intersection
                    .iter()
                    .map(|byte| byte.count_ones())
                    .sum::<u32>(),
                1
            );

            let difference = preset_bitset(count, CompositePreset::Difference).unwrap();
            assert!(get_bit(&difference, 1));
            assert_eq!(
                difference.iter().map(|byte| byte.count_ones()).sum::<u32>(),
                1
            );
        }
    }

    #[test]
    fn parsed_outline_identity_is_fixed_size_and_covers_every_effective_input() {
        let digest: [u8; 32] = Sha256::digest(b"outline revision").into();
        let key = OutlineMaskCacheKey::Parsed {
            layer_id: 41,
            content_sha256: digest,
            content_len: 16,
            offset_x: 1.25f32.to_bits(),
            offset_y: (-0.5f32).to_bits(),
            preserve_arc_regions: true,
            arc_tessellation_quality: 3,
        };
        assert!(std::mem::size_of::<OutlineMaskCacheKey>() <= 64);
        assert!(key.references_layer(41));
        assert_ne!(
            key,
            OutlineMaskCacheKey::Parsed {
                layer_id: 41,
                content_sha256: Sha256::digest(b"changed revision").into(),
                content_len: 16,
                offset_x: 1.25f32.to_bits(),
                offset_y: (-0.5f32).to_bits(),
                preserve_arc_regions: true,
                arc_tessellation_quality: 3,
            }
        );
        assert_ne!(
            key,
            OutlineMaskCacheKey::Parsed {
                layer_id: 41,
                content_sha256: digest,
                content_len: 16,
                offset_x: 1.5f32.to_bits(),
                offset_y: (-0.5f32).to_bits(),
                preserve_arc_regions: true,
                arc_tessellation_quality: 3,
            }
        );
        assert_ne!(
            key,
            OutlineMaskCacheKey::Parsed {
                layer_id: 41,
                content_sha256: digest,
                content_len: 16,
                offset_x: 1.25f32.to_bits(),
                offset_y: (-0.5f32).to_bits(),
                preserve_arc_regions: false,
                arc_tessellation_quality: 3,
            }
        );
    }

    #[test]
    fn resolved_mask_source_retains_kind_and_stable_id() {
        for (kind, layer_id) in [
            (MaskSourceKind::Gerber, 3),
            (MaskSourceKind::Composite, 7),
            (MaskSourceKind::InternalOutline, 11),
        ] {
            let source = ResolvedMaskSource::new(layer_id, kind);
            assert_eq!(source.layer_id(), layer_id);
            assert_eq!(source.kind(), kind);
        }
    }

    #[test]
    fn source_add_inherits_both_branches() {
        let mut bits = preset_bitset(2, CompositePreset::Difference).unwrap();
        set_bit(&mut bits, 0, true);
        let next = add_source(&bits, 2).unwrap();
        assert_eq!(visible_codes(&next, 3), vec![0, 1, 4, 5]);
    }

    #[test]
    fn source_remove_or_merges_and_compacts() {
        let mut bits = vec![0u8; bitset_len(4).unwrap()];
        set_bit(&mut bits, 0b1010, true);
        set_bit(&mut bits, 0b0101, true);
        let next = remove_source(&bits, 4, 1).unwrap();
        assert_eq!(visible_codes(&next, 3), vec![0b011, 0b100]);
    }

    #[test]
    fn deterministic_bitset_properties_cover_every_source_count() {
        let mut rng = XorShift64(0x6a09_e667_f3bc_c909);
        for source_count in MIN_COMPOSITE_SOURCES..=MAX_COMPOSITE_SOURCES {
            let code_count = 1usize << source_count;
            let samples = deterministic_codes(code_count, &mut rng);
            for preset in [
                CompositePreset::Union,
                CompositePreset::Intersection,
                CompositePreset::Difference,
            ] {
                let bits = preset_bitset(source_count, preset).unwrap();
                assert_eq!(bits.len(), code_count.div_ceil(8));
                for &code in &samples {
                    let expected = match preset {
                        CompositePreset::Union => code != 0,
                        CompositePreset::Intersection => code == code_count - 1,
                        CompositePreset::Difference => code == 1,
                    };
                    assert_eq!(
                        get_bit(&bits, code),
                        expected,
                        "preset {preset:?}, sources {source_count}, code {code:#x}",
                    );
                }
            }

            let mut random_bits = try_zeroed_bitset(code_count.div_ceil(8)).unwrap();
            for byte in &mut random_bits {
                *byte = rng.next() as u8;
            }
            if source_count < MAX_COMPOSITE_SOURCES {
                let expanded = add_source(&random_bits, source_count).unwrap();
                for &code in &samples {
                    let expected = get_bit(&random_bits, code);
                    assert_eq!(get_bit(&expanded, code), expected);
                    assert_eq!(get_bit(&expanded, code | code_count), expected);
                }
            }

            if source_count > MIN_COMPOSITE_SOURCES {
                for removed_slot in [0, source_count / 2, source_count - 1] {
                    let compacted =
                        remove_source(&random_bits, source_count, removed_slot).unwrap();
                    let compact_code_count = 1usize << (source_count - 1);
                    for code in deterministic_codes(compact_code_count, &mut rng) {
                        let low_mask = (1usize << removed_slot) - 1;
                        let without_removed = (code & low_mask) | ((code & !low_mask) << 1);
                        let with_removed = without_removed | (1usize << removed_slot);
                        assert_eq!(
                            get_bit(&compacted, code),
                            get_bit(&random_bits, without_removed)
                                || get_bit(&random_bits, with_removed),
                            "sources {source_count}, removed slot {removed_slot}, code {code:#x}",
                        );
                    }
                }
            }

            let sources: Vec<usize> = (0..source_count).collect();
            let mut order = sources.clone();
            for index in (1..source_count).rev() {
                let swap_with = rng.index(index + 1);
                order.swap(index, swap_with);
            }
            let reordered = reorder_sources(&sources, &order).unwrap();
            for (display_index, &slot) in order.iter().enumerate() {
                assert_eq!(reordered[display_index], slot);
            }
        }
    }

    #[test]
    fn validates_bitset_size() {
        assert_eq!(bitset_len(2).unwrap(), 1);
        assert_eq!(bitset_len(24).unwrap(), 2 * 1024 * 1024);
        assert!(validate_bitset(2, &[0]).is_ok());
    }

    #[test]
    fn preset_allocation_failure_is_reported() {
        let error = try_zeroed_bitset(usize::MAX).unwrap_err();
        assert_eq!(error, "Unable to allocate composite visible-area preset");
    }

    #[test]
    fn reorder_keeps_slots_and_visibility_unchanged() {
        let sources = ["a", "b", "c"];
        let bits = preset_bitset(3, CompositePreset::Difference).unwrap();
        assert_eq!(
            reorder_sources(&sources, &[2, 0, 1]).unwrap(),
            ["c", "a", "b"]
        );
        assert_eq!(visible_codes(&bits, 3), vec![1]);
    }

    #[test]
    fn fallback_bounds_expand_degenerate_axes_without_changing_finite_axes() {
        let vertical = normalize_fallback_bounds(Boundary::new(2.0, 2.0, -3.0, 4.0)).unwrap();
        assert!(vertical.min_x < 2.0 && vertical.max_x > 2.0);
        assert_eq!((vertical.min_y, vertical.max_y), (-3.0, 4.0));

        let point = normalize_fallback_bounds(Boundary::new(5.0, 5.0, 8.0, 8.0)).unwrap();
        assert!(point.min_x < point.max_x && point.min_y < point.max_y);
        assert!(normalize_fallback_bounds(Boundary::new(2.0, 1.0, 0.0, 1.0)).is_err());
    }
}
