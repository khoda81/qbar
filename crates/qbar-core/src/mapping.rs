use num_bigint::BigInt;
use num_traits::ToPrimitive;

use crate::{Error, Probability, ProbabilityWindow, QuantileValue, SampledQuantile, ratio::Ratio};

/// Map a pixel position onto the probability grid, rounding down in integer arithmetic.
pub fn probability_at_position<P: Probability>(
    window: ProbabilityWindow<P>,
    width: usize,
    position: f64,
) -> Result<P, Error> {
    window.validate_width(width)?;
    if !position.is_finite() || position < 0.0 || position > width as f64 {
        return Err(Error::InvalidPosition);
    }
    // Pin the displayed endpoint even for widths whose integer value rounds
    // when represented as f64. The returned probability is still the exact hi code.
    if position == width as f64 {
        return Ok(window.hi());
    }
    // Decode the cursor's binary fraction before scaling; do not round a u64 span
    // to f64 and accidentally introduce a probability-one endpoint.
    let ratio = Ratio::from_f64(position).mul_units(u128::from(window.span_units()), width as u128);
    let offset = (&ratio.num / &ratio.den)
        .to_u64()
        .ok_or(Error::InvalidPosition)?;
    P::from_raw(
        window
            .lo()
            .raw()
            .checked_add(offset)
            .ok_or(Error::InvalidPosition)?,
    )
    .ok_or(Error::InvalidPosition)
}

pub fn position_at_probability<P: Probability>(
    window: ProbabilityWindow<P>,
    width: usize,
    probability: P,
) -> Result<f64, Error> {
    window.validate_width(width)?;
    if probability < window.lo() || probability > window.hi() {
        return Err(Error::InvalidPosition);
    }
    Ok(Ratio::new(
        BigInt::from(probability.raw() - window.lo().raw()),
        BigInt::from(window.span_units()),
    )
    .mul_units(width as u128, 1)
    .to_f64())
}

/// The slider uses Q(p) directly, without interpolating the quantile's value.
pub fn value_at_position<P: Probability, V: QuantileValue>(
    window: ProbabilityWindow<P>,
    width: usize,
    position: f64,
    mut quantile: impl FnMut(P) -> V,
) -> Result<V, Error> {
    Ok(quantile(probability_at_position(window, width, position)?))
}

/// Invert the sampled quantile to pixel accuracy. Plateaus choose the leftmost
/// sampled occurrence. Values outside the sampled window return None.
pub fn position_at_value<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    value: V,
) -> Result<Option<f64>, Error> {
    let value = value.as_f64();
    if !value.is_finite() {
        return Err(Error::InvalidPosition);
    }
    let values = samples.values();
    if value < values[0].as_f64() || value > values[samples.width()].as_f64() {
        return Ok(None);
    }
    let index = values.partition_point(|sample| sample.as_f64() < value);
    if index == 0 {
        return Ok(Some(0.0));
    }
    let lo = values[index - 1].as_f64();
    let hi = values[index].as_f64();
    if value == hi {
        return Ok(Some(position_at_probability(
            samples.window(),
            samples.width(),
            samples.probability(index).expect("sample boundary"),
        )?));
    }
    if !lo.is_finite() || !hi.is_finite() {
        return Ok(None);
    }
    let fraction = Ratio::from_f64(value)
        .sub(&Ratio::from_f64(lo))
        .div(&Ratio::from_f64(hi).sub(&Ratio::from_f64(lo)));
    Ok(Some(
        fraction
            .mul_units(u128::from(samples.code(index) - samples.code(index - 1)), 1)
            .add_units(u128::from(
                samples.code(index - 1) - samples.window().lo().raw(),
            ))
            .mul_units(
                samples.width() as u128,
                u128::from(samples.window().span_units()),
            )
            .to_f64(),
    ))
}
