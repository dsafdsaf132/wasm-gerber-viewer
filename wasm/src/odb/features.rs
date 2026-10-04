//! Parser for ODB++ `features` files (layer features, the step profile and
//! user-defined symbol definitions). Coordinates are converted to millimetres;
//! symbol dimensions stay in the symbol table together with a `symbol_scale`
//! (millimetres per thousandth of the file unit) for the symbol resolver.
//!
//! Records are read field by field from a whitespace iterator; no per-line
//! token vector is allocated, which matters for layers with hundreds of
//! thousands of lines.

use std::collections::HashMap;
use std::str::SplitAsciiWhitespace;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Units {
    Inch,
    Mm,
}

/// Units declared by a `UNITS=` value; ODB++ defaults to inch when absent.
pub(crate) fn units_from_value(value: Option<&str>, fallback: Units) -> Units {
    match value.map(|value| value.trim().to_uppercase()).as_deref() {
        Some("MM") => Units::Mm,
        Some("INCH") | Some("IN") => Units::Inch,
        _ => fallback,
    }
}

/// Millimetres per file unit.
pub(crate) fn unit_scale(units: Units) -> f32 {
    match units {
        Units::Mm => 1.0,
        Units::Inch => 25.4,
    }
}

/// Symbol and tool dimensions are thousandths of the file unit (mils or microns).
pub(crate) fn symbol_scale(units: Units) -> f32 {
    0.001 * unit_scale(units)
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SymbolRef {
    pub name: String,
    /// Resize in thousandths of the file unit (rarely used).
    pub resize: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Orient {
    /// Clockwise degrees, normalised to `[0, 360)`.
    pub angle_deg: f32,
    /// Mirror about the x-axis (`y -> -y`), applied after the rotation.
    pub mirror: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Pad {
    pub x: f32,
    pub y: f32,
    pub sym: i64,
    /// Resize in file units of a thousandth (`-1 sym resize`), 0 when absent.
    pub resize: f32,
    pub neg: bool,
    pub dcode: i64,
    pub orient: Orient,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Line {
    pub xs: f32,
    pub ys: f32,
    pub xe: f32,
    pub ye: f32,
    pub sym: i64,
    pub neg: bool,
    pub dcode: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Arc {
    pub xs: f32,
    pub ys: f32,
    pub xe: f32,
    pub ye: f32,
    pub xc: f32,
    pub yc: f32,
    pub sym: i64,
    pub neg: bool,
    pub dcode: i64,
    pub cw: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Segment {
    Line {
        x: f32,
        y: f32,
    },
    Arc {
        x: f32,
        y: f32,
        cx: f32,
        cy: f32,
        cw: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Polygon {
    pub hole: bool,
    pub x0: f32,
    pub y0: f32,
    pub segments: Vec<Segment>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Surface {
    pub neg: bool,
    pub polygons: Vec<Polygon>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Record {
    Pad(Pad),
    Line(Line),
    Arc(Arc),
    Surface(Surface),
    Text,
    Barcode,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Counts {
    pub pads: usize,
    pub lines: usize,
    pub arcs: usize,
    pub surfaces: usize,
    pub texts: usize,
    pub barcodes: usize,
    pub unknown: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct Features {
    #[allow(dead_code)]
    pub units: Units,
    /// Millimetres per thousandth of the file unit.
    pub symbol_scale: f32,
    pub symbols: HashMap<i64, SymbolRef>,
    pub records: Vec<Record>,
    pub counts: Counts,
}

impl Features {
    pub(crate) fn symbol_name(&self, index: i64) -> String {
        self.symbols
            .get(&index)
            .map(|symbol| symbol.name.clone())
            .unwrap_or_else(|| format!("#{index}"))
    }
}

/// The fields of one record, consumed left to right without allocating.
pub(crate) struct Fields<'a> {
    inner: SplitAsciiWhitespace<'a>,
}

impl<'a> Fields<'a> {
    pub(crate) fn new(line: &'a str) -> Self {
        Fields {
            inner: line.split_ascii_whitespace(),
        }
    }

    pub(crate) fn next_str(&mut self) -> Option<&'a str> {
        self.inner.next()
    }

    /// The next field as a finite number, 0 when absent or malformed.
    pub(crate) fn next_num(&mut self) -> f32 {
        num(self.inner.next())
    }

    /// The next field as an integer, -1 when absent or malformed.
    pub(crate) fn next_int(&mut self) -> i64 {
        int(self.inner.next())
    }

    /// Whether the next field equals `expected` (consumes it either way).
    pub(crate) fn next_is(&mut self, expected: &str) -> bool {
        self.inner.next() == Some(expected)
    }
}

pub(crate) fn parse_features(text: &str) -> Features {
    let mut units = Units::Inch;
    let mut scale = unit_scale(units);
    let mut symbols = HashMap::new();
    let mut records: Vec<Record> = Vec::new();
    let mut counts = Counts::default();

    let mut surface: Option<Surface> = None;
    let mut polygon: Option<Polygon> = None;

    fn finish_polygon(surface: &mut Option<Surface>, polygon: &mut Option<Polygon>) {
        if let (Some(surface), Some(polygon)) = (surface.as_mut(), polygon.take()) {
            surface.polygons.push(polygon);
        }
    }
    fn finish_surface(
        surface: &mut Option<Surface>,
        polygon: &mut Option<Polygon>,
        records: &mut Vec<Record>,
        counts: &mut Counts,
    ) {
        finish_polygon(surface, polygon);
        if let Some(surface) = surface.take() {
            if !surface.polygons.is_empty() {
                records.push(Record::Surface(surface));
                counts.surfaces += 1;
            }
        }
    }

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let first = line.as_bytes()[0];

        if first == b'$' {
            let mut fields = Fields::new(strip_attributes(line));
            let index = fields
                .next_str()
                .and_then(|token| token[1..].parse::<i64>().ok());
            let name = fields.next_str();
            if let (Some(index), Some(name)) = (index, name) {
                let resize = fields
                    .next_str()
                    .and_then(|token| token.parse::<f32>().ok())
                    .filter(|value| value.is_finite())
                    .unwrap_or(0.0);
                symbols.insert(
                    index,
                    SymbolRef {
                        name: name.to_string(),
                        resize,
                    },
                );
            }
            continue;
        }
        if first == b'@' || first == b'&' {
            continue;
        }
        if let Some(value) = line.strip_prefix("UNITS=") {
            units = units_from_value(Some(value), units);
            scale = unit_scale(units);
            continue;
        }
        if line.starts_with("ID=") || line == "F" || line.starts_with("F ") {
            continue;
        }

        let mut fields = Fields::new(strip_attributes(line));
        let Some(record_type) = fields.next_str() else {
            continue;
        };

        match record_type {
            "P" => {
                finish_surface(&mut surface, &mut polygon, &mut records, &mut counts);
                // P x y apt polarity dcode orient   where apt = sym | -1 sym resize
                let x = fields.next_num() * scale;
                let y = fields.next_num() * scale;
                let apt = fields.next_str();
                let (sym, resize) = if apt == Some("-1") {
                    (fields.next_int(), fields.next_num())
                } else {
                    (int(apt), 0.0)
                };
                let neg = fields.next_is("N");
                let dcode = fields.next_int();
                let orient = parse_orient(&mut fields);
                records.push(Record::Pad(Pad {
                    x,
                    y,
                    sym,
                    resize,
                    neg,
                    dcode,
                    orient,
                }));
                counts.pads += 1;
            }
            "L" => {
                finish_surface(&mut surface, &mut polygon, &mut records, &mut counts);
                let xs = fields.next_num() * scale;
                let ys = fields.next_num() * scale;
                let xe = fields.next_num() * scale;
                let ye = fields.next_num() * scale;
                let sym = fields.next_int();
                let neg = fields.next_is("N");
                let dcode = fields.next_int();
                records.push(Record::Line(Line {
                    xs,
                    ys,
                    xe,
                    ye,
                    sym,
                    neg,
                    dcode,
                }));
                counts.lines += 1;
            }
            "A" => {
                finish_surface(&mut surface, &mut polygon, &mut records, &mut counts);
                let xs = fields.next_num() * scale;
                let ys = fields.next_num() * scale;
                let xe = fields.next_num() * scale;
                let ye = fields.next_num() * scale;
                let xc = fields.next_num() * scale;
                let yc = fields.next_num() * scale;
                let sym = fields.next_int();
                let neg = fields.next_is("N");
                let dcode = fields.next_int();
                let cw = fields.next_is("Y");
                records.push(Record::Arc(Arc {
                    xs,
                    ys,
                    xe,
                    ye,
                    xc,
                    yc,
                    sym,
                    neg,
                    dcode,
                    cw,
                }));
                counts.arcs += 1;
            }
            "S" => {
                finish_surface(&mut surface, &mut polygon, &mut records, &mut counts);
                surface = Some(Surface {
                    neg: fields.next_is("N"),
                    polygons: Vec::new(),
                });
            }
            "OB" => {
                if surface.is_some() {
                    finish_polygon(&mut surface, &mut polygon);
                    let x0 = fields.next_num() * scale;
                    let y0 = fields.next_num() * scale;
                    polygon = Some(Polygon {
                        hole: fields.next_is("H"),
                        x0,
                        y0,
                        segments: Vec::new(),
                    });
                }
            }
            "OS" => {
                if let Some(polygon) = polygon.as_mut() {
                    let x = fields.next_num() * scale;
                    let y = fields.next_num() * scale;
                    polygon.segments.push(Segment::Line { x, y });
                }
            }
            "OC" => {
                if let Some(polygon) = polygon.as_mut() {
                    let x = fields.next_num() * scale;
                    let y = fields.next_num() * scale;
                    let cx = fields.next_num() * scale;
                    let cy = fields.next_num() * scale;
                    let cw = fields.next_is("Y");
                    polygon.segments.push(Segment::Arc { x, y, cx, cy, cw });
                }
            }
            "OE" => finish_polygon(&mut surface, &mut polygon),
            "SE" => finish_surface(&mut surface, &mut polygon, &mut records, &mut counts),
            "T" => {
                finish_surface(&mut surface, &mut polygon, &mut records, &mut counts);
                records.push(Record::Text);
                counts.texts += 1;
            }
            "B" => {
                finish_surface(&mut surface, &mut polygon, &mut records, &mut counts);
                records.push(Record::Barcode);
                counts.barcodes += 1;
            }
            _ => counts.unknown += 1,
        }
    }
    finish_surface(&mut surface, &mut polygon, &mut records, &mut counts);

    Features {
        units,
        symbol_scale: symbol_scale(units),
        symbols,
        records,
        counts,
    }
}

/// ODB++ pad orientation: 0-7 are legacy quarter turns (4-7 mirrored), 8 and 9
/// are followed by a free angle (9 mirrored). Angles are clockwise degrees.
pub(crate) fn parse_orient(fields: &mut Fields<'_>) -> Orient {
    match fields.next_str() {
        Some(code @ ("8" | "9")) => Orient {
            angle_deg: normalize_angle(fields.next_num()),
            mirror: code == "9",
        },
        Some(code) => match code.parse::<u32>() {
            Ok(legacy) if legacy <= 7 => Orient {
                angle_deg: ((legacy & 3) * 90) as f32,
                mirror: legacy >= 4,
            },
            _ => Orient {
                angle_deg: 0.0,
                mirror: false,
            },
        },
        None => Orient {
            angle_deg: 0.0,
            mirror: false,
        },
    }
}

pub(crate) fn normalize_angle(angle: f32) -> f32 {
    if !angle.is_finite() {
        return 0.0;
    }
    let normalized = angle % 360.0;
    if normalized < 0.0 {
        normalized + 360.0
    } else {
        normalized
    }
}

fn strip_attributes(line: &str) -> &str {
    match line.find(';') {
        Some(index) => &line[..index],
        None => line,
    }
}

fn num(token: Option<&str>) -> f32 {
    token
        .and_then(|token| token.parse::<f32>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

fn int(token: Option<&str>) -> i64 {
    token
        .and_then(|token| token.parse::<i64>().ok())
        .unwrap_or(-1)
}
