use crate::{
    DecimalFamily, DecimalTicks, Error, ExactDecimal, Opacity, Probability, QuantileValue,
    SampledQuantile, TickSelection, ratio::Ratio, ticks::candidate_count,
};

/// Density in probability per numeric value unit, evaluated at the selected tick.
pub type Density<'a> = &'a dyn Fn(f64) -> f64;

#[derive(Clone, Debug, PartialEq)]
pub struct Tick {
    pub value: ExactDecimal,
    pub family: DecimalFamily,
    pub position_px: f64,
    pub alpha: u8,
}

/// Operation counts, excluding callback evaluation performed by the sampler.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayoutStats {
    /// Number of validated boundaries in the input; no callbacks run during layout.
    pub sample_count: usize,
    /// Family predicate evaluations for containment, spacing bounds, and candidate counts.
    pub family_lookups: u64,
    pub buckets_visited: u64,
    pub buckets_split: u64,
    pub buckets_skipped: u64,
    pub pixel_selections: u64,
    pub emitted_ticks: usize,
}

/// Reusable O(W) summaries and iterative traversal storage.
#[derive(Default, Debug)]
pub struct LayoutScratch {
    minimum_slopes: Vec<f64>,
    stack: Vec<(usize, usize)>,
}

impl LayoutScratch {
    fn prepare<P: Probability, V: QuantileValue>(
        &mut self,
        samples: SampledQuantile<'_, P, V>,
    ) -> Result<(), Error> {
        let leaves = samples
            .width()
            .checked_next_power_of_two()
            .ok_or(Error::InvalidWidth)?;
        let length = leaves.checked_mul(2).ok_or(Error::InvalidWidth)?;
        if length > self.minimum_slopes.len() {
            self.minimum_slopes
                .try_reserve(length - self.minimum_slopes.len())
                .map_err(|_| Error::AllocationFailed)?;
        }
        self.minimum_slopes.resize(length, f64::INFINITY);
        self.minimum_slopes.fill(f64::INFINITY);
        for pixel in 0..samples.width() {
            let lo = samples.values()[pixel].as_f64();
            let hi = samples.values()[pixel + 1].as_f64();
            if !lo.is_finite() || !hi.is_finite() || lo == hi {
                continue;
            }
            let range = Ratio::from_f64(hi).sub(&Ratio::from_f64(lo));
            let gap = samples.code(pixel + 1) - samples.code(pixel);
            // Outward rounding: this can understate the slope, never overstate it.
            // Consequently it can only retain extra work, not hide a visible tick.
            let slope = range
                .mul_units(1, u128::from(gap))
                .to_f64()
                .next_down()
                .max(0.0);
            self.minimum_slopes[leaves + pixel] = slope;
        }
        for node in (1..leaves).rev() {
            self.minimum_slopes[node] =
                self.minimum_slopes[node * 2].min(self.minimum_slopes[node * 2 + 1]);
        }
        self.stack.clear();
        Ok(())
    }

    fn minimum(&self, mut lo: usize, mut hi: usize) -> f64 {
        let leaves = self.minimum_slopes.len() / 2;
        lo += leaves;
        hi += leaves;
        let mut minimum = f64::INFINITY;
        while lo < hi {
            if lo % 2 == 1 {
                minimum = minimum.min(self.minimum_slopes[lo]);
                lo += 1;
            }
            if hi % 2 == 1 {
                hi -= 1;
                minimum = minimum.min(self.minimum_slopes[hi]);
            }
            lo /= 2;
            hi /= 2;
        }
        minimum
    }
}

/// Adaptive decimal layout. On error the output is cleared, never a partial frame.
pub fn layout_ticks<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    source: &DecimalTicks,
    opacity: Opacity,
    density: Option<Density<'_>>,
    scratch: &mut LayoutScratch,
    output: &mut Vec<Tick>,
) -> Result<LayoutStats, Error> {
    output.clear();
    let result = adaptive(samples, source, opacity, density, scratch, output);
    if result.is_err() {
        output.clear();
    }
    result
}

