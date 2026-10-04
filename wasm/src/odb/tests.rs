use super::envelope::{parse_envelope, LayerKind, Plating};
use super::features::Units;
use super::features::{parse_features, parse_orient, Fields, Record};
use super::layer::{place_record, Placement};
use super::lzw::{decompress_unix_z, is_unix_z};
use super::symbols::{parse_standard_symbol, shape_to_aperture, Corners, Shape, ThermalKind};
use super::tools::parse_tools;
use super::{is_odb_envelope, take_last_diagnostics};
use crate::drill::{parse_drill_with_offset, parse_drill_with_offset_and_interactions};
use crate::interaction::FeatureKind;
use crate::parser::{parse_gerber_payload_with_options, parse_gerber_with_options, GerberParser};

const MILS: f32 = 0.0254;
const MICRONS: f32 = 0.001;

fn assert_approx(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() < 1e-4,
        "expected {expected}, got {actual}"
    );
}

fn envelope(kind: &str, features: &str, extra: &[(&str, &str)]) -> String {
    let mut text =
        format!("%ODB++LAYER%\nkind={kind}\nname=TEST\n%ODB++FILE features%\n{features}\n");
    for (name, content) in extra {
        text.push_str(&format!("%ODB++FILE {name}%\n{content}\n"));
    }
    text.push_str("%ODB++END%\n");
    text
}

fn drill_envelope(plating: &str, features: &str, tools: &str) -> String {
    format!(
        "%ODB++LAYER%\nkind=drill\nname=DRILL\nplating={plating}\n%ODB++FILE features%\n{features}\n%ODB++FILE tools%\n{tools}\n%ODB++END%\n"
    )
}

fn layer_bounds(layers: &[crate::geometry::GerberData]) -> (f32, f32, f32, f32) {
    let mut bounds = (
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
    );
    for layer in layers {
        bounds.0 = bounds.0.min(layer.boundary.min_x());
        bounds.1 = bounds.1.max(layer.boundary.max_x());
        bounds.2 = bounds.2.min(layer.boundary.min_y());
        bounds.3 = bounds.3.max(layer.boundary.max_y());
    }
    bounds
}

#[test]
fn envelope_round_trip_keeps_every_file() {
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 r600\nP 1 2 0 P 0 0",
        &[
            ("symbols/Fid", "$0 r100\nP 0 0 0 P 0 0"),
            ("tools", "THICKNESS=0"),
        ],
    );
    assert!(is_odb_envelope(&text));
    assert!(is_odb_envelope(&format!("\u{feff}\n{text}")));
    assert!(!is_odb_envelope("%FSLAX24Y24*%"));
    let parsed = parse_envelope(&text).unwrap();
    assert_eq!(parsed.kind, LayerKind::Signal);
    assert_eq!(parsed.name, "TEST");
    assert_eq!(parsed.plating, Plating::All);
    assert!(parsed.features.contains("P 1 2 0 P 0 0"));
    assert_eq!(parsed.tools.map(str::trim), Some("THICKNESS=0"));
    assert_eq!(parsed.symbols.len(), 1);
    assert!(
        parsed.symbols["fid"].contains("r100"),
        "symbol names are lower-cased"
    );
    assert!(
        parse_envelope("%ODB++LAYER%\nkind=signal\n%ODB++FILE features%\nP 0 0 0 P 0 0\n").is_err()
    );
}

#[test]
fn features_parse_units_symbols_and_every_record_type() {
    let features = parse_features(
        "#comment\nUNITS=MM\n$0 r600\n$1 rect1400x800 5\n@0 .string 1\nP 1 2 0 P 0 8 30;0=1\nP 3 4 -1 1 200 N 5 9 45\nL 0 0 10 0 0 P 0\nA 0 0 1 1 1 0 0 P 0 Y\nS P 0\nOB 0 0 I\nOS 10 0\nOC 10 10 5 5 N\nOS 0 0\nOE\nOB 2 2 H\nOS 4 2\nOS 4 4\nOE\nSE\nT 0 0 standard P 0 1 1 1 'x' 1\nB 0 0 x P 0 1 1 1 'y' 1\nZ junk\n",
    );
    assert_eq!(features.units, Units::Mm);
    assert_approx(features.symbol_scale, MICRONS);
    assert_eq!(features.symbols[&1].name, "rect1400x800");
    assert_approx(features.symbols[&1].resize, 5.0);
    assert_eq!(features.records.len(), 7);
    let Record::Pad(pad) = &features.records[0] else {
        panic!()
    };
    assert_approx(pad.x, 1.0);
    assert_approx(pad.orient.angle_deg, 30.0);
    assert!(!pad.orient.mirror);
    let Record::Pad(resized) = &features.records[1] else {
        panic!()
    };
    assert_eq!(resized.sym, 1);
    assert_approx(resized.resize, 200.0);
    assert!(resized.neg);
    assert_eq!(resized.dcode, 5);
    assert!(resized.orient.mirror);
    assert_approx(resized.orient.angle_deg, 45.0);
    let Record::Arc(arc) = &features.records[3] else {
        panic!()
    };
    assert!(arc.cw);
    let Record::Surface(surface) = &features.records[4] else {
        panic!()
    };
    assert_eq!(surface.polygons.len(), 2);
    assert!(surface.polygons[1].hole);
    assert_eq!(surface.polygons[0].segments.len(), 3);
    assert_eq!(features.counts.texts, 1);
    assert_eq!(features.counts.barcodes, 1);
    assert_eq!(features.counts.unknown, 1);

    // Inch is the default and coordinates scale to mm.
    let inch = parse_features("$0 r15.748\nP 1 0 0 P 0 0\n");
    assert_eq!(inch.units, Units::Inch);
    let Record::Pad(pad) = &inch.records[0] else {
        panic!()
    };
    assert_approx(pad.x, 25.4);
    assert_approx(inch.symbol_scale, MILS);

    let orient = |text: &str| parse_orient(&mut Fields::new(text));
    assert_eq!(orient("0").angle_deg, 0.0);
    assert_eq!(orient("6").angle_deg, 180.0);
    assert!(orient("6").mirror);
    assert_eq!(orient("8 -30").angle_deg, 330.0);
    assert!(orient("9 45").mirror);
}

