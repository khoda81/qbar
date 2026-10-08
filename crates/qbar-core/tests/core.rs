use std::{cell::Cell, str::FromStr};

use num_traits::Zero;
use proptest::{
    prelude::*,
    test_runner::{Config, RngSeed},
};
use qbar_core::{
    BigInt, DecimalChain, DecimalTicks, Density, Error, ExactDecimal, Frac32, Frac64,
    LayoutScratch, LayoutStats, Opacity, Probability, ProbabilityWindow, QuantileValue,
    SampleBuffer, SampledQuantile, Tick, layout_pixels, layout_ticks, position_at_probability,
    position_at_value, probability_at_position, reference::layout_reference, value_at_position,
};

fn decimal(text: &str) -> ExactDecimal {
    text.parse().unwrap()
}

fn source(chain: DecimalChain) -> DecimalTicks {
    DecimalTicks::with_options(chain, ExactDecimal::zero(), -6..=6).unwrap()
}

fn compare<P: Probability, V: QuantileValue>(
    values: &[V],
    window: ProbabilityWindow<P>,
    source: &DecimalTicks,
    opacity: Opacity,
    density: Option<Density<'_>>,
) -> (Vec<Tick>, LayoutStats) {
    let samples = SampledQuantile::new(values, window).unwrap();
    let (mut adaptive, mut pixels, mut reference) = (Vec::new(), Vec::new(), Vec::new());
    let stats = layout_ticks(
        samples,
        source,
        opacity,
        density,
        &mut LayoutScratch::default(),
        &mut adaptive,
    )
    .unwrap();
    layout_pixels(samples, source, opacity, density, &mut pixels).unwrap();
    layout_reference(samples, source, opacity, density, &mut reference).unwrap();
    assert_eq!(adaptive, reference, "adaptive/reference, values={values:?}");
    assert_eq!(
        pixels, reference,
        "binary/exhaustive selection, values={values:?}"
    );
    for pair in adaptive.windows(2) {
        assert!(pair[0].value < pair[1].value);
        assert!(pair[0].position_px <= pair[1].position_px);
    }
    for tick in &adaptive {
        assert!(tick.alpha > 0);
        assert!((0.0..=samples.width() as f64).contains(&tick.position_px));
        assert!(
            tick.value.coefficient().is_zero() || !(tick.value.coefficient() % 10_u8).is_zero()
        );
    }
    (adaptive, stats)
}

#[test]
fn binary_fraction_endpoints_half_and_complements() {
    assert_eq!(Frac32::HALF.raw(), 1_u32 << 31);
    assert_eq!(Frac64::HALF.raw(), 1_u64 << 63);
    assert_eq!(Frac32::ZERO.complement_units(), 1_u128 << 32);
    assert_eq!(Frac64::ZERO.complement_units(), 1_u128 << 64);
    assert_eq!(Frac32::HALF.complement_units(), 1_u128 << 31);
    assert_eq!(Frac64::HALF.complement_units(), 1_u128 << 63);
    assert_eq!(Frac32::MAX.complement_units(), 1);
    assert_eq!(Frac64::MAX.complement_units(), 1);
    assert_eq!(Frac64::MAX.difference_units(Frac64::ZERO), Some(u64::MAX));
    assert_eq!(Frac32::ZERO.difference_units(Frac32::HALF), None);
    assert_eq!(Frac32::new(7), Frac32::new(7));
    assert!(Frac64::MAX > Frac64::HALF);
    assert_eq!(<Frac32 as Probability>::from_raw(1_u64 << 32), None);
}

fn sample_combinations<P: Probability>() {
    let window = ProbabilityWindow::<P>::default();
    let mut seen = Vec::new();
    let mut f32_buffer = SampleBuffer::<f32>::default();
    let samples = f32_buffer
        .sample(7, window, |p: P| {
            seen.push(p);
            p.raw() as f32 / (1_u128 << P::BITS) as f32
        })
        .unwrap();
    assert_eq!(seen.len(), 8);
    assert_eq!(seen[0], P::ZERO);
    assert_eq!(seen[7], P::MAX);
    for (index, p) in seen.iter().enumerate() {
        assert_eq!(
            p.raw(),
            (u128::from(window.span_units()) * index as u128 / 7) as u64
        );
        assert_eq!(samples.probability(index), Some(*p));
    }
    assert_eq!(samples.probability(8), None);
    // A callback may round its *output* to 1. Its input remains an exact raw code.
    assert_eq!(samples.values()[7], 1.0_f32);
    compare(
        samples.values(),
        window,
        &source(DecimalChain::OneTwo),
        Opacity::new(0.5).unwrap(),
        None,
    );
    let mut f64_buffer = SampleBuffer::<f64>::default();
    let samples = f64_buffer
        .sample(7, window, |p: P| {
            p.raw() as f64 / (1_u128 << P::BITS) as f64
        })
        .unwrap();
    compare(
        samples.values(),
        window,
        &source(DecimalChain::OneFive),
        Opacity::new(0.5).unwrap(),
        None,
    );
    assert_eq!(samples.values().len(), 8);
    assert_eq!(
        std::mem::size_of_val(samples.values()),
        8 * std::mem::size_of::<f64>()
    );
}

