//! ODB++ structured text (`KEY=VALUE` plus `NAME { ... }` blocks) and the
//! drill `tools` file built on it.

use super::features::{symbol_scale, units_from_value, Units};

pub(crate) struct Block {
    pub name: String,
    pub values: Vec<(String, String)>,
}

impl Block {
    pub(crate) fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_str())
    }
}

pub(crate) struct StructuredText {
    pub values: Vec<(String, String)>,
    pub blocks: Vec<Block>,
}

impl StructuredText {
    pub(crate) fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value.as_str())
    }
}

pub(crate) fn parse_structured_text(text: &str) -> StructuredText {
    let mut result = StructuredText {
        values: Vec::new(),
        blocks: Vec::new(),
    };
    let mut in_block = false;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_suffix('{') {
            result.blocks.push(Block {
                name: name.trim().to_uppercase(),
                values: Vec::new(),
            });
            in_block = true;
            continue;
        }
        if line == "}" {
            in_block = false;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let entry = (key.trim().to_uppercase(), value.trim().to_string());
        if in_block {
            if let Some(block) = result.blocks.last_mut() {
                block.values.push(entry);
                continue;
            }
        }
        result.values.push(entry);
    }
    result
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolType {
    Plated,
    NonPlated,
    Via,
    Other,
}

#[derive(Clone, Debug)]
pub(crate) struct Tool {
    pub num: u32,
    pub tool_type: ToolType,
    /// Finished hole size in millimetres, when declared.
    pub finish_size_mm: Option<f32>,
}

pub(crate) struct ToolsFile {
    #[allow(dead_code)]
    pub units: Units,
    pub tools: Vec<Tool>,
}

/// Parse a `tools` file. Sizes are in thousandths of the file unit (mils or
/// microns); `default_units` applies when the file declares none.
pub(crate) fn parse_tools(text: &str, default_units: Units) -> ToolsFile {
    let parsed = parse_structured_text(text);
    let units = units_from_value(parsed.get("UNITS"), default_units);
    let scale = symbol_scale(units);
    let mut tools = Vec::new();
    for block in &parsed.blocks {
        if block.name != "TOOLS" {
            continue;
        }
        let Some(num) = block
            .get("NUM")
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            continue;
        };
        let tool_type = match block.get("TYPE").map(str::to_uppercase).as_deref() {
            Some("PLATED") => ToolType::Plated,
            Some("NON_PLATED") => ToolType::NonPlated,
            Some("VIA") => ToolType::Via,
            _ => ToolType::Other,
        };
        let finish_size_mm = block
            .get("FINISH_SIZE")
            .or_else(|| block.get("DRILL_SIZE"))
            .and_then(|value| value.trim().parse::<f32>().ok())
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value * scale);
        tools.push(Tool {
            num,
            tool_type,
            finish_size_mm,
        });
    }
    ToolsFile { units, tools }
}
