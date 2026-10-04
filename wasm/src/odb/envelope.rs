//! The layer envelope handed over by the viewer (see the module docs).

use std::collections::HashMap;

pub(crate) const ENVELOPE_MAGIC: &str = "%ODB++LAYER%";
const FILE_MARKER: &str = "%ODB++FILE ";
const END_MARKER: &str = "%ODB++END%";

/// Which layer of the job the envelope carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LayerKind {
    /// Copper, mask, silk, paste: features are drawn as they are.
    Signal,
    /// The step profile: surfaces are stroked as an outline.
    Profile,
    Drill,
    Rout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Plating {
    All,
    Plated,
    NonPlated,
}

pub(crate) struct Envelope<'a> {
    pub kind: LayerKind,
    /// The ODB++ layer name, kept for diagnostics and tests.
    #[allow(dead_code)]
    pub name: String,
    pub plating: Plating,
    pub features: &'a str,
    pub tools: Option<&'a str>,
    /// User-defined symbol files keyed by lower-cased symbol name.
    pub symbols: HashMap<String, &'a str>,
}

/// True for text produced by the viewer's ODB++ loader.
pub(crate) fn is_odb_envelope(data: &str) -> bool {
    let head = data.trim_start_matches(['\u{feff}', '\r', '\n', ' ', '\t']);
    head.starts_with(ENVELOPE_MAGIC)
}

pub(crate) fn parse_envelope(data: &str) -> Result<Envelope<'_>, String> {
    let head = data.trim_start_matches(['\u{feff}', '\r', '\n', ' ', '\t']);
    let body = head
        .strip_prefix(ENVELOPE_MAGIC)
        .ok_or_else(|| "ODB++ layer envelope is missing its header".to_string())?;

    let mut kind = None;
    let mut name = String::new();
    let mut plating = Plating::All;
    let mut features = None;
    let mut tools = None;
    let mut symbols = HashMap::new();

    let mut cursor = 0usize;
    let mut current_file: Option<(String, usize)> = None;
    let mut finished = false;

    for line in body.split_inclusive('\n') {
        let line_start = cursor;
        cursor += line.len();
        let trimmed = line.trim_end_matches(['\r', '\n']);

        if let Some(path) = trimmed
            .strip_prefix(FILE_MARKER)
            .and_then(|rest| rest.strip_suffix('%'))
        {
            if let Some((file_name, start)) = current_file.take() {
                assign_file(
                    &file_name,
                    &body[start..line_start],
                    &mut features,
                    &mut tools,
                    &mut symbols,
                )?;
            }
            current_file = Some((path.trim().to_string(), cursor));
            continue;
        }
        if trimmed == END_MARKER {
            if let Some((file_name, start)) = current_file.take() {
                assign_file(
                    &file_name,
                    &body[start..line_start],
                    &mut features,
                    &mut tools,
                    &mut symbols,
                )?;
            }
            finished = true;
            break;
        }
        if current_file.is_some() {
            continue;
        }

        let trimmed = trimmed.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            return Err(format!(
                "ODB++ layer envelope has an invalid header line: {trimmed}"
            ));
        };
        match key.trim() {
            "kind" => {
                kind = Some(match value.trim() {
                    "signal" => LayerKind::Signal,
                    "profile" => LayerKind::Profile,
                    "drill" => LayerKind::Drill,
                    "rout" => LayerKind::Rout,
                    other => {
                        return Err(format!("ODB++ layer envelope has an unknown kind: {other}"))
                    }
                });
            }
            "name" => name = value.trim().to_string(),
            "plating" => {
                plating = match value.trim() {
                    "all" | "" => Plating::All,
                    "plated" => Plating::Plated,
                    "non_plated" => Plating::NonPlated,
                    other => {
                        return Err(format!(
                            "ODB++ layer envelope has an unknown plating: {other}"
                        ))
                    }
                };
            }
            _ => {}
        }
    }

    if !finished {
        return Err("ODB++ layer envelope is truncated (missing end marker)".to_string());
    }
    let kind = kind.ok_or_else(|| "ODB++ layer envelope does not declare its kind".to_string())?;
    let features =
        features.ok_or_else(|| "ODB++ layer envelope has no features file".to_string())?;

    Ok(Envelope {
        kind,
        name,
        plating,
        features,
        tools,
        symbols,
    })
}

fn assign_file<'a>(
    file_name: &str,
    content: &'a str,
    features: &mut Option<&'a str>,
    tools: &mut Option<&'a str>,
    symbols: &mut HashMap<String, &'a str>,
) -> Result<(), String> {
    if file_name == "features" {
        *features = Some(content);
    } else if file_name == "tools" {
        *tools = Some(content);
    } else if let Some(symbol) = file_name.strip_prefix("symbols/") {
        symbols.insert(symbol.trim().to_lowercase(), content);
    } else {
        return Err(format!(
            "ODB++ layer envelope has an unexpected file: {file_name}"
        ));
    }
    Ok(())
}