#[test]
fn all_four_quantile_combinations_preserve_output_precision() {
    sample_combinations::<Frac32>();
    sample_combinations::<Frac64>();
    let window = ProbabilityWindow::new(Frac64::ZERO, Frac64::new(1_u64 << 63)).unwrap();
    let mut buffer = SampleBuffer::<f64>::default();
    let mut half = false;
    buffer
        .sample(2, window, |p: Frac64| {
            half |= p == Frac64::HALF;
            p.raw() as f64
        })
        .unwrap();
    assert!(half);
    let mut f32_buffer = SampleBuffer::<f32>::default();
    let samples = f32_buffer
        .sample(3, ProbabilityWindow::<Frac32>::default(), |p: Frac32| {
            p.raw() as f32
        })
        .unwrap();
    assert_eq!(
        std::mem::size_of_val(samples.values()),
        4 * std::mem::size_of::<f32>()
    );
}

#[test]
fn integer_sampling_narrow_windows_and_overflow_boundaries() {
    let window = ProbabilityWindow::new(Frac64::new(u64::MAX - 7), Frac64::MAX).unwrap();
    assert_eq!(window.boundary(3, 0).unwrap().raw(), u64::MAX - 7);
    assert_eq!(window.boundary(3, 1).unwrap().raw(), u64::MAX - 5);
    assert_eq!(window.boundary(3, 2).unwrap().raw(), u64::MAX - 3);
    assert_eq!(window.boundary(3, 3).unwrap().raw(), u64::MAX);
    assert_eq!(
        window.boundary(8, 0),
        Err(Error::InsufficientProbabilityResolution)
    );
    assert_eq!(window.boundary(0, 0), Err(Error::InvalidWidth));
    assert_eq!(window.boundary(3, 4), Err(Error::InvalidPosition));
    assert_eq!(
        ProbabilityWindow::new(Frac32::HALF, Frac32::HALF),
        Err(Error::InvalidWindow)
    );
    assert_eq!(
        ProbabilityWindow::new(Frac64::MAX, Frac64::ZERO),
        Err(Error::InvalidWindow)
    );
    let full = ProbabilityWindow::<Frac64>::default();
    assert_eq!(full.interpolate(u64::MAX, u64::MAX).unwrap(), Frac64::MAX);
    assert_eq!(full.interpolate(0, 0), Err(Error::InvalidPosition));
    assert_eq!(full.interpolate(4, 3), Err(Error::InvalidPosition));
    assert_eq!(full.interpolate(1, 2).unwrap().raw(), (1_u64 << 63) - 1);
    if usize::BITS == 64 {
        let width = usize::MAX;
        assert_eq!(full.boundary(width, width).unwrap(), Frac64::MAX);
        assert_eq!(
            probability_at_position(full, width, width as f64).unwrap(),
            Frac64::MAX
        );
        assert_eq!(full.boundary(width, width - 1).unwrap().raw(), u64::MAX - 1);
        let mut buffer = SampleBuffer::<f64>::default();
        assert!(matches!(
            buffer.sample(width, full, |_| 0.0),
            Err(Error::InvalidWidth)
        ));
    }
    let mut buffer = SampleBuffer::<f64>::default();
    let mut called = false;
    assert!(matches!(
        buffer.sample(8, window, |_| {
            called = true;
            0.0
        }),
        Err(Error::InsufficientProbabilityResolution)
    ));
    assert!(!called);
}

