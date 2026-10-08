use std::fmt;

/// Invalid external input. Layouts never use NaN as an empty-tick sentinel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidWindow,
    InvalidWidth,
    InsufficientProbabilityResolution,
    InvalidSamples { index: usize },
    InvalidDensity,
    InvalidOpacityScale,
    InvalidPosition,
    InvalidDecimal,
    ExponentOverflow,
    UnsupportedExponent,
    AllocationFailed,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidWindow => f.write_str("probability window must have lo < hi"),
            Self::InvalidWidth => f.write_str("width must be positive"),
            Self::InsufficientProbabilityResolution => {
                f.write_str("probability window is too narrow for distinct pixel boundaries")
            }
            Self::InvalidSamples { index } => write!(f, "invalid quantile sample at index {index}"),
            Self::InvalidDensity => f.write_str("density must be nonnegative and not NaN"),
            Self::InvalidOpacityScale => f.write_str("opacity scale must be positive and finite"),
            Self::InvalidPosition => f.write_str("position must be finite and inside the window"),
            Self::InvalidDecimal => f.write_str("invalid exact decimal"),
            Self::ExponentOverflow => f.write_str("normalized decimal exponent overflowed i32"),
            Self::UnsupportedExponent => {
                f.write_str("arithmetic exponent must be within -4096..=4096")
            }
            Self::AllocationFailed => f.write_str("could not allocate reusable buffers"),
        }
    }
}

impl std::error::Error for Error {}
