//! Print reproducible raw-bit fixtures, with expected output from the independent oracle.
use qbar_core::{
    DecimalChain, DecimalTicks, ExactDecimal, Frac32, Frac64, Opacity, Probability,
    ProbabilityWindow, QuantileValue, SampledQuantile, reference::layout_reference,
};
use serde_json::{Value, json};

fn fixture<P: Probability, V: QuantileValue>(
    name: &str,
    values: &[V],
    window: ProbabilityWindow<P>,
    source: &DecimalTicks,
    opacity: Opacity,
    output_bits: u8,
) -> Value {
    let samples = SampledQuantile::new(values, window).unwrap();
    let mut ticks = Vec::new();
    layout_reference(samples, source, opacity, None, &mut ticks).unwrap();
    let families: Vec<_> = source.families().collect();
    json!({
        "name": name,
        "probability_bits": P::BITS,
        "output_bits": output_bits,
        "lo": window.lo().raw().to_string(),
        "hi": window.hi().raw().to_string(),
        "chain": match source.chain() {
            DecimalChain::PowersOfTen => "PowersOfTen",
            DecimalChain::OneTwo => "OneTwo",
            DecimalChain::OneFive => "OneFive",
        },
        "origin": source.origin().to_string(),
        "exponents": [families.first().unwrap().exponent(), families.last().unwrap().exponent()],
        "tau_bits": format!("{:016x}", opacity.scale().to_bits()),
        "samples_bits": values.iter().map(|value| {
            if output_bits == 32 { format!("{:08x}", (value.as_f64() as f32).to_bits()) }
            else { format!("{:016x}", value.as_f64().to_bits()) }
        }).collect::<Vec<_>>(),
        "ticks": ticks.iter().map(|tick| json!({
            "coefficient": tick.value.coefficient().to_string(),
            "exponent": tick.value.exponent(),
            "multiplier": tick.family.multiplier(),
            "family_exponent": tick.family.exponent(),
            "position_bits": format!("{:016x}", tick.position_px.to_bits()),
            "alpha": tick.alpha,
        })).collect::<Vec<_>>()
    })
}

fn main() {
    let source =
        DecimalTicks::with_options(DecimalChain::OneTwo, "0.125".parse().unwrap(), -6..=6).unwrap();
    let values: Vec<f64> = (0..=32).map(|i| -1.0 + f64::from(i) / 16.0).collect();
    let values32: Vec<f32> = values.iter().map(|&x| x as f32).collect();
    let opacity = Opacity::new(1.0).unwrap();
    let mut fixtures = vec![
        fixture(
            "frac32-f32",
            &values32,
            ProbabilityWindow::<Frac32>::default(),
            &source,
            opacity,
            32,
        ),
        fixture(
            "frac32-f64",
            &values,
            ProbabilityWindow::<Frac32>::default(),
            &source,
            opacity,
            64,
        ),
        fixture(
            "frac64-f32",
            &values32,
            ProbabilityWindow::<Frac64>::default(),
            &source,
            opacity,
            32,
        ),
        fixture(
            "frac64-f64",
            &values,
            ProbabilityWindow::<Frac64>::default(),
            &source,
            opacity,
            64,
        ),
    ];
    let source =
        DecimalTicks::with_options(DecimalChain::OneFive, ExactDecimal::zero(), -6..=6).unwrap();
    let values: Vec<f64> = (0..=48)
        .map(|i| 8.99 + f64::from(i / 16) + f64::from(i % 16) * 0.002)
        .collect();
    fixtures.push(fixture(
        "nonlinear-refinement",
        &values,
        ProbabilityWindow::<Frac64>::default(),
        &source,
        Opacity::default(),
        64,
    ));
    fixtures.push(fixture(
        "flats-and-unbounded-tails",
        &[f64::NEG_INFINITY, -1.0, -1.0, 0.0, 0.0, 1.0, f64::INFINITY],
        ProbabilityWindow::<Frac32>::default(),
        &source,
        opacity,
        64,
    ));
    fixtures.push(fixture(
        "constant",
        &[0.0; 25],
        ProbabilityWindow::<Frac64>::default(),
        &source,
        opacity,
        64,
    ));
    fixtures.push(fixture(
        "repeated-infinite-tails",
        &[
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
            -1.0,
            -0.5,
            0.0,
            0.5,
            1.0,
            f64::INFINITY,
            f64::INFINITY,
        ],
        ProbabilityWindow::<Frac64>::default(),
        &source,
        Opacity::default(),
        64,
    ));
    let window = ProbabilityWindow::new(Frac64::new(u64::MAX - 7), Frac64::MAX).unwrap();
    fixtures.push(fixture(
        "one-code-gap",
        &[0.0, 0.25, 0.5, 0.75, 1.0],
        window,
        &source,
        opacity,
        64,
    ));
    let source =
        DecimalTicks::with_options(DecimalChain::PowersOfTen, ExactDecimal::zero(), 0..=0).unwrap();
    for (name, range) in [
        ("cutoff-above", 2.0_f64.next_down()),
        ("cutoff-equal", 2.0),
        ("cutoff-below", 2.0_f64.next_up()),
    ] {
        fixtures.push(fixture(
            name,
            &[-range, 0.0],
            ProbabilityWindow::<Frac64>::default(),
            &source,
            Opacity::new(0.5 * 255_f64.ln()).unwrap(),
            64,
        ));
    }
    let source = DecimalTicks::new(DecimalChain::PowersOfTen);
    fixtures.push(fixture(
        "finite-spacing-overflow",
        &[-1.0, 0.0],
        ProbabilityWindow::<Frac64>::default(),
        &source,
        Opacity::new(1e308).unwrap(),
        64,
    ));
    fixtures.push(fixture(
        "subnormal",
        &[
            -f64::from_bits(3),
            -f64::from_bits(1),
            0.0,
            f64::from_bits(1),
            f64::from_bits(3),
        ],
        ProbabilityWindow::<Frac64>::default(),
        &source,
        opacity,
        64,
    ));
    fixtures.push(fixture(
        "extreme",
        &[-f64::MAX, 0.0, f64::MAX],
        ProbabilityWindow::<Frac32>::default(),
        &source,
        opacity,
        64,
    ));
    let source =
        DecimalTicks::with_options(DecimalChain::PowersOfTen, ExactDecimal::zero(), -323..=-323)
            .unwrap();
    fixtures.push(fixture(
        "finite-spacing-underflow",
        &[0.0, 10.0],
        ProbabilityWindow::<Frac64>::default(),
        &source,
        Opacity::new(f64::from_bits(1)).unwrap(),
        64,
    ));
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({ "schema": 1, "fixtures": fixtures })).unwrap()
    );
}