#[test]
fn standard_symbols_resolve_in_both_units() {
    let circle = |name: &str, scale: f32| match parse_standard_symbol(name, scale) {
        Some(Shape::Circle { d }) => d,
        other => panic!("{name} is not a circle: {other:?}"),
    };
    assert_approx(circle("r15.748", MILS), 0.4);
    assert_approx(circle("r1050", MICRONS), 1.05);
    assert!(matches!(
        parse_standard_symbol("s800", MICRONS),
        Some(Shape::Rect { w, h }) if (w - 0.8).abs() < 1e-5 && (h - 0.8).abs() < 1e-5
    ));
    assert!(matches!(
        parse_standard_symbol("rect1400x800xr250x13", MICRONS),
        Some(Shape::RoundedRect { corners, .. }) if corners.has(1) && corners.has(3) && !corners.has(2)
    ));
    assert!(matches!(
        parse_standard_symbol("donut_sr1200x600", MICRONS),
        Some(Shape::DonutSquareRound { .. })
    ));
    assert!(matches!(
        parse_standard_symbol("hole1000x1x2x3", MICRONS),
        Some(Shape::Circle { .. })
    ));
    // Angles and counts are dimensionless: they read the same in both units.
    for scale in [MICRONS, MILS] {
        assert!(matches!(
            parse_standard_symbol("thr1600x1000x45x4x300", scale),
            Some(Shape::Thermal {
                spokes: 4,
                angle_deg,
                kind: ThermalKind::RoundRounded,
                ..
            }) if angle_deg == 45.0
        ));
    }
    assert!(matches!(
        parse_standard_symbol("s_ths2400x1400x30x4x300xr200x13", MICRONS),
        Some(Shape::Thermal {
            kind: ThermalKind::Square,
            r,
            corners,
            ..
        }) if (r - 0.2).abs() < 1e-5 && corners.has(1) && corners.has(3) && !corners.has(2)
    ));
    assert!(matches!(
        parse_standard_symbol("rc_tho2800x1600x45x4x300x300", MICRONS),
        Some(Shape::Thermal {
            kind: ThermalKind::RectOpen,
            lw,
            ..
        }) if (lw - 0.3).abs() < 1e-5
    ));
    assert!(matches!(
        parse_standard_symbol("donut_rc2800x1600x400xr400x2", MICRONS),
        Some(Shape::DonutRect { r, corners, .. }) if (r - 0.4).abs() < 1e-5 && corners.has(2) && !corners.has(1)
    ));
    assert!(matches!(
        parse_standard_symbol("moire10x5x3x2x60x45", MICRONS),
        Some(Shape::Moire {
            rings: 3,
            angle_deg,
            ..
        }) if (angle_deg - 45.0).abs() < 1e-4
    ));
    assert!(matches!(
        parse_standard_symbol("oval_h1000x500", MICRONS),
        Some(Shape::HalfOval { w, h }) if (w - 1.0).abs() < 1e-5 && (h - 0.5).abs() < 1e-5
    ));
    assert!(matches!(
        parse_standard_symbol("o_ths1000x500x45x4x100x50", MICRONS),
        Some(Shape::Thermal {
            kind: ThermalKind::Oval,
            ..
        })
    ));
    assert!(matches!(
        parse_standard_symbol("hplate2400x1200x400", MICRONS),
        Some(Shape::HomePlate { .. })
    ));
    // Stencil symbols and oblong thermals end in a bare `r`/`s` style flag,
    // optionally followed by a corner radius.
    assert!(matches!(
        parse_standard_symbol("dogbone2400x1600x400x400x50xr", MICRONS),
        Some(Shape::Dogbone { round: true, ra, .. }) if ra == 0.0
    ));
    assert!(matches!(
        parse_standard_symbol("cross2400x2400x400x400x50x50xs20", MICRONS),
        Some(Shape::Cross { round: false, ra, .. }) if (ra - 0.02).abs() < 1e-6
    ));
    assert!(matches!(
        parse_standard_symbol("dogbone2400x1600x400x400x50xrx20", MICRONS),
        Some(Shape::Dogbone { round: true, ra, .. }) if (ra - 0.02).abs() < 1e-6
    ));
    assert!(matches!(
        parse_standard_symbol("oblong_ths2800x1600x0x4x300x300xr", MICRONS),
        Some(Shape::Thermal {
            kind: ThermalKind::Oval,
            ..
        })
    ));
    assert!(matches!(
        parse_standard_symbol("oblong_ths2800x1600x45x4x300x300xs", MICRONS),
        Some(Shape::Thermal {
            kind: ThermalKind::Rect,
            ..
        })
    ));
    assert!(matches!(
        parse_standard_symbol("dpack2400x2400x200x200x3x2x100", MICRONS),
        Some(Shape::DPack { columns: 3, rows: 2, ra, .. }) if (ra - 0.1).abs() < 1e-6
    ));
    assert!(matches!(
        parse_standard_symbol("s_thr2400x1600x45x4x400", MICRONS),
        Some(Shape::Thermal {
            kind: ThermalKind::LineThermal,
            ..
        })
    ));
    for name in ["null1", "fhplate2400x1600x400x800"] {
        assert_eq!(
            parse_standard_symbol(name, MICRONS),
            Some(Shape::Unsupported),
            "{name}"
        );
    }
    assert!(super::symbols::is_empty_shape(&Shape::Unsupported));
    assert!(shape_to_aperture(&Shape::Unsupported).primitives.is_empty());
    assert_eq!(parse_standard_symbol("CUSTOMD294", MICRONS), None);
    assert_eq!(parse_standard_symbol("silk_kiro", MICRONS), None);
    assert_eq!(parse_standard_symbol("construct+71", MICRONS), None);
    // Names that merely start like a standard family are user symbols.
    assert_eq!(parse_standard_symbol("r10_tp", MICRONS), None);
    assert_eq!(parse_standard_symbol("s1_via", MICRONS), None);
    assert_eq!(parse_standard_symbol("rect_custom", MICRONS), None);
    assert_eq!(parse_standard_symbol("r10x", MICRONS), None);

    let aperture = shape_to_aperture(&Shape::RoundedRect {
        w: 1.4,
        h: 0.8,
        r: 0.25,
        corners: Corners::ALL,
    });
    assert!(!aperture.primitives.is_empty());
    assert_approx(aperture.width, 1.4);
    let donut = shape_to_aperture(&Shape::DonutSquare {
        od: 1.2,
        id: 0.6,
        r: 0.0,
        corners: Corners::ALL,
    });
    assert!(!donut.primitives.is_empty());
    assert!(
        !donut.has_negative,
        "rings are positive contours, not cut-outs"
    );
    let thermal = shape_to_aperture(&thermal(1.6, 1.0, 45.0, 4, 0.3, ThermalKind::RoundRounded));
    assert!(!thermal.primitives.is_empty());
    assert!(!thermal.has_negative, "thr is built from positive segments");
    assert_approx(thermal.width, 1.6);
}

