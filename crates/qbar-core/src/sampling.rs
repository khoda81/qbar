use crate::{Error, Probability, ProbabilityWindow};

mod sealed {
    pub trait Sealed {}
}

/// Supported quantile output types. Sample buffers preserve their precision.
pub trait QuantileValue: sealed::Sealed + Copy + std::fmt::Debug {
    const ZERO: Self;
    fn as_f64(self) -> f64;
}
impl sealed::Sealed for f32 {}
impl sealed::Sealed for f64 {}
impl QuantileValue for f32 {
    const ZERO: Self = 0.0;
    fn as_f64(self) -> f64 {
        f64::from(self)
    }
}
impl QuantileValue for f64 {
    const ZERO: Self = 0.0;
    fn as_f64(self) -> f64 {
        self
    }
}

/// Validated immutable samples. Their probability codes are derived from the window.
#[derive(Clone, Copy, Debug)]
pub struct SampledQuantile<'a, P: Probability, V: QuantileValue> {
    values: &'a [V],
    window: ProbabilityWindow<P>,
}

impl<'a, P: Probability, V: QuantileValue> SampledQuantile<'a, P, V> {
    pub fn new(values: &'a [V], window: ProbabilityWindow<P>) -> Result<Self, Error> {
        if values.len() < 2 {
            return Err(Error::InvalidWidth);
        }
        let width = values.len() - 1;
        window.validate_width(width)?;
        let mut previous = f64::NEG_INFINITY;
        for (index, &value) in values.iter().enumerate() {
            let value = value.as_f64();
            if value.is_nan() || value < previous {
                return Err(Error::InvalidSamples { index });
            }
            previous = value;
        }
        Ok(Self { values, window })
    }
    pub fn values(self) -> &'a [V] {
        self.values
    }
    pub fn width(self) -> usize {
        self.values.len() - 1
    }
    pub fn window(self) -> ProbabilityWindow<P> {
        self.window
    }
    pub fn probability(self, boundary: usize) -> Option<P> {
        (boundary <= self.width()).then(|| self.window.sample(boundary, self.width()))
    }
    pub(crate) fn code(self, boundary: usize) -> u64 {
        self.window.sample(boundary, self.width()).raw()
    }
}

/// Reusable storage. A failed callback validation cannot expose invalid samples.
#[derive(Debug)]
pub struct SampleBuffer<V: QuantileValue> {
    values: Vec<V>,
}
impl<V: QuantileValue> Default for SampleBuffer<V> {
    fn default() -> Self {
        Self { values: Vec::new() }
    }
}

impl<V: QuantileValue> SampleBuffer<V> {
    pub fn sample<P: Probability>(
        &mut self,
        width: usize,
        window: ProbabilityWindow<P>,
        mut quantile: impl FnMut(P) -> V,
    ) -> Result<SampledQuantile<'_, P, V>, Error> {
        window.validate_width(width)?;
        let length = width.checked_add(1).ok_or(Error::InvalidWidth)?;
        if length > self.values.len() {
            self.values
                .try_reserve(length - self.values.len())
                .map_err(|_| Error::AllocationFailed)?;
        }
        self.values.resize(length, V::ZERO);
        for (index, slot) in self.values.iter_mut().enumerate() {
            *slot = quantile(window.sample(index, width));
        }
        SampledQuantile::new(&self.values, window)
    }
}
