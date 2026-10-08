use std::ops::RangeInclusive;

use num_bigint::BigInt;
use num_traits::{One, Signed};

use crate::{Error, ExactDecimal, decimal::check_exponent, ratio::Ratio};

/// All supported decimal chains are nested, including across decade boundaries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DecimalChain {
    #[default]
    PowersOfTen,
    OneTwo,
    OneFive,
}

impl DecimalChain {
    fn multipliers(self) -> &'static [u8] {
        match self {
            Self::PowersOfTen => &[1],
            Self::OneTwo => &[1, 2],
            Self::OneFive => &[1, 5],
        }
    }
}

/// A family descriptor created by a validated decimal chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecimalFamily {
    multiplier: u8,
    exponent: i32,
}

impl DecimalFamily {
    pub fn multiplier(self) -> u8 {
        self.multiplier
    }
    pub fn exponent(self) -> i32 {
        self.exponent
    }
    pub fn spacing(self) -> ExactDecimal {
        ExactDecimal::new(self.multiplier, self.exponent).expect("family exponent is bounded")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TickSelection {
    pub value: ExactDecimal,
    pub family: DecimalFamily,
}

pub(crate) struct Family {
    pub(crate) descriptor: DecimalFamily,
    pub(crate) spacing: Ratio,
}

pub(crate) struct Interval {
    pub(crate) lower: Ratio,
    pub(crate) upper: Ratio,
}

impl Interval {
    pub(crate) fn contains_origin(&self) -> bool {
        self.lower.num.is_negative() && !self.upper.num.is_negative()
    }
    pub(crate) fn indices(&self, family: &Family) -> (BigInt, BigInt) {
        (
            self.lower.floor_div(&family.spacing),
            self.upper.floor_div(&family.spacing),
        )
    }
}

/// Exact family arithmetic. Finite exponent limits are explicit, never implicit pruning.
pub struct DecimalTicks {
    chain: DecimalChain,
    origin: ExactDecimal,
    pub(crate) origin_ratio: Ratio,
    pub(crate) families: Vec<Family>,
}

impl Default for DecimalTicks {
    fn default() -> Self {
        Self::new(DecimalChain::default())
    }
}

impl DecimalTicks {
    /// Covers useful spacings across the entire f32/f64 range.
    pub fn new(chain: DecimalChain) -> Self {
        Self::with_options(chain, ExactDecimal::zero(), -324..=309)
            .expect("default exponents are valid")
    }

    pub fn with_options(
        chain: DecimalChain,
        origin: ExactDecimal,
        exponents: RangeInclusive<i32>,
    ) -> Result<Self, Error> {
        let (lo, hi) = (*exponents.start(), *exponents.end());
        check_exponent(lo)?;
        check_exponent(hi)?;
        if lo > hi {
            return Err(Error::UnsupportedExponent);
        }
        let origin_ratio = origin.ratio()?;
        let mut families = Vec::new();
        for exponent in lo..=hi {
            for &multiplier in chain.multipliers() {
                let descriptor = DecimalFamily {
                    multiplier,
                    exponent,
                };
                families.push(Family {
                    descriptor,
                    spacing: descriptor.spacing().ratio()?,
                });
            }
        }
        Ok(Self {
            chain,
            origin,
            origin_ratio,
            families,
        })
    }

    pub fn chain(&self) -> DecimalChain {
        self.chain
    }
    pub fn origin(&self) -> &ExactDecimal {
        &self.origin
    }
    pub fn families(&self) -> impl DoubleEndedIterator<Item = DecimalFamily> + '_ {
        self.families.iter().map(|f| f.descriptor)
    }

    /// Coarsest family in (lower, upper], choosing its largest contained tick.
    /// Binary inputs are decoded exactly; no decimal tick is made from a float.
    pub fn select(&self, lower: f64, upper: f64) -> Result<Option<TickSelection>, Error> {
        if !lower.is_finite() || !upper.is_finite() || lower > upper {
            return Err(Error::InvalidSamples { index: 0 });
        }
        if lower == upper {
            return Ok(None);
        }
        Ok(self.select_interval(&self.interval(lower, upper), &mut 0))
    }

    pub(crate) fn interval(&self, lower: f64, upper: f64) -> Interval {
        Interval {
            lower: Ratio::from_f64(lower).sub(&self.origin_ratio),
            upper: Ratio::from_f64(upper).sub(&self.origin_ratio),
        }
    }

    pub(crate) fn selection(&self, index: BigInt, family: &Family) -> TickSelection {
        let step = family.descriptor;
        let relative = ExactDecimal::new(index * step.multiplier, step.exponent)
            .expect("tick exponent is bounded");
        TickSelection {
            value: self.origin.add(&relative),
            family: step,
        }
    }

    pub(crate) fn select_interval(
        &self,
        interval: &Interval,
        lookups: &mut u64,
    ) -> Option<TickSelection> {
        if interval.contains_origin() {
            return Some(TickSelection {
                value: self.origin.clone(),
                family: self
                    .families
                    .last()
                    .expect("validated nonempty families")
                    .descriptor,
            });
        }
        // Containment is monotone because the families are nested.
        let mut lo = 0;
        let mut hi = self.families.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            *lookups += 1;
            let (a, b) = interval.indices(&self.families[mid]);
            if b > a {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == 0 {
            return None;
        }
        let family = &self.families[lo - 1];
        Some(self.selection(interval.upper.floor_div(&family.spacing), family))
    }

    pub(crate) fn finest_possible(&self, threshold: &Ratio, lookups: &mut u64) -> Option<usize> {
        let mut lo = 0;
        let mut hi = self.families.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            *lookups += 1;
            if self.families[mid].spacing.cmp(threshold).is_lt() {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        (lo < self.families.len()).then_some(lo)
    }
}

/// Exact lattice count capped at two: empty, single candidate, or unresolved.
pub(crate) fn candidate_count(interval: &Interval, family: &Family) -> u8 {
    let (lo, hi) = interval.indices(family);
    if lo == hi {
        0
    } else if hi - lo == BigInt::one() {
        1
    } else {
        2
    }
}
