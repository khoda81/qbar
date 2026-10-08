//! Exact private bridge between binary quantile samples and decimal arithmetic.
use num_bigint::BigInt;
use num_integer::Integer;
use num_traits::{One, Signed, ToPrimitive, Zero};

#[derive(Clone, Debug)]
pub(crate) struct Ratio {
    pub(crate) num: BigInt,
    pub(crate) den: BigInt,
}

impl Ratio {
    pub(crate) fn new(num: BigInt, den: BigInt) -> Self {
        debug_assert!(den.is_positive());
        let gcd = num.gcd(&den);
        Self {
            num: num / &gcd,
            den: den / gcd,
        }
    }

    pub(crate) fn from_f64(value: f64) -> Self {
        debug_assert!(value.is_finite());
        let bits = value.to_bits();
        let encoded_exponent = ((bits >> 52) & 0x7ff) as i32;
        let mut mantissa = bits & ((1_u64 << 52) - 1);
        let mut exponent = if encoded_exponent == 0 {
            -1074
        } else {
            mantissa |= 1_u64 << 52;
            encoded_exponent - 1023 - 52
        };
        if mantissa == 0 {
            return Self {
                num: BigInt::zero(),
                den: BigInt::one(),
            };
        }
        let zeros = mantissa.trailing_zeros();
        mantissa >>= zeros;
        exponent += zeros as i32;
        let mut num = BigInt::from(mantissa);
        if bits >> 63 != 0 {
            num = -num;
        }
        if exponent >= 0 {
            Self {
                num: num << exponent as usize,
                den: BigInt::one(),
            }
        } else {
            Self {
                num,
                den: BigInt::one() << -exponent as usize,
            }
        }
    }

    pub(crate) fn sub(&self, other: &Self) -> Self {
        if other.num.is_zero() {
            return self.clone();
        }
        Self::new(
            &self.num * &other.den - &other.num * &self.den,
            &self.den * &other.den,
        )
    }

    pub(crate) fn div(&self, other: &Self) -> Self {
        debug_assert!(other.num.is_positive());
        Self::new(&self.num * &other.den, &self.den * &other.num)
    }

    pub(crate) fn mul(&self, other: &Self) -> Self {
        Self::new(&self.num * &other.num, &self.den * &other.den)
    }

    pub(crate) fn add_units(&self, units: u128) -> Self {
        Self::new(
            &self.num + BigInt::from(units) * &self.den,
            self.den.clone(),
        )
    }

    pub(crate) fn mul_units(&self, numerator: u128, denominator: u128) -> Self {
        Self::new(
            &self.num * BigInt::from(numerator),
            &self.den * BigInt::from(denominator),
        )
    }

    pub(crate) fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (&self.num * &other.den).cmp(&(&other.num * &self.den))
    }

    pub(crate) fn floor_div(&self, positive: &Self) -> BigInt {
        (&self.num * &positive.den).div_floor(&(&self.den * &positive.num))
    }

    /// Correctly rounded binary64, including subnormals and overflowing ratios.
    pub(crate) fn to_f64(&self) -> f64 {
        if self.num.is_zero() {
            return 0.0;
        }
        let sign = if self.num.is_negative() {
            1_u64 << 63
        } else {
            0
        };
        let n = self.num.abs();
        let mut exponent = n.bits() as i64 - self.den.bits() as i64;
        let below = if exponent >= 0 {
            n < (&self.den << exponent as usize)
        } else {
            (&n << -exponent as usize) < self.den
        };
        if below {
            exponent -= 1;
        }
        if exponent > 1023 {
            return f64::from_bits(sign | (0x7ff_u64 << 52));
        }
        if exponent < -1075 {
            return f64::from_bits(sign);
        }
        let shift = if exponent < -1022 {
            1074
        } else {
            52 - exponent
        };
        let (numerator, denominator) = if shift >= 0 {
            (n << shift as usize, self.den.clone())
        } else {
            (n, &self.den << -shift as usize)
        };
        let (mut q, remainder) = numerator.div_rem(&denominator);
        let doubled = remainder << 1;
        if doubled > denominator || (doubled == denominator && q.is_odd()) {
            q += 1;
        }
        let mut mantissa = q.to_u64().expect("rounded significand fits u64");
        if exponent < -1022 {
            return f64::from_bits(sign | mantissa);
        }
        if mantissa == 1_u64 << 53 {
            mantissa >>= 1;
            exponent += 1;
        }
        if exponent > 1023 {
            return f64::from_bits(sign | (0x7ff_u64 << 52));
        }
        f64::from_bits(sign | ((exponent + 1023) as u64) << 52 | (mantissa - (1_u64 << 52)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_roundtrip_including_extremes() {
        for value in [
            0.0,
            -0.0,
            0.1,
            -0.1,
            1.0,
            f64::MAX,
            -f64::MAX,
            f64::MIN_POSITIVE,
            f64::from_bits(1),
            -f64::from_bits(1),
        ] {
            let result = Ratio::from_f64(value).to_f64();
            assert_eq!(result, value);
            if value != 0.0 {
                assert_eq!(result.to_bits(), value.to_bits());
            }
        }
        let mut bits = 19_u64;
        for _ in 0..10_000 {
            bits = bits.wrapping_mul(6364136223846793005).wrapping_add(1);
            let value = f64::from_bits(bits);
            if value.is_finite() {
                assert_eq!(Ratio::from_f64(value).to_f64().to_bits(), value.to_bits());
            }
        }
    }
    #[test]
    fn ties_round_to_even() {
        let one = BigInt::one();
        let denominator: BigInt = &one << 53_usize;
        assert_eq!(
            Ratio::new(&denominator + 1, denominator.clone()).to_f64(),
            1.0
        );
        assert_eq!(
            Ratio::new(&denominator + 3, denominator).to_f64().to_bits(),
            1.0_f64.to_bits() + 2
        );
        assert_eq!(Ratio::new(one.clone(), &one << 1075).to_f64(), 0.0);
        assert_eq!(
            Ratio::new(BigInt::from(3), &one << 1075).to_f64().to_bits(),
            2
        );
    }
}