#[test]
fn decimals_are_normalized_and_format_exactly() {
    for (input, output, coefficient, exponent) in [
        ("0", "0", "0", 0),
        ("-0.000e99", "0", "0", 0),
        ("+001.2500", "1.25", "125", -2),
        ("-12300e-2", "-123", "-123", 0),
        ("0.00000001", "1e-8", "1", -8),
        (
            "123456789012345678901234567890.12345",
            "123456789012345678901234567890.12345",
            "12345678901234567890123456789012345",
            -5,
        ),
        ("1e2147483647", "1e2147483647", "1", i32::MAX),
        ("1e-2147483648", "1e-2147483648", "1", i32::MIN),
    ] {
        let d = decimal(input);
        assert_eq!(d.to_string(), output);
        assert_eq!(d.coefficient().to_string(), coefficient);
        assert_eq!(d.exponent(), exponent);
        assert_eq!(decimal(&d.to_string()), d);
    }
    assert_eq!(
        ExactDecimal::new(10, i32::MAX),
        Err(Error::ExponentOverflow)
    );
    assert_eq!(
        ExactDecimal::new(0, i32::MIN).unwrap(),
        ExactDecimal::zero()
    );
    for input in ["", ".", "1.2.3", "--1", "NaN", "1e", "1e2e3", " 1", "1 "] {
        assert_eq!(
            ExactDecimal::from_str(input),
            Err(Error::InvalidDecimal),
            "{input}"
        );
    }
    assert_eq!(
        decimal("1e2147483647").to_f64(),
        Err(Error::UnsupportedExponent)
    );
    assert!(decimal("1e-2147483648") < decimal("1e-999"));
    assert!(decimal("-1e2147483647") < decimal("-1e-2147483648"));
    assert!(decimal("-1") < decimal("0") && decimal("0") < decimal("1"));
    assert!(decimal("1.19") < decimal("1.2"));
    assert_eq!(
        decimal("0.1").to_f64().unwrap().to_bits(),
        0.1_f64.to_bits()
    );
    assert_eq!(decimal("5e-324").to_f64().unwrap().to_bits(), 1);
    assert_eq!(decimal("1e-400").to_f64().unwrap(), 0.0);
    assert_eq!(decimal("1e400").to_f64().unwrap(), f64::INFINITY);
}

#[test]
fn closed_chains_nest_across_decades() {
    for (chain, factors) in [
        (DecimalChain::PowersOfTen, vec![1]),
        (DecimalChain::OneTwo, vec![1, 2]),
        (DecimalChain::OneFive, vec![1, 5]),
    ] {
        let ticks = source(chain);
        let families: Vec<_> = ticks.families().collect();
        assert_eq!(families.len(), 13 * factors.len());
        assert_eq!(
            families
                .iter()
                .take(factors.len())
                .map(|family| family.multiplier())
                .collect::<Vec<_>>(),
            factors
        );
        for pair in families.windows(2) {
            // Exact divisibility is the nesting invariant. Align exponents with integers.
            let a = BigInt::from(pair[0].multiplier());
            let b = BigInt::from(pair[1].multiplier())
                * BigInt::from(10).pow((pair[1].exponent() - pair[0].exponent()) as u32);
            assert!((&b % &a).is_zero());
            assert!(b > a);
        }
    }
    let one_two = source(DecimalChain::OneTwo)
        .select(1.8, 2.1)
        .unwrap()
        .unwrap();
    assert_eq!(one_two.value, decimal("2"));
    assert_eq!(one_two.family.multiplier(), 2);
    let one_five = source(DecimalChain::OneFive)
        .select(4.8, 5.1)
        .unwrap()
        .unwrap();
    assert_eq!(one_five.value, decimal("5"));
    assert_eq!(one_five.family.multiplier(), 5);
    assert_eq!(one_five.family.exponent(), 0);
}

#[test]
fn exact_membership_origins_negatives_and_half_open_boundaries() {
    let ticks = source(DecimalChain::PowersOfTen);
    // Binary 0.1 is a little above decimal 0.1. The exact decimal belongs to
    // the pixel ending at binary 0.1, never the pixel starting there.
    let selected = ticks.select(0.1_f64.next_down(), 0.1).unwrap().unwrap();
    assert_eq!(selected.value, decimal("0.1"));
    assert_ne!(
        ticks
            .select(0.1, 0.1_f64.next_up())
            .unwrap()
            .map(|tick| tick.value),
        Some(decimal("0.1"))
    );
    let origin = decimal("0.125");
    let ticks = DecimalTicks::with_options(DecimalChain::OneFive, origin.clone(), -6..=6).unwrap();
    let selected = ticks.select(-1.0, -0.8).unwrap().unwrap();
    assert_eq!(selected.value, decimal("-0.875"));
    assert_eq!(selected.family.exponent(), 0);
    assert_eq!(ticks.select(0.0, 0.125).unwrap().unwrap().value, origin);
    assert_ne!(
        ticks.select(0.125, 0.2).unwrap().map(|tick| tick.value),
        Some(origin)
    );
    compare(
        &[-1.0, -0.875, -0.875, 0.125, 0.125, 1.125],
        ProbabilityWindow::<Frac64>::default(),
        &ticks,
        Opacity::new(0.05).unwrap(),
        None,
    );
    assert_eq!(ticks.select(1.0, 1.0).unwrap(), None);
    assert!(ticks.select(f64::NEG_INFINITY, 1.0).is_err());
}