fn adaptive<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    source: &DecimalTicks,
    opacity: Opacity,
    density: Option<Density<'_>>,
    scratch: &mut LayoutScratch,
    output: &mut Vec<Tick>,
) -> Result<LayoutStats, Error> {
    if density.is_some() {
        return pixel_layout(samples, source, opacity, density, output);
    }
    let width = samples.width();
    let bucket = opacity.bucket_width(width);
    let count = width.div_ceil(bucket);
    // When there are fewer occupied pixels than initial buckets, direct pixel
    // selection avoids summary/family work on mostly flat data. Stop counting
    // early on dense inputs, so this dispatch needs no exact slope arithmetic.
    let occupied = samples
        .values()
        .windows(2)
        .filter(|pair| {
            let lo = pair[0].as_f64();
            let hi = pair[1].as_f64();
            lo.is_finite() && hi.is_finite() && lo != hi
        })
        .take(count.saturating_add(1))
        .count();
    if occupied <= count {
        return pixel_layout(samples, source, opacity, None, output);
    }
    scratch.prepare(samples)?;
    let mut stats = LayoutStats {
        sample_count: samples.values().len(),
        ..LayoutStats::default()
    };
    // Monotonicity makes all nonfinite samples contiguous tails. Flat infinite
    // samples are valid too; clip every bucket to finite interval boundaries.
    let finite_start = samples
        .values()
        .partition_point(|value| value.as_f64() == f64::NEG_INFINITY);
    let finite_end = samples
        .values()
        .partition_point(|value| value.as_f64() != f64::INFINITY)
        .saturating_sub(1);
    // Initial buckets in reverse order; DFS visits pixels in ascending order.
    for index in (0..count).rev() {
        let from = index * bucket;
        scratch
            .stack
            .push((from, from.saturating_add(bucket).min(width)));
    }
    while let Some((mut from, mut to)) = scratch.stack.pop() {
        stats.buckets_visited += 1;
        let min_slope = scratch.minimum(from, to);
        if min_slope == f64::INFINITY {
            stats.buckets_skipped += 1;
            continue;
        }
        from = from.max(finite_start);
        to = to.min(finite_end);
        if from >= to {
            stats.buckets_skipped += 1;
            continue;
        }
        let lower = samples.values()[from].as_f64();
        let upper = samples.values()[to].as_f64();
        let interval = source.interval(lower, upper);
        if to - from == 1 {
            stats.pixel_selections += 1;
            if let Some(selection) = source.select_interval(&interval, &mut stats.family_lookups) {
                emit(samples, from, selection, opacity, None, output)?;
            }
            continue;
        }
        // If RN(s) reaches the cutoff, exact s must exceed the preceding float.
        // Combine that lower bound with an outward-rounded minimum slope.
        let threshold = Ratio::from_f64(min_slope)
            .mul(&Ratio::from_f64(opacity.cutoff_px().next_down().max(0.0)))
            .mul_units(u128::from(samples.window().span_units()), width as u128);
        let Some(index) = source.finest_possible(&threshold, &mut stats.family_lookups) else {
            stats.buckets_skipped += 1;
            continue;
        };
        stats.family_lookups += 1;
        let candidates = candidate_count(&interval, &source.families[index]);
        if candidates == 0 {
            stats.buckets_skipped += 1;
            continue;
        }
        if candidates == 1 {
            let selection = source.select_interval(&interval, &mut stats.family_lookups);
            if let Some(selection) = selection {
                let pixel = owning_pixel(samples, from, to, &selection.value);
                emit(samples, pixel, selection, opacity, None, output)?;
            } else {
                stats.buckets_skipped += 1;
            }
        } else {
            let mid = from + (to - from) / 2;
            stats.buckets_split += 1;
            scratch.stack.push((mid, to));
            scratch.stack.push((from, mid));
        }
    }
    stats.emitted_ticks = output.len();
    Ok(stats)
}

