use super::*;

const REGION_OUTLINE: &str = "\
%FSLAX24Y24*%
%MOMM*%
%LPD*%
G36*
X000000Y000000D02*
G01*
X010000Y000000D01*
X010000Y010000D01*
X000000Y010000D01*
G37*
M02*";

#[test]
fn parse_layer_data_preserves_region_sources_only_when_requested() {
    let normal_layers = parse_layer_data(REGION_OUTLINE, 0.0, 0.0, true, 1, false)
        .expect("normal region outline should parse");
    assert!(!normal_layers[0].path_regions.has_source_contours());

    let outline_layers = parse_layer_data(REGION_OUTLINE, 0.0, 0.0, true, 1, true)
        .expect("outline region source should parse");
    assert!(outline_layers[0].path_regions.has_source_contours());
}
