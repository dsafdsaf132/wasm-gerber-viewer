//! UNIX `compress` (`.Z`, magic `1F 9D`) decoding for ODB++ jobs, which store
//! `features.Z` and similar files in that format. The codec itself is
//! `oxiarc-lzw`'s `z` module (pure Rust, `#![forbid(unsafe_code)]`,
//! differential-tested against `compress(1)`); this wrapper only adds the
//! magic check and the output cap the archive byte budget relies on.

const LZW_MAGIC: [u8; 2] = [0x1f, 0x9d];

/// True for data that starts with the `compress` magic.
pub(crate) fn is_unix_z(bytes: &[u8]) -> bool {
    bytes.len() >= 3 && bytes[..2] == LZW_MAGIC
}

/// Decompress a `.Z` stream. The output is capped at `max_output_bytes`.
pub(crate) fn decompress_unix_z(bytes: &[u8], max_output_bytes: usize) -> Result<Vec<u8>, String> {
    if !is_unix_z(bytes) {
        return Err("data is not in UNIX compress (.Z) format".to_string());
    }
    oxiarc_lzw::z::decompress_with_limit(bytes, max_output_bytes)
        .map_err(|error| format!(".Z data could not be decompressed: {error}"))
}