#[test]
fn opacity_has_one_scale_and_a_stable_byte_cutoff() {
    let opacity = Opacity::default();
    assert_eq!(opacity.cutoff_px(), 24.0);
    assert_eq!(opacity.alpha(24.0_f64.next_down()), 0);
    assert_eq!(opacity.alpha(24.0), 1);
    assert_eq!(opacity.alpha(24.0_f64.next_up()), 1);
    assert_eq!(opacity.alpha(0.0), 0);
    assert_eq!(opacity.alpha(-1.0), 0);
    assert_eq!(opacity.alpha(f64::NAN), 0);
    assert_eq!(opacity.alpha(f64::INFINITY), 255);
    assert_eq!(
        opacity.alpha(opacity.scale()),
        (255.0 / std::f64::consts::E).floor() as u8
    );
    for tau in [f64::NAN, 0.0, -1.0, f64::INFINITY] {
        assert_eq!(Opacity::new(tau), Err(Error::InvalidOpacityScale));
    }
    let tiny = Opacity::new(f64::from_bits(1)).unwrap();
    assert_eq!(tiny.alpha(0.0), 0);
    assert_eq!(tiny.alpha(f64::from_bits(1)), 93);
}

#[test]
fn actual_probability_gaps_drive_density_and_positions() {
    let window = ProbabilityWindow::new(Frac64::new(u64::MAX - 5), Frac64::MAX).unwrap();
    let ticks =
        DecimalTicks::with_options(DecimalChain::PowersOfTen, ExactDecimal::zero(), 0..=0).unwrap();
    let opacity = Opacity::new(1.0).unwrap();
    let (out, _) = compare(&[0.0, 1.0, 2.0, 3.0], window, &ticks, opacity, None);
    assert_eq!(out.len(), 3);
    for (tick, expected_position) in out.iter().zip([0.6, 1.8, 3.0]) {
        assert_eq!(tick.position_px, expected_position);
        assert_eq!(
            tick.alpha,
            opacity.alpha(if tick.value == decimal("1") { 0.6 } else { 1.2 })
        );
    }
    let density = |_x: f64| 1.0 / (1_u128 << 64) as f64;
    let (out, stats) = compare(
        &[0.0, 1.0, 2.0, 3.0],
        window,
        &ticks,
        opacity,
        Some(&density),
    );
    assert!(out.iter().all(|tick| tick.alpha == opacity.alpha(0.6)));
    assert_eq!(stats.pixel_selections, 3);
    assert_eq!(stats.buckets_split, 0);
}

#[test]
fn nonlinear_buckets_refine_and_can_emit_multiple_nearby_ticks() {
    let mut values: Vec<f64> = (0..=96).map(|index| index as f64 * 0.02).collect();
    // Huge local slope on one side of a bucket, dense visible families on the other.
    for (index, value) in values.iter_mut().enumerate().skip(48) {
        *value = 100.0 + (index - 48) as f64 * 0.0001;
    }
    let (_, stats) = compare(
        &values,
        ProbabilityWindow::<Frac64>::default(),
        &source(DecimalChain::OneTwo),
        Opacity::default(),
        None,
    );
    assert!(stats.buckets_split > 0);
    // Construct multiple visible families within a single initial bucket.
    let values: Vec<f64> = (0..=48)
        .map(|index| {
            if index < 16 {
                8.99 + index as f64 * 0.002
            } else if index < 32 {
                9.99 + (index - 16) as f64 * 0.002
            } else {
                10.99 + (index - 32) as f64 * 0.002
            }
        })
        .collect();
    let (out, stats) = compare(
        &values,
        ProbabilityWindow::<Frac32>::default(),
        &source(DecimalChain::OneFive),
        Opacity::default(),
        None,
    );
    assert!(stats.buckets_split > 0);
    assert!(out.iter().filter(|tick| tick.position_px < 24.0).count() >= 2);
    assert!(
        out.windows(2)
            .any(|pair| pair[1].position_px - pair[0].position_px < 24.0)
    );
}

