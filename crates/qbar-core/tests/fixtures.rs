use qbar_core::{
    DecimalChain, DecimalTicks, Frac32, Frac64, LayoutScratch, Opacity, Probability,
    ProbabilityWindow, QuantileValue, SampledQuantile, Tick, layout_pixels, layout_ticks,
    reference::layout_reference,
};
use serde_json::Value;

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap()
}
fn bits(value: &str) -> u64 {
    u64::from_str_radix(value, 16).unwrap()
}

fn check<P: Probability, V: QuantileValue>(
    case: &Value,
    values: &[V],
    window: ProbabilityWindow<P>,
) {
    let chain = match field(case, "chain") {
        "PowersOfTen" => DecimalChain::PowersOfTen,
        "OneTwo" => DecimalChain::OneTwo,
        "OneFive" => DecimalChain::OneFive,
        other => panic!("unknown fixture chain {other}"),
    };
    let exponents = case["exponents"].as_array().unwrap();
    let source = DecimalTicks::with_options(
        chain,
        field(case, "origin").parse().unwrap(),
        exponents[0].as_i64().unwrap() as i32..=exponents[1].as_i64().unwrap() as i32,
    )
    .unwrap();
    let opacity = Opacity::new(f64::from_bits(bits(field(case, "tau_bits")))).unwrap();
    let samples = SampledQuantile::new(values, window).unwrap();
    let mut reference = Vec::new();
    layout_reference(samples, &source, opacity, None, &mut reference).unwrap();
    let mut adaptive = Vec::new();
    layout_ticks(
        samples,
        &source,
        opacity,
        None,
        &mut LayoutScratch::default(),
        &mut adaptive,
    )
    .unwrap();
    let mut pixels = Vec::new();
    layout_pixels(samples, &source, opacity, None, &mut pixels).unwrap();
    assert_eq!(adaptive, reference, "{}", field(case, "name"));
    assert_eq!(pixels, reference, "{}", field(case, "name"));
    let expected = case["ticks"].as_array().unwrap();
    assert_eq!(adaptive.len(), expected.len(), "{}", field(case, "name"));
    for (
        Tick {
            value,
            family,
            position_px,
            alpha,
        },
        expected,
    ) in adaptive.iter().zip(expected)
    {
        assert_eq!(
            value.coefficient().to_string(),
            field(expected, "coefficient")
        );
        assert_eq!(
            value.exponent(),
            expected["exponent"].as_i64().unwrap() as i32
        );
        assert_eq!(
            family.multiplier(),
            expected["multiplier"].as_u64().unwrap() as u8
        );
        assert_eq!(
            family.exponent(),
            expected["family_exponent"].as_i64().unwrap() as i32
        );
        assert_eq!(
            position_px.to_bits(),
            bits(field(expected, "position_bits"))
        );
        assert_eq!(*alpha, expected["alpha"].as_u64().unwrap() as u8);
    }
}

#[test]
fn raw_bit_fixtures_match_all_layouts() {
    let document: Value =
        serde_json::from_str(include_str!("fixtures/decimal-layout.json")).unwrap();
    assert_eq!(document["schema"], 1);
    let fixtures = document["fixtures"].as_array().unwrap();
    assert!(fixtures.len() >= 13);
    for case in fixtures {
        let lo: u64 = field(case, "lo").parse().unwrap();
        let hi: u64 = field(case, "hi").parse().unwrap();
        let sample_bits: Vec<u64> = case["samples_bits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| bits(value.as_str().unwrap()))
            .collect();
        match (
            case["probability_bits"].as_u64().unwrap(),
            case["output_bits"].as_u64().unwrap(),
        ) {
            (32, 32) => check(
                case,
                &sample_bits
                    .iter()
                    .map(|&b| f32::from_bits(b as u32))
                    .collect::<Vec<_>>(),
                ProbabilityWindow::new(Frac32::new(lo as u32), Frac32::new(hi as u32)).unwrap(),
            ),
            (32, 64) => check(
                case,
                &sample_bits
                    .iter()
                    .map(|&b| f64::from_bits(b))
                    .collect::<Vec<_>>(),
                ProbabilityWindow::new(Frac32::new(lo as u32), Frac32::new(hi as u32)).unwrap(),
            ),
            (64, 32) => check(
                case,
                &sample_bits
                    .iter()
                    .map(|&b| f32::from_bits(b as u32))
                    .collect::<Vec<_>>(),
                ProbabilityWindow::new(Frac64::new(lo), Frac64::new(hi)).unwrap(),
            ),
            (64, 64) => check(
                case,
                &sample_bits
                    .iter()
                    .map(|&b| f64::from_bits(b))
                    .collect::<Vec<_>>(),
                ProbabilityWindow::new(Frac64::new(lo), Frac64::new(hi)).unwrap(),
            ),
            other => panic!("unsupported fixture types {other:?}"),
        }
    }
    let below = fixtures
        .iter()
        .find(|case| field(case, "name") == "cutoff-below")
        .unwrap();
    assert!(below["ticks"].as_array().unwrap().is_empty());
    let equal = fixtures
        .iter()
        .find(|case| field(case, "name") == "cutoff-equal")
        .unwrap();
    assert_eq!(equal["ticks"][0]["alpha"], 1);
}