/// An `od`/`id` thermal shape (square rings use `od` for both sides).
fn thermal(od: f32, id: f32, angle_deg: f32, spokes: u32, gap: f32, kind: ThermalKind) -> Shape {
    Shape::Thermal {
        ow: od,
        oh: od,
        lw: (od - id) / 2.0,
        angle_deg,
        spokes,
        gap,
        kind,
        r: 0.0,
        corners: Corners::ALL,
    }
}

/// A `w` x `h` thermal ring of width `lw`.
fn rect_thermal(
    w: f32,
    h: f32,
    lw: f32,
    angle_deg: f32,
    spokes: u32,
    gap: f32,
    kind: ThermalKind,
) -> Shape {
    Shape::Thermal {
        ow: w,
        oh: h,
        lw,
        angle_deg,
        spokes,
        gap,
        kind,
        r: 0.0,
        corners: Corners::ALL,
    }
}

fn covers(aperture: &crate::parser::Aperture, x: f32, y: f32) -> bool {
    use crate::parser::geometry::Primitive;
    let mut inside = false;
    for primitive in &aperture.primitives {
        let (hit, exposure) = match primitive {
            Primitive::Circle {
                x: cx,
                y: cy,
                radius,
                exposure,
                hole_radius,
                ..
            } => {
                let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                (d <= *radius && d >= *hole_radius, *exposure)
            }
            Primitive::Triangle {
                vertices, exposure, ..
            } => {
                let [a, b, c] = vertices;
                let sign = |p: [f32; 2], q: [f32; 2]| {
                    (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
                };
                let (s1, s2, s3) = (sign(*a, *b), sign(*b, *c), sign(*c, *a));
                let neg = s1 < 0.0 || s2 < 0.0 || s3 < 0.0;
                let pos = s1 > 0.0 || s2 > 0.0 || s3 > 0.0;
                (!(neg && pos), *exposure)
            }
            _ => (false, 1.0),
        };
        if hit {
            inside = exposure > 0.0;
        }
    }
    inside
}

#[test]
fn symbol_geometry_matches_reference_viewer() {
    // Butterflies fill the upper-left and lower-right quadrants.
    let bfr = shape_to_aperture(&Shape::ButterflyRound { d: 2.0 });
    assert!(covers(&bfr, -0.5, 0.5));
    assert!(covers(&bfr, 0.5, -0.5));
    assert!(!covers(&bfr, 0.5, 0.5));
    assert!(!covers(&bfr, -0.5, -0.5));
    let bfs = shape_to_aperture(&Shape::ButterflySquare { s: 2.0 });
    assert!(covers(&bfs, -0.9, 0.9));
    assert!(covers(&bfs, 0.9, -0.9));
    assert!(!covers(&bfs, 0.9, 0.9));
    assert!(!covers(&bfs, -0.9, -0.9));

    // Half oval (specification picture): centred on its box, flat end at -x,
    // semicircle of diameter h at +x.
    let wide = shape_to_aperture(&Shape::HalfOval { w: 3.0, h: 1.0 });
    assert!(covers(&wide, -1.45, 0.0), "flat end reaches -w/2");
    assert!(covers(&wide, 1.45, 0.0), "apex reaches +w/2");
    assert!(!covers(&wide, 1.55, 0.0));
    assert!(!covers(&wide, 1.45, 0.4), "round end");
    assert!(covers(&wide, -1.45, 0.45), "square corners at the flat end");
    assert!(covers(&wide, 0.9, 0.45), "straight part ends at w/2 - h/2");
    // Exactly twice as tall as wide: a half disc.
    let half_disc = shape_to_aperture(&Shape::HalfOval { w: 1.0, h: 2.0 });
    assert!(
        covers(&half_disc, -0.45, 0.9),
        "flat end spans the full height"
    );
    assert!(covers(&half_disc, 0.45, 0.0));
    assert!(!covers(&half_disc, 0.45, 0.9), "semicircle of diameter h");
    // Taller than twice the width: not drawn, like the official viewer.
    assert_eq!(
        parse_standard_symbol("oval_h1000x2800", MICRONS),
        Some(Shape::Unsupported)
    );
    assert!(matches!(
        parse_standard_symbol("oval_h1400x2800", MICRONS),
        Some(Shape::HalfOval { .. })
    ));

    // Thermal rings are open at the spoke angles and solid between them.
    let (c45, s45) = (45f32.to_radians().cos(), 45f32.to_radians().sin());
    let thr = shape_to_aperture(&thermal(2.0, 1.0, 0.0, 4, 0.2, ThermalKind::RoundRounded));
    assert!(!covers(&thr, 0.75, 0.0), "gap centred on 0 degrees");
    assert!(!covers(&thr, 0.0, 0.75), "gap centred on 90 degrees");
    assert!(covers(&thr, 0.75 * c45, 0.75 * s45), "solid at 45 degrees");
    assert!(!covers(&thr, 0.0, 0.0), "centre is open");
    let ths = shape_to_aperture(&thermal(2.0, 1.0, 45.0, 4, 0.2, ThermalKind::RoundSquared));
    assert!(
        !covers(&ths, 0.75 * c45, 0.75 * s45),
        "gap centred on 45 degrees"
    );
    assert!(covers(&ths, 0.75, 0.0), "solid at 0 degrees");
    assert!(!covers(&ths, 0.0, 0.0));
    assert!(!ths.has_negative);
    // A gap wider than the opening: the centre stays open and the pieces end
    // where the gap edges meet.
    let wide_gap = shape_to_aperture(&thermal(2.0, 0.6, 0.0, 4, 0.8, ThermalKind::RoundSquared));
    assert!(!covers(&wide_gap, 0.0, 0.0), "centre stays open");
    assert!(!covers(&wide_gap, 0.2, 0.2), "inside the gap band");
    assert!(
        covers(&wide_gap, 0.55, 0.55),
        "piece starts where the gap edges meet"
    );
    assert!(!covers(&wide_gap, 0.9, 0.1));
    let s_ths = shape_to_aperture(&thermal(2.0, 1.0, 0.0, 4, 0.2, ThermalKind::Square));
    assert!(covers(&s_ths, 0.9, 0.9), "square ring reaches its corner");
    assert!(!covers(&s_ths, 0.75, 0.0), "gap centred on 0 degrees");
    assert!(!covers(&s_ths, 0.0, 0.0), "square centre is open");
    assert!(!s_ths.has_negative, "gaps are not negative primitives");
    let sr_ths = shape_to_aperture(&thermal(2.0, 1.0, 45.0, 4, 0.2, ThermalKind::SquareRound));
    assert!(covers(&sr_ths, 0.9, 0.0), "square outside");
    assert!(!covers(&sr_ths, 0.45, 0.0), "round inside");
    assert!(covers(&sr_ths, 0.55, 0.0), "ring between circle and square");
    assert!(
        !covers(&sr_ths, 0.7 * c45, -0.7 * s45),
        "gap at 315 degrees"
    );
    assert!(!covers(&sr_ths, 0.9, 0.9), "gap at the corner");
    let rc_ths = shape_to_aperture(&rect_thermal(
        4.0,
        2.0,
        0.3,
        45.0,
        4,
        0.2,
        ThermalKind::Rect,
    ));
    assert!(covers(&rc_ths, 0.0, 0.85), "long side is solid");
    assert!(!covers(&rc_ths, 1.85, 0.85), "diagonal gap cuts the corner");
    assert!(!covers(&rc_ths, 0.0, 0.0));
    assert!(!rc_ths.has_negative);
    // Open corners: only bars remain, cut square where the gap meets the inner edge.
    let s_tho = shape_to_aperture(&thermal(2.4, 1.4, 45.0, 4, 0.3, ThermalKind::SquareOpen));
    assert!(covers(&s_tho, 0.0, 0.95), "top bar");
    assert!(covers(&s_tho, 0.4, 0.95));
    assert!(!covers(&s_tho, 0.6, 0.95), "bar ends before the corner");
    assert!(!covers(&s_tho, 0.95, 0.95), "corner is open");
    assert!(!covers(&s_tho, 0.0, 0.0));
    // Axis-aligned spokes cut their own bar and leave the corners joined, so
    // the ring becomes four L pieces.
    let s_tho0 = shape_to_aperture(&thermal(2.4, 1.4, 0.0, 4, 0.3, ThermalKind::SquareOpen));
    assert!(
        !covers(&s_tho0, 0.0, 0.95),
        "gap splits the bar in the middle"
    );
    assert!(covers(&s_tho0, 0.4, 0.95));
    assert!(covers(&s_tho0, 0.95, 0.95), "corners stay joined");
    assert!(!covers(&s_tho0, 0.0, 0.0));
    // Two diagonal spokes: only their corners open, the other two stay closed.
    let s_tho2 = shape_to_aperture(&thermal(2.4, 1.4, 45.0, 2, 0.3, ThermalKind::SquareOpen));
    assert!(
        !covers(&s_tho2, 0.95, 0.95),
        "top-right corner opened by the 45 degree spoke"
    );
    assert!(
        !covers(&s_tho2, -0.95, -0.95),
        "bottom-left corner opened by the 225 degree spoke"
    );
    assert!(covers(&s_tho2, -0.95, 0.95), "top-left corner stays closed");
    assert!(
        covers(&s_tho2, 0.95, -0.95),
        "bottom-right corner stays closed"
    );
    assert!(
        covers(&s_tho2, 0.0, 0.95),
        "no axis spoke, so the top bar is whole"
    );
    assert!(
        covers(&s_tho2, -0.95, 0.0),
        "left bar runs the full inner height"
    );
    let rc_tho = shape_to_aperture(&rect_thermal(
        2.8,
        1.6,
        0.3,
        45.0,
        4,
        0.3,
        ThermalKind::RectOpen,
    ));
    assert!(covers(&rc_tho, 0.0, 0.65));
    assert!(
        covers(&rc_tho, 0.6, 0.65),
        "long bar reaches past the short bar's end"
    );
    assert!(!covers(&rc_tho, 1.25, 0.65), "corner is open");
    assert!(covers(&rc_tho, 1.25, 0.0), "short bar");
    assert!(
        !covers(&rc_tho, 1.25, 0.45),
        "short bar ends where the gap meets its inner edge"
    );
    let o_ths = shape_to_aperture(&rect_thermal(2.8, 1.6, 0.3, 0.0, 4, 0.3, ThermalKind::Oval));
    assert!(covers(&o_ths, 0.3, 0.65), "straight part of the oval ring");
    assert!(!covers(&o_ths, 0.0, 0.65), "gap at 90 degrees");
    assert!(!covers(&o_ths, 1.25, 0.0), "gap at 0 degrees");
    assert!(covers(&o_ths, 1.2, 0.5), "round end of the ring");
    assert!(!covers(&o_ths, 0.0, 0.0));
    assert!(!covers(&o_ths, 0.0, 0.3), "inner oval is open");

    // Rounded donuts: the outer corners use the radius, the inner ones the
    // radius minus the ring width.
    let donut = shape_to_aperture(&Shape::DonutSquare {
        od: 2.4,
        id: 1.2,
        r: 0.4,
        corners: Corners::ALL,
    });
    assert!(covers(&donut, 1.15, 0.0));
    assert!(!covers(&donut, 1.15, 1.15), "outer corner rounded");
    assert!(covers(&donut, 0.95, 0.95));
    assert!(!covers(&donut, 0.5, 0.5), "inside the opening");
    assert!(!donut.has_negative);
    let donut_rc = shape_to_aperture(&Shape::DonutRect {
        ow: 2.8,
        oh: 1.6,
        lw: 0.4,
        r: 0.4,
        corners: Corners::parse("2"),
    });
    assert!(!covers(&donut_rc, -1.35, 0.75), "top-left corner rounded");
    assert!(covers(&donut_rc, 1.35, 0.75), "top-right corner square");
    assert!(covers(&donut_rc, -1.35, -0.75));
    assert!(!covers(&donut_rc, 0.0, 0.0));

    // Stencil symbols (official viewer pictures): home plate points +x,
    // the inverted one is notched at +x, radhplate has a round bite,
    // dshape a round +x end.
    let hplate = shape_to_aperture(&Shape::HomePlate {
        w: 2.4,
        h: 1.6,
        c: 0.8,
        ra: 0.0,
        ro: 0.0,
    });
    assert!(covers(&hplate, 1.15, 0.0), "tip");
    assert!(!covers(&hplate, 1.15, 0.7), "cut corner");
    assert!(covers(&hplate, 0.3, 0.7));
    let rhplate = shape_to_aperture(&Shape::InvertedHomePlate {
        w: 2.4,
        h: 1.6,
        c: 0.8,
        ra: 0.0,
        ro: 0.0,
    });
    assert!(!covers(&rhplate, 1.1, 0.0), "notch");
    assert!(
        covers(&rhplate, 1.0, 0.75),
        "acute corner above the notch edge"
    );
    assert!(covers(&rhplate, -1.1, 0.0));
    let radhplate = shape_to_aperture(&Shape::RadiusedInvertedHomePlate {
        w: 2.4,
        h: 1.6,
        ms: 1.2,
        ra: 0.0,
    });
    assert!(
        !covers(&radhplate, 0.9, 0.0),
        "bite of radius 0.6 at the +x edge"
    );
    assert!(covers(&radhplate, 1.15, 0.7));
    assert!(covers(&radhplate, 0.5, 0.0));
    let dshape = shape_to_aperture(&Shape::RadiusedHomePlate {
        w: 2.4,
        h: 1.6,
        r: 0.8,
        ra: 0.0,
    });
    assert!(covers(&dshape, 1.15, 0.0), "apex of the round end");
    assert!(!covers(&dshape, 1.15, 0.75), "round end");
    assert!(covers(&dshape, 0.3, 0.75));
    let cross = |round: bool| {
        shape_to_aperture(&Shape::Cross {
            w: 2.4,
            h: 2.4,
            hs: 0.4,
            vs: 0.4,
            hc: 50.0,
            vc: 50.0,
            round,
            ra: 0.0,
        })
    };
    assert!(covers(&cross(false), 1.1, 0.0));
    assert!(covers(&cross(false), 0.0, 1.1));
    assert!(!covers(&cross(false), 0.9, 0.9));
    assert!(
        covers(&cross(false), 1.19, 0.19),
        "square end fills the corner"
    );
    assert!(!covers(&cross(true), 1.19, 0.19), "round end");
    let dogbone = |round: bool| {
        shape_to_aperture(&Shape::Dogbone {
            w: 2.4,
            h: 1.6,
            hs: 0.4,
            vs: 0.4,
            hc: 50.0,
            round,
            ra: 0.0,
        })
    };
    assert!(covers(&dogbone(false), 1.1, 0.6), "top bar");
    assert!(covers(&dogbone(false), 0.0, 0.0), "connector");
    assert!(!covers(&dogbone(false), 0.9, 0.0), "between the bars");
    assert!(covers(&dogbone(false), 1.19, 0.79));
    assert!(!covers(&dogbone(true), 1.19, 0.79), "round bar ends");
    let dpack = shape_to_aperture(&Shape::DPack {
        w: 2.4,
        h: 2.4,
        hg: 0.2,
        vg: 0.2,
        columns: 2,
        rows: 2,
        ra: 0.0,
    });
    assert!(covers(&dpack, -0.65, -0.65), "pad centre");
    assert!(!covers(&dpack, 0.0, 0.0), "gap");
    assert!(!covers(&dpack, 0.05, -0.65));
    let s_thr = shape_to_aperture(&thermal(2.4, 1.6, 45.0, 4, 0.4, ThermalKind::LineThermal));
    assert!(covers(&s_thr, 0.0, 1.0), "bar");
    assert!(!covers(&s_thr, 0.0, 0.0));
    assert!(!covers(&s_thr, 1.0, 1.0), "open corner");
    assert!(!s_thr.has_negative);

    // Moire: dot, then rings separated by the gap, from the centre outwards.
    let moire = shape_to_aperture(&Shape::Moire {
        ring_width: 0.2,
        ring_gap: 0.3,
        rings: 2,
        line_width: 0.1,
        line_length: 3.0,
        angle_deg: 0.0,
    });
    // Probe along 45 degrees, away from the crosshair lines.
    let at = |r: f32| (r * c45, r * s45);
    let on_ring = |r: f32| {
        let (x, y) = at(r);
        covers(&moire, x, y)
    };
    assert!(on_ring(0.05), "centre dot");
    assert!(!on_ring(0.25), "first gap");
    assert!(on_ring(0.5), "first ring 0.4..0.6");
    assert!(!on_ring(0.8), "second gap 0.6..0.9");
    assert!(on_ring(1.0), "second ring 0.9..1.1");
    assert!(!on_ring(1.2), "nothing past the last ring");
    assert!(
        covers(&moire, 1.4, 0.0),
        "crosshair reaches the line length"
    );
    assert!(!covers(&moire, 1.4, 0.4));
}

#[test]
fn tools_files_scale_sizes_by_their_units() {
    let tools = parse_tools(
        "UNITS=MM\nTHICKNESS=0\nTOOLS {\n    NUM=1\n    TYPE=VIA\n    FINISH_SIZE=300\n}\nTOOLS {\n    NUM=2\n    TYPE=NON_PLATED\n    FINISH_SIZE=1000\n}\n",
        Units::Inch,
    );
    assert_eq!(tools.units, Units::Mm);
    assert_eq!(tools.tools.len(), 2);
    assert_approx(tools.tools[0].finish_size_mm.unwrap(), 0.3);
    assert_eq!(tools.tools[1].tool_type, super::tools::ToolType::NonPlated);
    let inch = parse_tools(
        "TOOLS {\n NUM=1\n TYPE=PLATED\n FINISH_SIZE=39.37\n}\n",
        Units::Inch,
    );
    assert_approx(inch.tools[0].finish_size_mm.unwrap(), 1.0);
}

#[test]
fn pads_flash_with_odb_orientation() {
    // A 2 x 1 mm rectangle rotated 90 degrees clockwise spans 1 x 2 mm.
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 rect2000x1000\nP 10 10 0 P 0 1\n",
        &[],
    );
    let layers = parse_gerber_with_options(&text, true, 1).unwrap();
    let (min_x, max_x, min_y, max_y) = layer_bounds(&layers);
    assert_approx(max_x - min_x, 1.0);
    assert_approx(max_y - min_y, 2.0);
    assert_approx((min_x + max_x) / 2.0, 10.0);

    // Mirrored pads keep their angle; a rotated pad off-axis lands where the
    // clockwise convention says (a 4 x 0.2 bar at 8 30 leans down to the right).
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 rect4000x200\nP 0 0 0 P 0 8 30\n",
        &[],
    );
    let payload = parse_gerber_payload_with_options(&text, true, 1).unwrap();
    let feature = &payload.interaction_layer.unwrap().features[0];
    assert_eq!(feature.descriptor.kind, FeatureKind::Flash);
    let (_, max_x, min_y, _) = layer_bounds(&payload.render_layers);
    assert!(max_x > 1.6, "bar reaches right");
    assert!(min_y < -0.9, "right end is rotated clockwise (downwards)");

    // Mirroring is "along the x-axis (left to right, changing x coordinates)"
    // and happens after the rotation: a 2 x 2 triangle at `9 30` lands where
    // M_x · R_cw(30°) puts its vertices.
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 tri2000x2000\nP 0 0 0 P 0 9 30\n",
        &[],
    );
    let layers = parse_gerber_with_options(&text, true, 1).unwrap();
    let (min_x, max_x, min_y, max_y) = layer_bounds(&layers);
    let (c, s) = (30f32.to_radians().cos(), 30f32.to_radians().sin());
    let expected: Vec<[f32; 2]> = [[-1.0f32, -1.0], [1.0, -1.0], [0.0, 1.0]]
        .iter()
        .map(|[x, y]| [-(x * c + y * s), -x * s + y * c])
        .collect();
    let bound =
        |axis: usize, max: bool| {
            expected.iter().map(|p| p[axis]).fold(
                if max { f32::MIN } else { f32::MAX },
                |acc, v| if max { acc.max(v) } else { acc.min(v) },
            )
        };
    assert_approx(min_x, bound(0, false));
    assert_approx(max_x, bound(0, true));
    assert_approx(min_y, bound(1, false));
    assert_approx(max_y, bound(1, true));
}

