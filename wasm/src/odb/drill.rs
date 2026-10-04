//! Drives a `DrillParser` with the pads, lines and arcs of an ODB++ DRILL or
//! ROUT layer: pads are hits, lines are slots (or straight rout cuts) and arcs
//! are arc rout cuts. Tool diameters come from the pad symbol; plating comes
//! from the `tools` file.

use super::envelope::{Envelope, Plating};
use super::features::{parse_features, Record};
use super::symbols::{parse_standard_symbol, pen_diameter, resize_shape, solid_circle_diameter};
use super::tools::{parse_tools, Tool, ToolType};
use super::{store_diagnostics, Diagnostics};
use crate::drill::DrillParser;
use std::collections::HashMap;

const TOOL_MATCH_TOLERANCE_MM: f32 = 0.001;

pub(crate) fn drive(parser: &mut DrillParser, envelope: &Envelope) -> Result<(), String> {
    let features = parse_features(envelope.features);
    // A `tools` file without its own UNITS line follows the layer's units.
    let tools = envelope
        .tools
        .map(|text| parse_tools(text, features.units).tools)
        .unwrap_or_default();
    let mut diagnostics = Diagnostics {
        texts: features.counts.texts,
        barcodes: features.counts.barcodes,
        surfaces_in_drill: features.counts.surfaces,
        ..Diagnostics::default()
    };

    let shapes: HashMap<i64, Option<super::symbols::Shape>> = features
        .symbols
        .iter()
        .map(|(index, symbol)| {
            let shape = parse_standard_symbol(&symbol.name, features.symbol_scale).map(|shape| {
                if symbol.resize != 0.0 {
                    resize_shape(&shape, symbol.resize * features.symbol_scale)
                } else {
                    shape
                }
            });
            (*index, shape)
        })
        .collect();

    // Tool codes are assigned per distinct diameter in first-use order. Both
    // lookups are cached per symbol so a large drill file does not rescan the
    // tool list and the code table for every hit.
    let mut codes_by_diameter: Vec<(f32, u32)> = Vec::new();
    let mut current_code = None;
    let tool_by_num: HashMap<i64, usize> = tools
        .iter()
        .enumerate()
        .map(|(index, tool)| (i64::from(tool.num), index))
        .collect();
    let mut code_by_symbol: HashMap<i64, u32> = HashMap::new();
    let mut plated_by_feature: HashMap<(i64, i64), bool> = HashMap::new();

    for record in &features.records {
        let (sym, dcode) = match record {
            Record::Pad(pad) => (pad.sym, pad.dcode),
            Record::Line(line) => (line.sym, line.dcode),
            Record::Arc(arc) => (arc.sym, arc.dcode),
            _ => continue,
        };
        let Some(Some(shape)) = shapes.get(&sym) else {
            diagnostics.missing_symbol(&features.symbol_name(sym));
            continue;
        };
        if let super::symbols::Shape::Unsupported = shape {
            diagnostics.unknown_symbol(&features.symbol_name(sym));
        }
        let diameter = solid_circle_diameter(shape).unwrap_or_else(|| pen_diameter(shape));
        if diameter <= 0.0 || diameter.is_nan() {
            continue;
        }

        let plated = *plated_by_feature.entry((dcode, sym)).or_insert_with(|| {
            !matches!(
                tool_for(&tools, &tool_by_num, dcode, diameter).map(|tool| tool.tool_type),
                Some(ToolType::NonPlated)
            )
        });
        match envelope.plating {
            Plating::All => {}
            Plating::Plated if !plated => continue,
            Plating::NonPlated if plated => continue,
            _ => {}
        }

        let code = match code_by_symbol.get(&sym) {
            Some(code) => *code,
            None => {
                let code = match codes_by_diameter
                    .iter()
                    .find(|(existing, _)| (existing - diameter).abs() <= TOOL_MATCH_TOLERANCE_MM)
                {
                    Some((_, code)) => *code,
                    None => {
                        let code = codes_by_diameter.len() as u32 + 1;
                        codes_by_diameter.push((diameter, code));
                        parser.declare_tool_mm(code, diameter);
                        code
                    }
                };
                code_by_symbol.insert(sym, code);
                code
            }
        };
        if current_code != Some(code) {
            parser.select_tool(code);
            current_code = Some(code);
        }

        let result = match record {
            Record::Pad(pad) => parser.add_hit(pad.x, pad.y),
            Record::Line(line) => {
                if line.xs == line.xe && line.ys == line.ye {
                    parser.add_hit(line.xs, line.ys)
                } else {
                    parser.add_slot(line.xs, line.ys, line.xe, line.ye)
                }
            }
            Record::Arc(arc) => {
                parser.add_arc(arc.xs, arc.ys, arc.xe, arc.ye, arc.xc, arc.yc, !arc.cw)
            }
            _ => Ok(()),
        };
        result.map_err(|error| {
            error
                .as_string()
                .unwrap_or_else(|| "ODB++ drill feature could not be added".to_string())
        })?;
    }

    store_diagnostics(&diagnostics);
    Ok(())
}

/// The `tools` entry for a feature: by tool number (the pad `dcode`) first,
/// then by matching finished size.
fn tool_for<'a>(
    tools: &'a [Tool],
    by_num: &HashMap<i64, usize>,
    dcode: i64,
    diameter: f32,
) -> Option<&'a Tool> {
    if dcode > 0 {
        if let Some(tool) = by_num.get(&dcode).and_then(|index| tools.get(*index)) {
            return Some(tool);
        }
    }
    tools.iter().find(|tool| {
        tool.finish_size_mm
            .is_some_and(|size| (size - diameter).abs() <= TOOL_MATCH_TOLERANCE_MM)
    })
}
