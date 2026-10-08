use num_traits::Zero;

use crate::{Error, ratio::Ratio};

/// α(s)=exp(-scale/s). The byte cutoff derives the starting bucket size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opacity {
    scale: f64,
}

impl Default for Opacity {
    fn default() -> Self {
        Self {
            scale: 24.0 * 255_f64.ln(),
        }
    }
}

impl Opacity {
    pub fn new(scale: f64) -> Result<Self, Error> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err(Error::InvalidOpacityScale);
        }
        Ok(Self { scale })
    }
    pub fn scale(self) -> f64 {
        self.scale
    }
    pub fn cutoff_px(self) -> f64 {
        self.scale / 255_f64.ln()
    }
    pub fn alpha(self, spacing_px: f64) -> u8 {
        if spacing_px.is_nan() || spacing_px <= 0.0 || spacing_px < self.cutoff_px() {
            return 0;
        }
        if spacing_px == f64::INFINITY {
            return 255;
        }
        // Keep the exact byte-cutoff convention stable despite exp/log rounding.
        ((255.0 * (-self.scale / spacing_px).exp()).floor() as u8).max(1)
    }

    pub(crate) fn alpha_finite(self, spacing: &Ratio) -> u8 {
        if spacing.num.is_zero() {
            return 0;
        }
        let numeric = spacing.to_f64();
        if numeric == 0.0 || numeric == f64::INFINITY {
            // Positive finite spacings can lie beyond binary64's range. Round
            // the dimensionless attenuation instead of erasing them as 0/∞.
            let attenuation = Ratio::from_f64(self.scale).div(spacing).to_f64();
            return (255.0 * (-attenuation).exp()) as u8;
        }
        self.alpha(numeric)
    }
    pub(crate) fn bucket_width(self, width: usize) -> usize {
        (self.cutoff_px().floor() as usize).clamp(1, width)
    }
}
