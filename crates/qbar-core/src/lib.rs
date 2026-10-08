//! Native decimal quantile layout with exact ticks and fixed-point probabilities.
//!
//! See the crate README and `examples/decimal.rs` for buffered usage. Probability
//! one is intentionally not representable; a full window ends at `Frac64::MAX`
//! or `Frac32::MAX`, never at a floating-point substitute for one.

#![forbid(unsafe_code)]
#![doc = include_str!("../README.md")]

mod decimal;
mod error;
mod layout;
mod mapping;
mod opacity;
mod probability;
mod ratio;
pub mod reference;
mod sampling;
mod ticks;

pub use decimal::ExactDecimal;
pub use error::Error;
pub use layout::{Density, LayoutScratch, LayoutStats, Tick, layout_pixels, layout_ticks};
pub use mapping::{
    position_at_probability, position_at_value, probability_at_position, value_at_position,
};
pub use num_bigint::BigInt;
pub use opacity::Opacity;
pub use probability::{Frac32, Frac64, Probability, ProbabilityWindow};
pub use sampling::{QuantileValue, SampleBuffer, SampledQuantile};
pub use ticks::{DecimalChain, DecimalFamily, DecimalTicks, TickSelection};