#[test]
fn flat_regions_constant_windows_and_unbounded_tails() {
    let ticks = source(DecimalChain::PowersOfTen);
    let opacity = Opacity::new(0.01).unwrap();
    for values in [vec![3.0; 33], vec![0.0; 33], vec![-7.0; 33]] {
        let (out, stats) = compare(
            &values,
            ProbabilityWindow::<Frac64>::default(),
            &ticks,
            opacity,
            None,
        );
        assert!(out.is_empty());
        assert_eq!(stats.pixel_selections, 0);
    }
    let (out, _) = compare(
        &[f64::NEG_INFINITY, -1.0, -1.0, 0.0, 0.0, 1.0, f64::INFINITY],
        ProbabilityWindow::<Frac32>::default(),
        &ticks,
        opacity,
        None,
    );
    assert_eq!(
        out.iter()
            .map(|tick| tick.value.clone())
            .collect::<Vec<_>>(),
        vec![decimal("0"), decimal("1")]
    );
    let window = ProbabilityWindow::<Frac32>::default();
    assert_eq!(
        out[0].position_px,
        position_at_probability(window, 6, window.boundary(6, 3).unwrap()).unwrap()
    );
    assert_eq!(
        out[1].position_px,
        position_at_probability(window, 6, window.boundary(6, 5).unwrap()).unwrap()
    );
    compare(
        &[f64::NEG_INFINITY, f64::INFINITY],
        ProbabilityWindow::<Frac64>::default(),
        &ticks,
        opacity,
        None,
    );
    for values in [
        vec![f64::NEG_INFINITY; 25],
        vec![f64::INFINITY; 25],
        vec![
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
            -1.0,
            0.0,
            1.0,
            f64::INFINITY,
            f64::INFINITY,
        ],
    ] {
        for opacity in [opacity, Opacity::default()] {
            compare(
                &values,
                ProbabilityWindow::<Frac64>::default(),
                &ticks,
                opacity,
                None,
            );
        }
    }
}

#[test]
fn layout_is_invariant_under_exact_decimal_unit_changes() {
    let values: Vec<f64> = (0..=80).map(|i| f64::from(i) / 8.0 - 5.0).collect();
    let scaled: Vec<f64> = values.iter().map(|x| x * 1000.0).collect();
    let original =
        DecimalTicks::with_options(DecimalChain::OneFive, decimal("0.125"), -6..=6).unwrap();
    let changed_units =
        DecimalTicks::with_options(DecimalChain::OneFive, decimal("125"), -3..=9).unwrap();
    let (original, _) = compare(
        &values,
        ProbabilityWindow::<Frac64>::default(),
        &original,
        Opacity::new(1.0).unwrap(),
        None,
    );
    let (changed_units, _) = compare(
        &scaled,
        ProbabilityWindow::<Frac64>::default(),
        &changed_units,
        Opacity::new(1.0).unwrap(),
        None,
    );
    assert_eq!(original.len(), changed_units.len());
    for (a, b) in original.iter().zip(changed_units) {
        assert_eq!(
            b.value,
            ExactDecimal::new(a.value.coefficient().clone(), a.value.exponent() + 3).unwrap()
        );
        assert_eq!(b.family.exponent(), a.family.exponent() + 3);
        assert_eq!(b.family.multiplier(), a.family.multiplier());
        assert_eq!(b.position_px, a.position_px);
        assert_eq!(b.alpha, a.alpha);
    }
}

#[test]
fn adaptive_cutoff_bounds_handle_adjacent_floats_and_extreme_scales() {
    let values: Vec<f64> = (0..=96).map(|i| f64::from(i) / 24.0).collect();
    let ticks = DecimalTicks::with_options(DecimalChain::PowersOfTen, decimal("0"), 0..=0).unwrap();
    for scale in [
        Opacity::default().scale().next_down(),
        Opacity::default().scale(),
        Opacity::default().scale().next_up(),
        f64::from_bits(1),
        f64::MAX,
    ] {
        compare(
            &values,
            ProbabilityWindow::<Frac64>::default(),
            &ticks,
            Opacity::new(scale).unwrap(),
            None,
        );
    }
}