#[test]
fn lines_arcs_and_surfaces_become_geometry() {
    let features = "UNITS=MM\n$0 r200\n$1 s300\n$2 rect1000x500\nL 0 0 10 0 0 P 0\nL 0 5 10 5 1 P 0\nL 3 3 3 3 1 P 0\nL 0 8 10 8 2 P 0\nA 20 0 22 2 20 2 0 P 0 N\nA 30 0 30 0 31 0 0 P 0 Y\nS P 0\nOB 0 20 I\nOS 0 30\nOS 10 30\nOC 12 28 10 28 Y\nOS 12 20\nOS 0 20\nOE\nOB 2 22 H\nOS 6 22\nOS 6 26\nOS 2 26\nOS 2 22\nOE\nSE\n";
    let text = envelope("signal", features, &[]);
    let payload = parse_gerber_payload_with_options(&text, true, 1).unwrap();
    let kinds: Vec<FeatureKind> = payload
        .interaction_layer
        .as_ref()
        .unwrap()
        .features
        .iter()
        .map(|feature| feature.descriptor.kind.clone())
        .collect();
    assert_eq!(
        kinds,
        vec![
            FeatureKind::Draw,
            FeatureKind::Draw,
            FeatureKind::Flash,
            FeatureKind::Draw,
            FeatureKind::ArcDraw,
            FeatureKind::ArcDraw,
            FeatureKind::Region,
        ]
    );
    let (min_x, max_x, min_y, max_y) = layer_bounds(&payload.render_layers);
    // The rect pen line is drawn round with the smaller dimension (0.5 mm).
    assert_approx(min_x, -0.25);
    // The full circle at (31, 0) with radius 1 plus half the 0.2 mm pen.
    assert_approx(max_x, 32.1);
    assert_approx(min_y, -1.1);
    assert_approx(max_y, 30.0);
    assert_eq!(
        take_last_diagnostics().as_deref(),
        Some("Skipped or approximated: 1 line with non-round symbols drawn round")
    );

    // The hole survives in approximate mode too: the island is triangulated
    // with its hole, so no triangle covers the hole centre.
    let layers = parse_gerber_with_options(&text, false, 1).unwrap();
    let mut covers_hole = false;
    let mut covers_island = false;
    for layer in &layers {
        for triangle in layer.triangles.vertices.chunks_exact(6) {
            let tri = [
                [triangle[0], triangle[1]],
                [triangle[2], triangle[3]],
                [triangle[4], triangle[5]],
            ];
            covers_hole |= point_in_triangle([4.0, 24.0], tri);
            covers_island |= point_in_triangle([8.0, 24.0], tri);
        }
    }
    assert!(covers_island, "island filled");
    assert!(!covers_hole, "hole left open");
}

