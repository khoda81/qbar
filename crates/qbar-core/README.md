# qbar-core

Native Rust milestone for QBar: exact decimal ticks on a uniformly spaced binary
probability grid. The crate is independent of the existing TypeScript/browser
implementation. Duration, calendar time, general family composition, browser
components, WASM, and npm publication are later stages.

## Buffered usage

```rust
use qbar_core::{
    DecimalTicks, Frac64, LayoutScratch, Opacity, ProbabilityWindow,
    SampleBuffer, layout_ticks, value_at_position,
};

// Q(p) = log(p) - log(1-p). The binary denominator cancels.
fn quantile(p: Frac64) -> f64 {
    (p.raw() as f64).ln() - (p.complement_units() as f64).ln()
}

let width = 800;
let window = ProbabilityWindow::<Frac64>::default();
let source = DecimalTicks::default(); // Build once, reuse across frames.
let mut samples = SampleBuffer::<f64>::default();
let mut scratch = LayoutScratch::default();
let mut ticks = Vec::new();

let sampled = samples.sample(width, window, quantile)?;
let stats = layout_ticks(
    sampled, &source, Opacity::default(), None, &mut scratch, &mut ticks,
)?;
for tick in &ticks {
    println!("{}: {}px, alpha {}", tick.value, tick.position_px, tick.alpha);
}
assert_eq!(stats.sample_count, width + 1);
let slider_value = value_at_position(window, width, 400.0, quantile)?;
assert!(slider_value.is_finite());
# Ok::<(), qbar_core::Error>(())
```

`SampleBuffer<f32>` and `SampleBuffer<f64>` preserve the callback's output
precision. Both accept callbacks taking `Frac32` or `Frac64`, giving all four
combinations. `SampledQuantile::new` also accepts an existing borrowed sample
slice and validates it. The sample buffer, summary/traversal scratch, and output
vector keep their capacities across frames; exact `BigInt` arithmetic still
allocates internally. A layout error clears the output instead of leaving a
partial frame.

## Probability and decimal contracts

- `Frac32` represents `raw / 2^32`; `Frac64` represents `raw / 2^64`. Every raw
  code is valid. Their domain is `[0, 1)`: `MAX` is the final code, and probability
  one is never passed to a callback. `HALF`, raw access, integer differences, and
  `complement_units()` support calculations near either tail without subtracting
  two rounded probabilities.
- Windows have inclusive `lo..=hi` codes and require `lo < hi`. Sampling width
  `W` calls the quantile exactly `W + 1` times at
  `lo + floor((hi - lo) * i / W)`, using `u128`. A window with fewer than `W`
  code gaps is rejected. `boundary` and `interpolate` expose this integer mapping.
- `ExactDecimal` is a normalized `BigInt` coefficient times `10^exponent`.
  Nonzero coefficients have no trailing decimal zero; zero has exponent zero.
  Generation, stepping, identity, ordering, membership, and `Display`/`FromStr`
  formatting use integer arithmetic. Sample floats are decoded as their exact
  binary rational values for comparison. Only numeric projection and density
  calculations produce floating-point results.
- `DecimalChain` is closed: `PowersOfTen` (default), `OneTwo`, or `OneFive`.
  Adjacent spacings divide one another across decades, so every coarser lattice
  is a subset of the finer lattice. A common exact origin defaults to zero.
  There is no arbitrary multiplier list or `1–2–5` chain.
- `DecimalTicks::new` includes exponents `-324..=309`, covering the binary32 and
  binary64 output ranges. `with_options(chain, origin, exponents)` declares a
  different **finite** hierarchy. Selection uses the coarsest configured family;
  the origin follows the same rule. Numeric arithmetic supports exponents
  `-4096..=4096` and returns `UnsupportedExponent` outside that range.
  `ExactDecimal` identity, ordering, and formatting support the full `i32`
  exponent range; normalization returns an error if it would overflow `i32`.

## Layout, opacity, and boundary ownership

Each pixel owns `(Q(p_i), Q(p_{i+1})]`. A boundary tick belongs to the pixel
ending at that boundary. A pixel chooses the coarsest family present; if that
family has several ticks, it chooses the largest. Flat bins have no ticks.
Constant windows yield an empty layout. NaN and decreasing samples are rejected.
Monotone infinite tails are allowed, including flat infinite samples; every
unbounded edge interval is skipped.

