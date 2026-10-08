use std::{cmp::Ordering, fmt, str::FromStr};

use num_bigint::BigInt;
use num_traits::{One, Signed, Zero};

use crate::{Error, ratio::Ratio};

/// A normalized, exact coefficient × 10^exponent. Zero has exponent zero.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ExactDecimal {
    coefficient: BigInt,
    exponent: i32,
}

impl ExactDecimal {
    pub fn new(coefficient: impl Into<BigInt>, exponent: i32) -> Result<Self, Error> {
        let mut coefficient = coefficient.into();
        let mut exponent = exponent;
        if coefficient.is_zero() {
            return Ok(Self::zero());
        }
        while (&coefficient % 10_u8).is_zero() {
            coefficient /= 10_u8;
            exponent = exponent.checked_add(1).ok_or(Error::ExponentOverflow)?;
        }
        Ok(Self {
            coefficient,
            exponent,
        })
    }

    pub fn zero() -> Self {
        Self {
            coefficient: BigInt::zero(),
            exponent: 0,
        }
    }
    pub fn coefficient(&self) -> &BigInt {
        &self.coefficient
    }
    pub fn exponent(&self) -> i32 {
        self.exponent
    }

    /// Numeric projection only; never used to generate or compare ticks.
    pub fn to_f64(&self) -> Result<f64, Error> {
        Ok(self.ratio()?.to_f64())
    }

    pub(crate) fn ratio(&self) -> Result<Ratio, Error> {
        check_exponent(self.exponent)?;
        let power = ten_pow(self.exponent.unsigned_abs());
        Ok(if self.exponent >= 0 {
            Ratio::new(&self.coefficient * power, BigInt::one())
        } else {
            Ratio::new(self.coefficient.clone(), power)
        })
    }

    pub(crate) fn add(&self, other: &Self) -> Self {
        if self.coefficient.is_zero() {
            return other.clone();
        }
        if other.coefficient.is_zero() {
            return self.clone();
        }
        let exponent = self.exponent.min(other.exponent);
        let a = &self.coefficient * ten_pow((self.exponent - exponent) as u32);
        let b = &other.coefficient * ten_pow((other.exponent - exponent) as u32);
        Self::new(a + b, exponent).expect("bounded tick arithmetic cannot overflow the exponent")
    }
}

pub(crate) fn check_exponent(exponent: i32) -> Result<(), Error> {
    if !(-4096..=4096).contains(&exponent) {
        return Err(Error::UnsupportedExponent);
    }
    Ok(())
}

pub(crate) fn ten_pow(exponent: u32) -> BigInt {
    BigInt::from(10_u8).pow(exponent)
}

impl Default for ExactDecimal {
    fn default() -> Self {
        Self::zero()
    }
}

impl Ord for ExactDecimal {
    fn cmp(&self, other: &Self) -> Ordering {
        let sign = self.coefficient.sign().cmp(&other.coefficient.sign());
        // BigInt's Sign enum is Minus, NoSign, Plus.
        if sign != Ordering::Equal {
            return sign;
        }
        if self.coefficient.is_zero() {
            return Ordering::Equal;
        }
        let a = self.coefficient.abs().to_string();
        let b = other.coefficient.abs().to_string();
        let magnitude = (a.len() as i64 + i64::from(self.exponent))
            .cmp(&(b.len() as i64 + i64::from(other.exponent)));
        let ordering = if magnitude != Ordering::Equal {
            magnitude
        } else {
            let length = a.len().max(b.len());
            a.bytes()
                .chain(std::iter::repeat(b'0'))
                .take(length)
                .cmp(b.bytes().chain(std::iter::repeat(b'0')).take(length))
        };
        if self.coefficient.is_negative() {
            ordering.reverse()
        } else {
            ordering
        }
    }
}

impl PartialOrd for ExactDecimal {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for ExactDecimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let digits = self.coefficient.abs().to_string();
        if self.coefficient.is_negative() {
            f.write_str("-")?;
        }
        let point = digits.len() as i64 + i64::from(self.exponent);
        // Avoid allocating millions of zeroes for an exact scientific value.
        if !(-6..=32).contains(&point) || digits.len() > 64 {
            return write!(f, "{digits}e{}", self.exponent);
        }
        if point <= 0 {
            f.write_str("0.")?;
            for _ in 0..-point {
                f.write_str("0")?;
            }
            f.write_str(&digits)
        } else if point < digits.len() as i64 {
            let point = point as usize;
            write!(f, "{}.{}", &digits[..point], &digits[point..])
        } else {
            f.write_str(&digits)?;
            for _ in digits.len() as i64..point {
                f.write_str("0")?;
            }
            Ok(())
        }
    }
}

impl FromStr for ExactDecimal {
    type Err = Error;
    fn from_str(text: &str) -> Result<Self, Error> {
        let (mantissa, exponent) = match text.split_once(['e', 'E']) {
            Some((mantissa, exponent)) => (
                mantissa,
                exponent.parse::<i32>().map_err(|_| Error::InvalidDecimal)?,
            ),
            None => (text, 0),
        };
        let (negative, body) = if let Some(body) = mantissa.strip_prefix('-') {
            (true, body)
        } else {
            (false, mantissa.strip_prefix('+').unwrap_or(mantissa))
        };
        let mut digits = String::new();
        let mut after_point = false;
        let mut fractional_digits = 0_i32;
        for byte in body.bytes() {
            if byte == b'.' && !after_point {
                after_point = true;
                continue;
            }
            if !byte.is_ascii_digit() {
                return Err(Error::InvalidDecimal);
            }
            digits.push(char::from(byte));
            if after_point {
                fractional_digits = fractional_digits
                    .checked_add(1)
                    .ok_or(Error::ExponentOverflow)?;
            }
        }
        if digits.is_empty() {
            return Err(Error::InvalidDecimal);
        }
        let mut coefficient =
            BigInt::parse_bytes(digits.as_bytes(), 10).ok_or(Error::InvalidDecimal)?;
        if negative {
            coefficient = -coefficient;
        }
        Self::new(
            coefficient,
            exponent
                .checked_sub(fractional_digits)
                .ok_or(Error::ExponentOverflow)?,
        )
    }
}
