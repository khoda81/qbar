//! Independent exhaustive pixel oracle. Selection scans families and verifies
//! generated candidates instead of sharing the production containment search.
use num_bigint::BigInt;
use num_traits::{Signed, Zero};

use crate::{
    DecimalTicks, Error, ExactDecimal, Opacity, Probability, QuantileValue, SampledQuantile,
    TickSelection,
    layout::{Density, LayoutStats, Tick},
    ratio::Ratio,
};

pub fn layout_reference<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    source: &DecimalTicks,
    opacity: Opacity,
    density: Option<Density<'_>>,
    output: &mut Vec<Tick>,
) -> Result<LayoutStats, Error> {
    output.clear();
    let result = exhaustive(samples, source, opacity, density, output);
    if result.is_err() {
        output.clear();
    }
    result
}

pub(crate) fn select(
    source: &DecimalTicks,
    lower: f64,
    upper: f64,
    lookups: &mut u64,
) -> Option<TickSelection> {
    let lower = Ratio::from_f64(lower);
    let upper = Ratio::from_f64(upper);
    let relative = upper.sub(&source.origin_ratio);
    let relative_lower = lower.sub(&source.origin_ratio);
    for family in source.families.iter().rev() {
        *lookups += 1;
        let numerator = &relative.num * &family.spacing.den;
        let denominator = &relative.den * &family.spacing.num;
        // Independent truncation-to-floor adjustment, including negative inputs.
        let mut index = &numerator / &denominator;
        if numerator.is_negative() && !(&numerator % &denominator).is_zero() {
            index -= BigInt::from(1);
        }
        // Verify the exact candidate before constructing/normalizing a decimal.
        // Families far outside the pixel should not materialize huge unused ticks.
        let candidate_ratio = Ratio {
            num: &index * &family.spacing.num,
            den: family.spacing.den.clone(),
        };
        if candidate_ratio.cmp(&relative_lower).is_le() || candidate_ratio.cmp(&relative).is_gt() {
            continue;
        }
        let descriptor = family.descriptor;
        let candidate = ExactDecimal::new(index * descriptor.multiplier(), descriptor.exponent())
            .expect("reference family exponents are bounded");
        let value = source.origin().add(&candidate);
        return Some(TickSelection {
            value,
            family: descriptor,
        });
    }
    None
}

fn exhaustive<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    source: &DecimalTicks,
    opacity: Opacity,
    density: Option<Density<'_>>,
    output: &mut Vec<Tick>,
) -> Result<LayoutStats, Error> {
    let width = samples.width();
    let span = u128::from(samples.window().span_units());
    let mut stats = LayoutStats {
        sample_count: width + 1,
        ..LayoutStats::default()
    };
    for pixel in 0..width {
        stats.buckets_visited += 1;
        let lower = samples.values()[pixel].as_f64();
        let upper = samples.values()[pixel + 1].as_f64();
        if !lower.is_finite() || !upper.is_finite() || lower == upper {
            stats.buckets_skipped += 1;
            continue;
        }
        stats.pixel_selections += 1;
        let Some(selection) = select(source, lower, upper, &mut stats.family_lookups) else {
            continue;
        };
        let value = selection.value.ratio()?;
        let spacing = selection.family.spacing().ratio()?;
        let lower = Ratio::from_f64(lower);
        let range = Ratio::from_f64(upper).sub(&lower);
        let start = u128::from(
            samples.probability(pixel).expect("pixel boundary").raw() - samples.window().lo().raw(),
        );
        let end = u128::from(
            samples
                .probability(pixel + 1)
                .expect("pixel boundary")
                .raw()
                - samples.window().lo().raw(),
        );
        let s = if let Some(density) = density {
            let density = density(value.to_f64());
            if density.is_nan() || density < 0.0 {
                return Err(Error::InvalidDensity);
            }
            if density == f64::INFINITY {
                None
            } else {
                Some(
                    Ratio::from_f64(density)
                        .mul_units(1_u128 << P::BITS, span)
                        .mul(&spacing)
                        .mul_units(width as u128, 1),
                )
            }
        } else {
            Some(
                spacing
                    .mul_units(end - start, span)
                    .div(&range)
                    .mul_units(width as u128, 1),
            )
        };
        // Independent byte-cutoff expression, including the documented equality rule.
        let alpha = match s {
            None => 255,
            Some(s) if s.num.is_zero() => 0,
            Some(s) => {
                let numeric = s.to_f64();
                if numeric == 0.0 || numeric.is_infinite() {
                    (255.0 * (-Ratio::from_f64(opacity.scale()).div(&s).to_f64()).exp()) as u8
                } else if numeric < opacity.scale() / 255_f64.ln() {
                    0
                } else {
                    ((255.0 * (-opacity.scale() / numeric).exp()) as u8).max(1)
                }
            }
        };
        if alpha == 0 {
            continue;
        }
        let position_px = value
            .sub(&lower)
            .mul_units(end - start, 1)
            .div(&range)
            .add_units(start)
            .mul_units(width as u128, span)
            .to_f64();
        output.push(Tick {
            value: selection.value,
            family: selection.family,
            position_px,
            alpha,
        });
    }
    stats.emitted_ticks = output.len();
    Ok(stats)
}
