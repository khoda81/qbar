use qbar_core::{
    DecimalChain, DecimalTicks, Frac32, Frac64, LayoutScratch, Opacity, Probability,
    ProbabilityWindow, QuantileValue, SampleBuffer, layout_ticks, value_at_position,
};

// Logistic inverse CDF: log(p) - log(1-p). The binary denominator cancels.
// Using exact complement counts keeps the last u64 code away from log(0).
fn logistic<P: Probability>(p: P) -> f64 {
    (p.raw() as f64).ln() - (p.complement_units() as f64).ln()
}

fn render<P: Probability, V: QuantileValue>(
    label: &str,
    quantile: impl FnMut(P) -> V,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut buffer = SampleBuffer::<V>::default();
    let samples = buffer.sample(800, ProbabilityWindow::<P>::default(), quantile)?;
    let source = DecimalTicks::new(DecimalChain::OneTwo);
    let mut scratch = LayoutScratch::default();
    let mut ticks = Vec::new();
    let stats = layout_ticks(
        samples,
        &source,
        Opacity::default(),
        None,
        &mut scratch,
        &mut ticks,
    )?;
    println!(
        "{label}: {} samples, {} ticks, {} family lookups",
        stats.sample_count,
        ticks.len(),
        stats.family_lookups
    );
    for tick in ticks.iter().take(8) {
        println!(
            "  {} at {:.2}px: {} × 10^{}, alpha {}",
            tick.value,
            tick.position_px,
            tick.family.multiplier(),
            tick.family.exponent(),
            tick.alpha
        );
    }
    // Reuse the same samples/output buffer with a supplied density. This takes
    // the pixel reference path because a point callback supplies no interval bound.
    let density = |x: f64| {
        let t = (-x.abs()).exp();
        t / (1.0 + t).powi(2)
    };
    layout_ticks(
        samples,
        &source,
        Opacity::default(),
        Some(&density),
        &mut scratch,
        &mut ticks,
    )?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    render("Frac32 → f32", |p: Frac32| logistic(p) as f32)?;
    render("Frac32 → f64", |p: Frac32| logistic(p))?;
    render("Frac64 → f32", |p: Frac64| logistic(p) as f32)?;
    render("Frac64 → f64", |p: Frac64| logistic(p))?;
    let tail_value =
        value_at_position(ProbabilityWindow::<Frac64>::default(), 800, 800.0, logistic)?;
    println!("Slider at the right edge: Q(MAX) = {tail_value:.6}");
    Ok(())
}