fn point_in_triangle(p: [f32; 2], t: [[f32; 2]; 3]) -> bool {
    let sign = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| {
        (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1])
    };
    let d1 = sign(p, t[0], t[1]);
    let d2 = sign(p, t[1], t[2]);
    let d3 = sign(p, t[2], t[0]);
    let has_neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_neg && has_pos)
}

#[test]
fn negative_features_open_clear_polarity_layers() {
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 r1000\n$1 r400\nP 0 0 0 P 0 0\nP 0 0 1 N 0 0\nP 5 0 0 P 0 0\n",
        &[],
    );
    let layers = parse_gerber_with_options(&text, true, 1).unwrap();
    let polarities: Vec<bool> = layers.iter().map(|layer| layer.is_negative).collect();
    assert_eq!(polarities, vec![false, true, false]);
}

#[test]
fn profile_layers_are_stroked_not_filled() {
    let text = envelope(
        "profile",
        "UNITS=MM\nS P 0\nOB 0 0 I\nOS 0 30\nOS 40 30\nOS 40 4\nOC 36 0 36 4 Y\nOS 0 0\nOE\nSE\n",
        &[],
    );
    let layers = parse_gerber_with_options(&text, true, 1).unwrap();
    let (min_x, max_x, min_y, max_y) = layer_bounds(&layers);
    assert_approx(min_x, -0.05);
    assert_approx(max_x, 40.05);
    assert_approx(min_y, -0.05);
    assert_approx(max_y, 30.05);
    let triangles: usize = layers
        .iter()
        .map(|layer| layer.triangles.vertices.len())
        .sum();
    assert_eq!(triangles, 0, "an outline has no filled area");
    assert!(
        layers.iter().any(|layer| !layer.arcs.x.is_empty()),
        "the corner stays an arc"
    );
}