#[test]
fn opacity_does_not_erase_positive_spacing_outside_binary64_range() {
    let source = DecimalTicks::new(DecimalChain::PowersOfTen);
    let (out, _) = compare(
        &[-1.0, 0.0],
        ProbabilityWindow::<Frac64>::default(),
        &source,
        Opacity::new(1e308).unwrap(),
        None,
    );
    assert_eq!(out[0].alpha, 230); // exp(-1e308 / 1e309), rather than exp(-tau/∞).
    let source =
        DecimalTicks::with_options(DecimalChain::PowersOfTen, ExactDecimal::zero(), -323..=-323)
            .unwrap();
    let (out, _) = compare(
        &[0.0, 10.0],
        ProbabilityWindow::<Frac64>::default(),
        &source,
        Opacity::new(f64::from_bits(1)).unwrap(),
        None,
    );
    assert_eq!(out[0].alpha, 1); // spacing 1e-324 is positive even though f64 rounds it to zero.
    let source =
        DecimalTicks::with_options(DecimalChain::OneTwo, ExactDecimal::zero(), -1..=-1).unwrap();
    let (out, _) = compare(
        &[0.19, 0.21],
        ProbabilityWindow::<Frac32>::default(),
        &source,
        Opacity::new(f64::from_bits(1)).unwrap(),
        Some(&|_| f64::from_bits(1)),
    );
    assert_eq!(out[0].alpha, 1); // attenuation is approximately 5.
}

#[test]
fn invalid_samples_and_invalid_densities_are_errors() {
    let window = ProbabilityWindow::<Frac64>::default();
    for values in [
        vec![0.0, f64::NAN],
        vec![1.0, 0.0],
        vec![0.0, f64::NEG_INFINITY, 1.0],
        vec![0.0, f64::INFINITY, 1.0],
    ] {
        assert!(matches!(
            SampledQuantile::new(&values, window),
            Err(Error::InvalidSamples { .. })
        ));
    }
    assert!(matches!(
        SampledQuantile::new(&[1.0], window),
        Err(Error::InvalidWidth)
    ));
    let mut samples_buffer = SampleBuffer::<f64>::default();
    assert!(matches!(
        samples_buffer.sample(2, window, |_| f64::NAN),
        Err(Error::InvalidSamples { .. })
    ));
    let samples = samples_buffer
        .sample(2, window, |p| p.raw() as f64)
        .unwrap();
    assert_eq!(samples.width(), 2);
    let samples = SampledQuantile::new(&[-1.0, 0.0, 1.0], window).unwrap();
    let ticks = source(DecimalChain::OneTwo);
    for density in [f64::NAN, -0.1, f64::NEG_INFINITY] {
        let mut out = Vec::new();
        assert_eq!(
            layout_ticks(
                samples,
                &ticks,
                Opacity::default(),
                Some(&|_| density),
                &mut LayoutScratch::default(),
                &mut out
            ),
            Err(Error::InvalidDensity)
        );
        assert!(out.is_empty());
    }
    let (out, _) = compare(
        &[-1.0, 0.0, 1.0],
        window,
        &ticks,
        Opacity::default(),
        Some(&|_| 0.0),
    );
    assert!(out.is_empty());
    let calls = Cell::new(0);
    let density = |x: f64| {
        assert!(x == 0.0 || x == 1.0);
        calls.set(calls.get() + 1);
        f64::INFINITY
    };
    let (out, _) = compare(
        &[-1.0, 0.0, 1.0],
        window,
        &ticks,
        Opacity::default(),
        Some(&density),
    );
    assert!(out.iter().all(|tick| tick.alpha == 255));
    assert_eq!(calls.get(), 6);
}

#[test]
fn full_float_ranges_and_cancellation_do_not_overflow() {
    for chain in [
        DecimalChain::PowersOfTen,
        DecimalChain::OneTwo,
        DecimalChain::OneFive,
    ] {
        let ticks = DecimalTicks::new(chain);
        let opacity = Opacity::new(0.01).unwrap();
        let tiny = f64::from_bits(1);
        compare(
            &[-tiny * 3.0, -tiny, 0.0, tiny, tiny * 3.0],
            ProbabilityWindow::<Frac64>::default(),
            &ticks,
            opacity,
            None,
        );
        compare(
            &[-f64::MAX, -f64::MAX / 2.0, 0.0, f64::MAX / 2.0, f64::MAX],
            ProbabilityWindow::<Frac32>::default(),
            &ticks,
            opacity,
            None,
        );
        let tiny = f32::from_bits(1);
        compare(
            &[-f32::MAX, -1.0, -tiny, 0.0, tiny, 1.0, f32::MAX],
            ProbabilityWindow::<Frac32>::default(),
            &ticks,
            opacity,
            None,
        );
    }
    let huge_origin = ExactDecimal::new(BigInt::from(10).pow(400) + 1, -1).unwrap();
    let ticks = DecimalTicks::with_options(DecimalChain::OneFive, huge_origin, -324..=400).unwrap();
    compare(
        &[-1.0, 0.0, 0.1, 1.0, 2.0],
        ProbabilityWindow::<Frac64>::default(),
        &ticks,
        Opacity::new(0.01).unwrap(),
        None,
    );
    assert!(matches!(
        DecimalTicks::with_options(DecimalChain::PowersOfTen, decimal("0"), -4097..=0),
        Err(Error::UnsupportedExponent)
    ));
}

