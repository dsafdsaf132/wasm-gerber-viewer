//! ODB++ layer import.
//!
//! The viewer keeps archive handling (tgz/zip/folder, `.Z`/`.gz`, the job
//! `matrix` and layer naming) in JavaScript and hands each layer to WASM as a
//! *layer envelope*: the original ODB++ text files of that layer, concatenated
//! with a small header. No Gerber text is generated. The envelope is parsed
//! here and drives the same aperture, primitive, region and drill builders the
//! Gerber and Excellon parsers use, so an ODB++ layer becomes `GerberData`
//! directly and flows through every entry point that accepts layer text
//! (worker parsing, renderer recovery, composites, inverted layers).
//!
//! Envelope format (line based; ODB++ text files never start a line with `%`):
//!
//! ```text
//! %ODB++LAYER%
//! kind=signal|profile|drill|rout
//! name=TOP
//! plating=all|plated|non_plated        (drill/rout only, default all)
//! %ODB++FILE features%
//! ...features file...
//! %ODB++FILE tools%                    (drill/rout only)
//! ...tools file...
//! %ODB++FILE symbols/<name>%           (one per user-defined symbol)
//! ...symbol features file...
//! %ODB++END%
//! ```

mod drill;
mod envelope;
mod features;
mod layer;
mod lzw;
mod symbols;
mod tools;

#[cfg(test)]
mod tests;

pub(crate) use envelope::is_odb_envelope;
pub(crate) use lzw::decompress_unix_z;

use crate::drill::DrillParser;
use crate::parser::GerberParser;
use wasm_bindgen::JsValue;

/// Feed an ODB++ layer envelope into a Gerber parser's buffers. The caller
/// finishes the parser afterwards (`GerberParser::finish_layers`).
pub(crate) fn drive_gerber_parser(parser: &mut GerberParser, data: &str) -> Result<(), JsValue> {
    let envelope = envelope::parse_envelope(data).map_err(|message| JsValue::from_str(&message))?;
    layer::drive(parser, &envelope).map_err(|message| JsValue::from_str(&message))
}

/// Feed an ODB++ DRILL or ROUT layer envelope into a drill parser.
pub(crate) fn drive_drill_parser(parser: &mut DrillParser, data: &str) -> Result<(), JsValue> {
    let envelope = envelope::parse_envelope(data).map_err(|message| JsValue::from_str(&message))?;
    drill::drive(parser, &envelope).map_err(|message| JsValue::from_str(&message))
}

/// Diagnostics collected while converting one layer, reported to the viewer
/// as a single warning line.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Diagnostics {
    pub texts: usize,
    pub barcodes: usize,
    pub surfaces_in_drill: usize,
    pub missing_symbols: Vec<String>,
    pub unknown_symbols: Vec<String>,
    pub resized_user_symbols: Vec<String>,
    pub non_round_lines: usize,
    pub expansion_truncated: bool,
}

impl Diagnostics {
    fn note(list: &mut Vec<String>, name: &str) {
        if !list.iter().any(|existing| existing == name) {
            list.push(name.to_string());
        }
    }

    pub(crate) fn missing_symbol(&mut self, name: &str) {
        Self::note(&mut self.missing_symbols, name);
    }

    pub(crate) fn unknown_symbol(&mut self, name: &str) {
        Self::note(&mut self.unknown_symbols, name);
    }

    pub(crate) fn resized_user_symbol(&mut self, name: &str) {
        Self::note(&mut self.resized_user_symbols, name);
    }

    /// Human readable summary, or `None` when nothing was skipped.
    pub(crate) fn summary(&self) -> Option<String> {
        let mut notes = Vec::new();
        if self.texts > 0 {
            notes.push(format!("{} text record{}", self.texts, plural(self.texts)));
        }
        if self.barcodes > 0 {
            notes.push(format!(
                "{} barcode{}",
                self.barcodes,
                plural(self.barcodes)
            ));
        }
        if self.surfaces_in_drill > 0 {
            notes.push(format!(
                "{} surface{}",
                self.surfaces_in_drill,
                plural(self.surfaces_in_drill)
            ));
        }
        if !self.missing_symbols.is_empty() {
            let reason = if self.expansion_truncated {
                "expansion limit reached"
            } else {
                "symbol not found in job"
            };
            notes.push(format!(
                "features using user-defined symbols ({}; {reason})",
                list_names(&self.missing_symbols)
            ));
        }
        if !self.resized_user_symbols.is_empty() {
            notes.push(format!(
                "resize ignored on user-defined symbols ({})",
                list_names(&self.resized_user_symbols)
            ));
        }
        if !self.unknown_symbols.is_empty() {
            notes.push(format!(
                "standard symbols without geometry here, not drawn ({})",
                list_names(&self.unknown_symbols)
            ));
        }
        if self.non_round_lines > 0 {
            notes.push(format!(
                "{} line{} with non-round symbols drawn round",
                self.non_round_lines,
                plural(self.non_round_lines)
            ));
        }
        (!notes.is_empty()).then(|| format!("Skipped or approximated: {}", notes.join("; ")))
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

fn list_names(names: &[String]) -> String {
    const LIMIT: usize = 5;
    let shown = names
        .iter()
        .take(LIMIT)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > LIMIT {
        format!("{shown}, +{} more", names.len() - LIMIT)
    } else {
        shown
    }
}

/// Diagnostics of the most recent ODB++ layer parsed on this thread. The
/// parse entry points return only geometry, so the viewer reads the summary
/// through `take_last_odb_diagnostics` right after a parse call.
pub(crate) fn take_last_diagnostics() -> Option<String> {
    LAST_DIAGNOSTICS.with(|cell| cell.borrow_mut().take())
}

fn store_diagnostics(diagnostics: &Diagnostics) {
    let summary = diagnostics.summary();
    LAST_DIAGNOSTICS.with(|cell| *cell.borrow_mut() = summary);
}

thread_local! {
    static LAST_DIAGNOSTICS: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}