#[test]
fn user_symbols_expand_in_place_with_nesting_and_polarity() {
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 fid\n$1 missing\nP 10 10 0 P 0 0\nP 20 20 0 N 0 8 45\nP 30 30 1 P 0 0\nP 40 40 -1 0 100 P 0 0\n",
        &[
            ("symbols/ring", "UNITS=MM\n$0 r200\nA 1 0 1 0 0 0 0 P 0 Y\n"),
            (
                "symbols/fid",
                "UNITS=MM\n$0 r500\n$1 ring\n$2 r0\nP 0 0 0 P 0 0\nP 0 0 1 P 0 0\nL 0 0 0.5 0 2 P 0\nT 0 0 standard P 0 1 1 1 'x' 1\n",
            ),
        ],
    );
    let payload = parse_gerber_payload_with_options(&text, true, 1).unwrap();
    let features = &payload.interaction_layer.as_ref().unwrap().features;
    let flashes = features
        .iter()
        .filter(|feature| feature.descriptor.kind == FeatureKind::Flash)
        .count();
    let arcs = features
        .iter()
        .filter(|feature| feature.descriptor.kind == FeatureKind::ArcDraw)
        .count();
    assert_eq!(flashes, 3, "one r500 dot per expansion; r0 draws nothing");
    assert_eq!(arcs, 3, "the nested ring is expanded each time");
    assert!(
        payload.render_layers.iter().any(|layer| layer.is_negative),
        "negative pad clears its symbol"
    );
    let (min_x, max_x, _, _) = layer_bounds(&payload.render_layers);
    assert_approx(min_x, 10.0 - 1.1);
    assert_approx(max_x, 40.0 + 1.1);
    let diagnostics = take_last_diagnostics().unwrap();
    assert!(diagnostics.contains("3 text records"), "{diagnostics}");
    assert!(
        diagnostics.contains("(missing; symbol not found in job)"),
        "{diagnostics}"
    );
    assert!(
        diagnostics.contains("resize ignored on user-defined symbols (fid)"),
        "{diagnostics}"
    );
}