#[test]
fn buffers_reuse_capacity_across_widths_and_errors_clear_partial_frames() {
    let window = ProbabilityWindow::<Frac64>::default();
    let source = source(DecimalChain::OneTwo);
    let mut buffer = SampleBuffer::<f64>::default();
    let mut scratch = LayoutScratch::default();
    let mut output = Vec::new();
    let mut reference = Vec::new();
    let mut allocation = None;
    for width in [96, 24, 3, 48, 96] {
        let samples = buffer
            .sample(width, window, |p: Frac64| {
                (p.raw() as f64 / 18446744073709551616.0).powi(3) * 100.0 - 10.0
            })
            .unwrap();
        if let Some(pointer) = allocation {
            assert_eq!(samples.values().as_ptr(), pointer);
        }
        allocation = Some(samples.values().as_ptr());
        layout_ticks(
            samples,
            &source,
            Opacity::default(),
            None,
            &mut scratch,
            &mut output,
        )
        .unwrap();
        layout_reference(samples, &source, Opacity::default(), None, &mut reference).unwrap();
        assert_eq!(output, reference);
    }
    let samples = SampledQuantile::new(&[-1.0, 0.0, 1.0], window).unwrap();
    let density = |x| if x == 1.0 { f64::NAN } else { f64::INFINITY };
    assert_eq!(
        layout_ticks(
            samples,
            &source,
            Opacity::default(),
            Some(&density),
            &mut scratch,
            &mut output
        ),
        Err(Error::InvalidDensity)
    );
    assert!(output.is_empty());
    assert_eq!(
        layout_pixels(
            samples,
            &source,
            Opacity::default(),
            Some(&density),
            &mut output
        ),
        Err(Error::InvalidDensity)
    );
    assert!(output.is_empty());
    assert_eq!(
        layout_reference(
            samples,
            &source,
            Opacity::default(),
            Some(&density),
            &mut output
        ),
        Err(Error::InvalidDensity)
    );
    assert!(output.is_empty());
    layout_ticks(
        samples,
        &source,
        Opacity::new(0.01).unwrap(),
        None,
        &mut scratch,
        &mut output,
    )
    .unwrap();
    assert_eq!(output.len(), 2);
}

#[test]
fn mapping_keeps_maximum_codes_and_handles_plateaus() {
    assert_eq!(
        probability_at_position(ProbabilityWindow::<Frac64>::default(), 2, 1.0)
            .unwrap()
            .raw(),
        Frac64::HALF.raw() - 1
    );
    for window in [
        ProbabilityWindow::<Frac64>::default(),
        ProbabilityWindow::new(Frac64::new(u64::MAX - 7), Frac64::MAX).unwrap(),
    ] {
        assert_eq!(
            probability_at_position(window, 3, 0.0).unwrap(),
            window.lo()
        );
        assert_eq!(
            probability_at_position(window, 3, 3.0).unwrap(),
            window.hi()
        );
        assert_eq!(
            position_at_probability(window, 3, window.hi()).unwrap(),
            3.0
        );
        assert_eq!(
            position_at_probability(window, 3, window.lo()).unwrap(),
            0.0
        );
        for position in [f64::NAN, -1.0, 4.0, f64::INFINITY] {
            assert_eq!(
                probability_at_position(window, 3, position),
                Err(Error::InvalidPosition)
            );
        }
        let value =
            value_at_position(window, 3, 3.0, |p: Frac64| p.complement_units() as f64).unwrap();
        assert_eq!(value, 1.0);
    }
    let samples = SampledQuantile::new(
        &[0.0, 1.0, 1.0, 3.0],
        ProbabilityWindow::<Frac32>::default(),
    )
    .unwrap();
    assert_eq!(position_at_value(samples, 1.0).unwrap(), Some(1.0));
    assert_eq!(position_at_value(samples, 2.0).unwrap(), Some(2.5));
    assert_eq!(position_at_value(samples, 4.0).unwrap(), None);
    assert_eq!(
        position_at_value(samples, f64::NAN),
        Err(Error::InvalidPosition)
    );
    let samples = SampledQuantile::new(
        &[f64::NEG_INFINITY, 0.0, f64::INFINITY],
        ProbabilityWindow::<Frac64>::default(),
    )
    .unwrap();
    assert_eq!(position_at_value(samples, 1.0).unwrap(), None);
    assert_eq!(position_at_value(samples, 0.0).unwrap(), Some(1.0));
}