/// Exhaustive pixels using the production selector: isolates bucketing performance.
pub fn layout_pixels<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    source: &DecimalTicks,
    opacity: Opacity,
    density: Option<Density<'_>>,
    output: &mut Vec<Tick>,
) -> Result<LayoutStats, Error> {
    output.clear();
    let result = pixel_layout(samples, source, opacity, density, output);
    if result.is_err() {
        output.clear();
    }
    result
}

pub(crate) fn pixel_layout<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    source: &DecimalTicks,
    opacity: Opacity,
    density: Option<Density<'_>>,
    output: &mut Vec<Tick>,
) -> Result<LayoutStats, Error> {
    let mut stats = LayoutStats {
        sample_count: samples.values().len(),
        ..LayoutStats::default()
    };
    for pixel in 0..samples.width() {
        stats.buckets_visited += 1;
        let lower = samples.values()[pixel].as_f64();
        let upper = samples.values()[pixel + 1].as_f64();
        if !lower.is_finite() || !upper.is_finite() || lower == upper {
            stats.buckets_skipped += 1;
            continue;
        }
        stats.pixel_selections += 1;
        let selection =
            source.select_interval(&source.interval(lower, upper), &mut stats.family_lookups);
        if let Some(selection) = selection {
            emit(samples, pixel, selection, opacity, density, output)?;
        }
    }
    stats.emitted_ticks = output.len();
    Ok(stats)
}

fn owning_pixel<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    mut from: usize,
    mut to: usize,
    value: &ExactDecimal,
) -> usize {
    let value = value
        .ratio()
        .expect("selected tick is in the bounded decimal domain");
    while to - from > 1 {
        let mid = from + (to - from) / 2;
        if value
            .cmp(&Ratio::from_f64(samples.values()[mid].as_f64()))
            .is_le()
        {
            to = mid;
        } else {
            from = mid;
        }
    }
    from
}

pub(crate) fn emit<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    pixel: usize,
    selection: TickSelection,
    opacity: Opacity,
    density: Option<Density<'_>>,
    output: &mut Vec<Tick>,
) -> Result<(), Error> {
    let numeric_density = if let Some(density) = density {
        let density = density(selection.value.to_f64()?);
        if density.is_nan() || density < 0.0 {
            return Err(Error::InvalidDensity);
        }
        Some(density)
    } else {
        None
    };
    let alpha = {
        let spacing = selection.family.spacing().ratio()?;
        let span = u128::from(samples.window().span_units());
        match numeric_density {
            Some(f64::INFINITY) => 255,
            Some(density) => opacity.alpha_finite(
                &spacing
                    .mul(&Ratio::from_f64(density))
                    .mul_units((1_u128 << P::BITS) * samples.width() as u128, span),
            ),
            None => {
                let lo = Ratio::from_f64(samples.values()[pixel].as_f64());
                let hi = Ratio::from_f64(samples.values()[pixel + 1].as_f64());
                opacity.alpha_finite(&spacing.div(&hi.sub(&lo)).mul_units(
                    u128::from(samples.code(pixel + 1) - samples.code(pixel))
                        * samples.width() as u128,
                    span,
                ))
            }
        }
    };
    if alpha == 0 {
        return Ok(());
    }
    let position_px = project_tick(samples, pixel, &selection.value)?;
    output.push(Tick {
        value: selection.value,
        family: selection.family,
        position_px,
        alpha,
    });
    Ok(())
}

pub(crate) fn project_tick<P: Probability, V: QuantileValue>(
    samples: SampledQuantile<'_, P, V>,
    pixel: usize,
    value: &ExactDecimal,
) -> Result<f64, Error> {
    let lo = Ratio::from_f64(samples.values()[pixel].as_f64());
    let hi = Ratio::from_f64(samples.values()[pixel + 1].as_f64());
    let fraction = value.ratio()?.sub(&lo).div(&hi.sub(&lo));
    Ok(fraction
        .mul_units(u128::from(samples.code(pixel + 1) - samples.code(pixel)), 1)
        .add_units(u128::from(
            samples.code(pixel) - samples.window().lo().raw(),
        ))
        .mul_units(
            samples.width() as u128,
            u128::from(samples.window().span_units()),
        )
        .to_f64())
}