For width `W`, displayed probability span `P`, spacing `Δx`, and local density
`f(x)`, the effective spacing is `s = (W/P) Δx f(x)`. Opacity is
`exp(-tau/s)`. `Opacity` exposes one finite positive scale `tau`, defaulting to
`24 ln(255)`. The byte cutoff is `d = tau/ln(255)`, hence 24 pixels by default.
Alpha is truncated to `u8`; spacing below the cutoff produces zero, equality
produces byte 1, zero spacing produces zero, and infinite spacing produces 255.
The equality rule avoids an accidental zero caused by `exp`/`ln` roundoff.

Without supplied density, the owning sample interval estimates
`f = Δp / (Q(p_{i+1}) - Q(p_i))`. Probability subtraction happens as integers.
The one-code variations in sample gaps affect both density and pixel projection.
Exact rational intermediates avoid overflow/cancellation for extreme values and
subnormals, and only the final spacing/position is rounded to `f64`.
When a positive finite spacing is outside `f64`'s range, opacity rounds `tau/s`
directly instead; this preserves information lost by turning the spacing into
zero or infinity. A truly infinite supplied density still produces alpha 255.

Adaptive search starts with buckets of `max(1, floor(d))` pixels. An `O(W)`
minimum-slope summary supplies an outward-rounded lower bound for each bucket's
`Δx_sample / Δp_units`. This determines the finest family that could be visible.
If no family can be visible, the bucket is skipped. If that finest lattice has
at most one tick in the bucket, nesting proves there can be at most one visible
candidate; selection locates it and evaluates its **local** density. Otherwise
the bucket splits, eventually reaching individual pixels. The cutoff is not a
hard separation rule: a refined initial bucket can emit several nearby ticks.
Worst-case selection still visits every pixel. Scratch memory is `O(W)`.
Inputs with fewer occupied pixels than initial buckets use direct pixel selection
to avoid summary work on sparse flat data.

Optional density is `Some(&|x: f64| -> f64 { ... })`, in probability per numeric
value unit. It is evaluated at the selected tick's numeric value and must be
nonnegative and not NaN; positive infinity is allowed. A point callback supplies
no conservative interval bound, so this path selects every nonflat finite pixel
before evaluating density. It does not use a bucket secant to hide work.

`probability_at_position` rounds the cursor's binary fraction onto raw probability
codes with integer arithmetic; `value_at_position` then calls `Q(p)` directly.
`position_at_probability` projects an exact code. `position_at_value` inverts the
sampled quantile by exact rational interpolation, chooses the leftmost sampled
occurrence on a plateau, and returns `None` outside the window or inside an
unbounded edge interval. `Tick` carries an exact value, decimal family descriptor,
`f64` pixel position, and `u8` alpha, without a preformatted label.

## Validation and reproducibility

From the repository root:

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cargo test --locked --workspace --all-targets
cargo run --locked -p qbar-core --example decimal
cargo run --locked -p qbar-core --example fixtures > /tmp/qbar-fixtures.json
cmp /tmp/qbar-fixtures.json crates/qbar-core/tests/fixtures/decimal-layout.json
cargo bench --locked -p qbar-core --bench layout
```

`reference::layout_reference` independently scans every pixel and every family
from coarse to fine. It generates exact candidates with a separate floor
calculation and membership check, and independently calculates density,
projection, and byte opacity. It shares only the exact decimal/rational types
and validated inputs. `layout_pixels` uses production binary family selection
at every pixel, providing a baseline that isolates the effect of adaptive search.

Deterministic property tests compare all three paths for exact tick values,
family descriptors, positions, and alpha. Raw-bit JSON fixtures capture samples,
probability windows, opacity scales, and expected output independently of text
float parsing. Tests cover all four quantile combinations, tail codes, integer
overflow boundaries, nested chains, exact origins, negative values, precision,
subnormals/extremes, cutoff-adjacent values, nonlinear refinement, flat regions,
and unbounded tails.

The benchmark verifies identical outputs before timing. It uses cached identical
samples, warm buffers, interleaved/rotated algorithm order, and median timings.
Allocation counts run separately from timing, with both fresh and reused buffers.
Reports include sample/callback counts, family lookups, split/skip/pixel counts,
allocation calls, requested bytes, and elapsed time. Source construction is
excluded. Timed layouts make zero quantile callbacks; sampling still costs
`W + 1` callbacks for every algorithm. These are native Rust comparisons, not a
measurement against TypeScript or a browser. Use `QBAR_BENCH_WIDTH` and
`QBAR_BENCH_ROUNDS` to reproduce other sizes or repetitions. Debug-profile bench
smokes use width 32 and one round; release defaults are width 1024 and five rounds.