proptest! {
    #![proptest_config(Config { cases: 48, rng_seed: RngSeed::Fixed(0x5142_FEED), ..Config::default() })]

    #[test]
    fn arbitrary_binary_ranges_match_reference(
        raw in prop::collection::vec((any::<bool>(), 0_u16..=2046, any::<u64>()), 2..13),
        chain in 0_usize..3, scale_index in 0_usize..5,
    ) {
        let mut values: Vec<f64> = raw.iter().map(|&(negative, exponent, mantissa)| {
            f64::from_bits((u64::from(negative) << 63) | (u64::from(exponent) << 52) | (mantissa & ((1_u64 << 52) - 1)))
        }).collect();
        values.sort_by(f64::total_cmp);
        let chain = [DecimalChain::PowersOfTen, DecimalChain::OneTwo, DecimalChain::OneFive][chain];
        let source = DecimalTicks::new(chain);
        let opacity = Opacity::new([f64::from_bits(1), 0.1, 5.0, Opacity::default().scale(), f64::MAX][scale_index]).unwrap();
        compare(&values, ProbabilityWindow::<Frac64>::default(), &source, opacity, None);
        compare(&values, ProbabilityWindow::<Frac32>::default(), &source, opacity, None);
        let values: Vec<f32> = values.iter().map(|&x| x as f32).collect();
        compare(&values, ProbabilityWindow::<Frac64>::default(), &source, opacity, None);
        compare(&values, ProbabilityWindow::<Frac32>::default(), &source, opacity, None);
    }
}

proptest! {
    #![proptest_config(Config { cases: 160, rng_seed: RngSeed::Fixed(0x5142_4152), ..Config::default() })]

    #[test]
    fn adaptive_matches_independent_oracle(
        increments in prop::collection::vec(0_u16..=2000, 1..65),
        offset in -20000_i32..=20000,
        origin in -1000_i32..=1000,
        chain in 0_u8..3,
        scale in 1_u16..=800,
        gap_extra in 0_u64..=200,
    ) {
        let mut total = f64::from(offset) / 1000.0;
        let mut values = vec![total];
        for increment in increments { total += f64::from(increment) / 1000.0; values.push(total); }
        let chain = [DecimalChain::PowersOfTen, DecimalChain::OneTwo, DecimalChain::OneFive][usize::from(chain)];
        let ticks = DecimalTicks::with_options(chain, ExactDecimal::new(origin, -3).unwrap(), -6..=6).unwrap();
        let span = values.len() as u64 - 1 + gap_extra;
        let window64 = ProbabilityWindow::new(Frac64::new(u64::MAX - span), Frac64::MAX).unwrap();
        let window32 = ProbabilityWindow::new(Frac32::new(u32::MAX - span as u32), Frac32::MAX).unwrap();
        let opacity = Opacity::new(f64::from(scale) / 10.0).unwrap();
        compare(&values, window64, &ticks, opacity, None);
        compare(&values, window32, &ticks, opacity, None);
        let values32: Vec<f32> = values.iter().map(|&x| x as f32).collect();
        compare(&values32, window64, &ticks, opacity, None);
        compare(&values32, window32, &ticks, opacity, None);
        compare(&values, window64, &ticks, opacity, Some(&|x| 0.01 + 1.0 / (1.0 + x.abs())));
    }

    #[test]
    fn normalization_formatting_order_and_integer_interpolation(
        a in any::<i64>(), b in any::<i64>(), exponent in -30_i32..31,
        denominator in 1_u64..=u64::MAX, numerator in any::<u64>(),
    ) {
        let expected_order = a.cmp(&b);
        let a = ExactDecimal::new(a, exponent).unwrap();
        let b = ExactDecimal::new(b, exponent).unwrap();
        prop_assert_eq!(a.cmp(&b), expected_order);
        prop_assert_eq!(decimal(&a.to_string()), a.clone());
        let numerator = numerator % denominator;
        let window = ProbabilityWindow::<Frac64>::default();
        let expected = (u128::from(u64::MAX) * u128::from(numerator) / u128::from(denominator)) as u64;
        prop_assert_eq!(window.interpolate(numerator, denominator).unwrap().raw(), expected);
    }
}
