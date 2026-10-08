use crate::Error;

mod sealed {
    pub trait Sealed {}
}

/// A uniformly spaced unsigned binary fraction. There is no representation of 1.
pub trait Probability: sealed::Sealed + Copy + Eq + Ord + std::fmt::Debug {
    const BITS: u32;
    const ZERO: Self;
    const MAX: Self;
    fn raw(self) -> u64;
    fn from_raw(raw: u64) -> Option<Self>;

    /// Exact code distance, or None if `lower` is above this probability.
    fn difference_units(self, lower: Self) -> Option<u64> {
        self.raw().checked_sub(lower.raw())
    }

    /// Exact numerator of 1-p, including 2^BITS at p=0.
    fn complement_units(self) -> u128 {
        (1_u128 << Self::BITS) - u128::from(self.raw())
    }
}

macro_rules! fraction {
    ($name:ident, $int:ty, $bits:literal) => {
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name($int);

        impl $name {
            pub const ZERO: Self = Self(0);
            pub const MAX: Self = Self(<$int>::MAX);
            pub const HALF: Self = Self(1 << ($bits - 1));
            pub const fn new(raw: $int) -> Self {
                Self(raw)
            }
            pub const fn raw(self) -> $int {
                self.0
            }
            pub const fn difference_units(self, lower: Self) -> Option<$int> {
                self.0.checked_sub(lower.0)
            }
            pub const fn complement_units(self) -> u128 {
                (1_u128 << $bits) - self.0 as u128
            }
        }

        impl sealed::Sealed for $name {}
        impl Probability for $name {
            const BITS: u32 = $bits;
            const ZERO: Self = Self::ZERO;
            const MAX: Self = Self::MAX;
            fn raw(self) -> u64 {
                self.0 as u64
            }
            fn from_raw(raw: u64) -> Option<Self> {
                <$int>::try_from(raw).ok().map(Self)
            }
        }
    };
}

fraction!(Frac32, u32, 32);
fraction!(Frac64, u64, 64);

/// Inclusive bounds on representable probability codes, inside [0,1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProbabilityWindow<P: Probability> {
    lo: P,
    hi: P,
}

impl<P: Probability> Default for ProbabilityWindow<P> {
    fn default() -> Self {
        Self {
            lo: P::ZERO,
            hi: P::MAX,
        }
    }
}

impl<P: Probability> ProbabilityWindow<P> {
    pub fn new(lo: P, hi: P) -> Result<Self, Error> {
        if lo >= hi {
            return Err(Error::InvalidWindow);
        }
        Ok(Self { lo, hi })
    }
    pub fn lo(self) -> P {
        self.lo
    }
    pub fn hi(self) -> P {
        self.hi
    }
    pub fn span_units(self) -> u64 {
        self.hi.raw() - self.lo.raw()
    }

    /// Integer interpolation across the inclusive code window. Rounds down.
    pub fn interpolate(self, numerator: u64, denominator: u64) -> Result<P, Error> {
        if denominator == 0 || numerator > denominator {
            return Err(Error::InvalidPosition);
        }
        let offset =
            u128::from(self.span_units()) * u128::from(numerator) / u128::from(denominator);
        Ok(P::from_raw(self.lo.raw() + offset as u64).expect("bounded interpolation"))
    }

    /// Code at one of W+1 pixel boundaries, with exact u128 arithmetic.
    pub fn boundary(self, width: usize, index: usize) -> Result<P, Error> {
        self.validate_width(width)?;
        if index > width {
            return Err(Error::InvalidPosition);
        }
        Ok(self.sample(index, width))
    }

    pub(crate) fn validate_width(self, width: usize) -> Result<(), Error> {
        if width == 0 {
            return Err(Error::InvalidWidth);
        }
        if width as u128 > u128::from(self.span_units()) {
            return Err(Error::InsufficientProbabilityResolution);
        }
        Ok(())
    }

    pub(crate) fn sample(self, index: usize, width: usize) -> P {
        let offset = u128::from(self.span_units()) * index as u128 / width as u128;
        P::from_raw(self.lo.raw() + offset as u64).expect("offset stays inside the window")
    }
}