#[test]
fn user_symbol_surfaces_are_placed_at_every_pad() {
    // A symbol whose only record is a surface: it is drawn straight into the
    // pad's coordinate system instead of being copied per pad.
    let symbol = "UNITS=MM
S P 0
OB 0 0 I
OS 2 0
OS 2 1
OS 0 1
OS 0 0
OE
OB 0.4 0.4 H
OS 1.6 0.4
OS 1.6 0.6
OS 0.4 0.6
OS 0.4 0.4
OE
SE
";
    let text = envelope(
        "signal",
        "UNITS=MM
$0 plate
P 10 10 0 P 0 0
P 20 20 0 N 0 4
",
        &[("symbols/plate", symbol)],
    );
    let payload = parse_gerber_payload_with_options(&text, true, 1).unwrap();
    let (min_x, max_x, min_y, max_y) = layer_bounds(&payload.render_layers);
    assert_approx(min_x, 10.0);
    // The mirrored copy runs from 18 to 20, not from 20 to 22.
    assert_approx(max_x, 20.0);
    assert_approx(min_y, 10.0);
    assert_approx(max_y, 21.0);
    assert!(
        payload.render_layers.iter().any(|layer| layer.is_negative),
        "the negative pad clears its surface"
    );
    let regions = payload
        .interaction_layer
        .unwrap()
        .features
        .iter()
        .filter(|feature| feature.descriptor.kind == FeatureKind::Region)
        .count();
    assert_eq!(regions, 2, "one region per pad");
}

#[test]
fn user_symbols_named_like_standard_families_are_expanded() {
    // The maintainer's case: `r10_tp` is a user symbol, not `r10`.
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 r10_tp\nP 5 5 0 P 0 0\n",
        &[("symbols/r10_tp", "UNITS=MM\n$0 r500\nP 0 0 0 P 0 0\n")],
    );
    let layers = parse_gerber_with_options(&text, true, 1).unwrap();
    let (min_x, max_x, _, _) = layer_bounds(&layers);
    assert_approx(min_x, 4.75);
    assert_approx(max_x, 5.25);
    assert_eq!(take_last_diagnostics(), None, "nothing skipped");
}

#[test]
fn degenerate_square_lines_flash_instead_of_producing_nan() {
    let text = envelope(
        "signal",
        "UNITS=MM\n$0 s400\nL 3 3 3 3 0 P 0\nL 7 7 7.00000001 7 0 P 0\n",
        &[],
    );
    let layers = parse_gerber_with_options(&text, true, 1).unwrap();
    for layer in &layers {
        assert!(layer
            .triangles
            .vertices
            .iter()
            .all(|value| value.is_finite()));
        assert!(layer.boundary.min_x().is_finite() && layer.boundary.max_y().is_finite());
    }
    let (min_x, max_x, _, _) = layer_bounds(&layers);
    assert_approx(min_x, 2.8);
    assert_approx(max_x, 7.2);
}

#[test]
fn placement_composes_orientation_and_mirrors_arcs() {
    let symbol = parse_features(
        "UNITS=MM\n$0 rect1000x500\n$1 r100\nP 1 0 0 P 0 8 30\nA 1 0 0 1 0 0 1 P 0 N\n",
    );
    let (Record::Pad(pad), Record::Arc(arc)) = (&symbol.records[0], &symbol.records[1]) else {
        panic!()
    };

    let plain = parse_features("UNITS=MM\n$0 x\nP 5 5 0 P 0 1\n");
    let Record::Pad(outer) = &plain.records[0] else {
        panic!()
    };
    let placement = Placement::new(outer);
    let Record::Pad(placed) = place_record(&Record::Pad(pad.clone()), &placement) else {
        panic!()
    };
    assert_approx(placed.x, 5.0);
    assert_approx(placed.y, 4.0);
    assert_approx(placed.orient.angle_deg, 120.0);
    assert!(!placed.orient.mirror);

    let mirrored_outer = parse_features("UNITS=MM\n$0 x\nP 0 0 0 N 0 9 90\n");
    let Record::Pad(outer) = &mirrored_outer.records[0] else {
        panic!()
    };
    let placement = Placement::new(outer);
    let Record::Pad(placed) = place_record(&Record::Pad(pad.clone()), &placement) else {
        panic!()
    };
    // The inner pad is not mirrored, so the outer rotation adds: 30 + 90.
    assert_approx(placed.orient.angle_deg, 120.0);
    assert!(placed.orient.mirror);
    assert!(placed.neg);
    // (1, 0) rotated 90 degrees clockwise is (0, -1); mirroring x keeps it.
    assert_approx(placed.x, 0.0);
    assert_approx(placed.y, -1.0);

    // Mirror only: x changes sign, y does not.
    let mirror_only = parse_features("UNITS=MM\n$0 x\nP 0 0 0 P 0 4\n");
    let Record::Pad(outer) = &mirror_only.records[0] else {
        panic!()
    };
    let Record::Pad(flipped) = place_record(&Record::Pad(pad.clone()), &Placement::new(outer))
    else {
        panic!()
    };
    assert_approx(flipped.x, -1.0);
    assert_approx(flipped.y, 0.0);
    // A mirrored inner pad inside a mirrored outer pad: the mirrors cancel and
    // the outer rotation is subtracted.
    let inner_mirrored = parse_features("UNITS=MM\n$0 x\nP 0 0 0 P 0 9 30\n");
    let Record::Pad(inner) = &inner_mirrored.records[0] else {
        panic!()
    };
    let Record::Pad(composed) = place_record(&Record::Pad(inner.clone()), &placement) else {
        panic!()
    };
    assert!(!composed.orient.mirror);
    assert_approx(composed.orient.angle_deg, 300.0);
    let Record::Arc(placed_arc) = place_record(&Record::Arc(arc.clone()), &placement) else {
        panic!()
    };
    assert!(placed_arc.cw, "mirroring reverses the arc direction");
    assert_approx(placed_arc.xc, 0.0);
}

#[test]
fn drill_layers_split_by_plating_and_keep_slots_and_arcs() {
    let features = "UNITS=MM\n$0 r300\n$1 r1000\n$2 r600\nP 1 1 0 P 1 0\nP 2 2 0 P 1 0\nP 5 5 1 P 2 0\nL 8 8 12 8 2 P 3 0\nA 20 0 24 4 20 4 2 P 3 0 N\nS P 0\nOB 0 0 I\nOS 1 0\nOS 1 1\nOE\nSE\n";
    let tools = "UNITS=MM\nTOOLS {\n NUM=1\n TYPE=VIA\n FINISH_SIZE=300\n}\nTOOLS {\n NUM=2\n TYPE=NON_PLATED\n FINISH_SIZE=1000\n}\nTOOLS {\n NUM=3\n TYPE=PLATED\n FINISH_SIZE=600\n}\n";

    let plated = parse_drill_with_offset_and_interactions(
        &drill_envelope("plated", features, tools),
        0.0,
        0.0,
        0.0,
    )
    .unwrap();
    assert_eq!(plated.metadata.hit_count, 2);
    assert_eq!(plated.metadata.slot_count, 2, "one slot and one arc cut");
    assert_eq!(plated.metadata.tools.len(), 2);
    assert_approx(plated.metadata.tools[0].diameter_mm, 0.3);
    assert!(
        !plated.fill_layer.arcs.x.is_empty(),
        "the rout arc stays an arc"
    );
    assert_eq!(
        take_last_diagnostics().as_deref(),
        Some("Skipped or approximated: 1 surface")
    );

    let non_plated = parse_drill_with_offset(
        &drill_envelope("non_plated", features, tools),
        0.0,
        0.0,
        0.0,
    )
    .unwrap();
    assert_eq!(non_plated.metadata.hit_count, 1);
    assert_approx(non_plated.metadata.tools[0].diameter_mm, 1.0);

    let all =
        parse_drill_with_offset(&drill_envelope("all", features, tools), 0.0, 5.0, 0.0).unwrap();
    assert_eq!(all.metadata.hit_count, 3);
    assert_approx(all.fill_layer.boundary.min_x(), 5.0 + 1.0 - 0.15);

    // A tools file without UNITS follows the layer's units (mm here), so the
    // 1000 finish size is 1 mm and matches the non-plated tool by size.
    let tools_no_units = "TOOLS {\n NUM=2\n TYPE=NON_PLATED\n FINISH_SIZE=1000\n}\n";
    let by_size = parse_drill_with_offset(
        &drill_envelope(
            "non_plated",
            "UNITS=MM\n$0 r1000\nP 5 5 0 P 9 0\n",
            tools_no_units,
        ),
        0.0,
        0.0,
        0.0,
    )
    .unwrap();
    assert_eq!(
        by_size.metadata.hit_count, 1,
        "matched by size in layer units"
    );
}

/// The text every `.Z` fixture in `testdata/` was made from (by the test
/// encoder that is cross-checked against GNU `gzip -d`).
fn lzw_fixture_text() -> Vec<u8> {
    let mut text = String::new();
    for index in 0..600u64 {
        text.push_str(&format!(
            "P {} {} {} P 0 {}\n",
            (index * 7919) % 1000,
            (index * 104729) % 1000,
            index % 13,
            index % 9
        ));
    }
    text.into_bytes()
}

#[test]
fn unix_z_streams_decode_across_width_growth_clear_and_narrow_tables() {
    let expected = lzw_fixture_text();
    assert!(expected.len() > 10_000);
    for (name, bytes) in [
        (
            "growth.Z (12-bit)",
            &include_bytes!("testdata/growth.Z")[..],
        ),
        (
            "clear.Z (16-bit, CLEAR every 700 codes)",
            &include_bytes!("testdata/clear.Z")[..],
        ),
        (
            "narrow.Z (9-bit, table fills)",
            &include_bytes!("testdata/narrow.Z")[..],
        ),
    ] {
        let output = decompress_unix_z(bytes, usize::MAX).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(output == expected, "{name} round trip");
    }
    assert_eq!(
        decompress_unix_z(include_bytes!("testdata/kwkwk.Z"), usize::MAX).unwrap(),
        b"abababababababab"
    );
    assert!(
        decompress_unix_z(include_bytes!("testdata/empty.Z"), usize::MAX)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn unix_z_rejects_bad_input_and_caps_output() {
    assert!(!is_unix_z(&[1, 2, 3]));
    assert!(decompress_unix_z(&[1, 2, 3], usize::MAX)
        .unwrap_err()
        .contains("not in UNIX compress"));
    assert!(
        decompress_unix_z(&[0x1f, 0x9d, 0x08], usize::MAX).is_err(),
        "bad code width"
    );
    let error = decompress_unix_z(include_bytes!("testdata/growth.Z"), 100).unwrap_err();
    assert!(error.contains("could not be decompressed"), "{error}");
    // A code that is not defined yet is corrupt data, not a panic.
    let mut corrupt = include_bytes!("testdata/growth.Z").to_vec();
    corrupt[3] = 0xff;
    corrupt[4] = 0xff;
    assert!(decompress_unix_z(&corrupt, usize::MAX).is_err());
}

#[test]
fn envelope_errors_and_empty_layers() {
    // Error paths stay `String`s until the WASM boundary, so they can be
    // checked natively here.
    let error = parse_envelope("%ODB++LAYER%\nkind=bogus\n%ODB++END%\n")
        .err()
        .expect("bogus kind must fail");
    assert!(error.contains("unknown kind"), "{error}");
    let error = parse_envelope("%ODB++LAYER%\nkind=signal\n%ODB++FILE features%\nP 0 0 0 P 0 0\n")
        .err()
        .expect("missing end marker must fail");
    assert!(error.contains("truncated"), "{error}");

    // Nothing drawable yields no layers; the WASM entry point turns that into
    // the usual "no geometry" error.
    let empty = envelope("signal", "UNITS=MM\n$0 r0\nP 0 0 0 P 0 0\n", &[]);
    let mut parser = GerberParser::with_options(true, 1);
    assert!(parser.parse(&empty).unwrap().is_empty());
}
