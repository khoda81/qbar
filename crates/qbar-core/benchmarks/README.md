# Native benchmark: 2026-10-08

Measured with Rust 1.98.1 (LLVM 22.1.8), optimized Cargo bench profile, on Linux
x86_64 / AMD Ryzen 5 4600H. This is one local native run, using the locked
dependencies, width 1024, five interleaved/rotated batches, and the `OneTwo` chain
with its default exponent range and zero origin. Five frames per batch were timed
for adaptive/binary pixels and one per batch for the exhaustive reference.
Source construction and allocation counting are excluded from timing.

All three algorithms produced exactly equal values, family descriptors, positions,
and alpha for every case. Each sampled 1025 boundaries; timed layouts reused the
same cached samples and made zero quantile callbacks. Sampling was timed separately
and its full measurements are in [the raw report](native-2026-10-08.json).

| Input                               | Adaptive µs/frame | Binary pixels µs/frame | Exhaustive reference µs/frame | Pixels / adaptive |
| ----------------------------------- | ----------------: | ---------------------: | ----------------------------: | ----------------: |
| uniform (Frac32 → f32)              |             946.2 |                 3319.4 |                      101815.8 |             3.51× |
| uniform (Frac64 → f64)              |            1037.3 |                 4457.9 |                      107727.0 |             4.30× |
| logistic (Frac32 → f64)             |            2547.7 |                 5532.4 |                      139245.4 |             2.17× |
| logistic (Frac64 → f32)             |            1773.7 |                 5445.3 |                      118192.0 |             3.07× |
| nonlinear-refinement (Frac64 → f64) |            2389.2 |                 6069.9 |                      112287.1 |             2.54× |
| flat-regions (Frac32 → f32)         |              22.7 |                   20.3 |                         442.0 |             0.89× |
| narrow-u64-window (Frac64 → f64)    |            2184.1 |                 5412.1 |                      133828.8 |             2.48× |
| analytic-density (Frac64 → f64)     |            5682.2 |                 5710.9 |                      139955.0 |             1.01× |

The adaptive path was 2.17–4.30× faster than the production pixel baseline on
these continuous inputs. This comparison isolates bucket pruning; the independent
reference scans every family and is intended as a correctness oracle.
Sparse flat data uses the pixel fallback, with about 12% extra dispatch overhead in
this run. Supplied density also uses pixel selection because point callbacks
provide no interval bounds; its timing is approximately the pixel baseline.
These results do not establish browser/WASM or TypeScript performance.

Counts below are **adaptive / binary pixels** per frame after buffer warm-up.

| Input                               | Family predicate lookups |   Allocations | Emitted ticks |
| ----------------------------------- | -----------------------: | ------------: | ------------: |
| uniform (Frac32 → f32)              |              611 / 10299 |   3677 / 8256 |            10 |
| uniform (Frac64 → f64)              |              611 / 10299 |  3870 / 18569 |            10 |
| logistic (Frac32 → f64)             |              892 / 10756 | 19907 / 32626 |            31 |
| logistic (Frac64 → f32)             |              902 / 10756 | 12136 / 20775 |            31 |
| nonlinear-refinement (Frac64 → f64) |             1360 / 10964 | 20862 / 44315 |             8 |
| flat-regions (Frac32 → f32)         |                  73 / 73 |       56 / 56 |             0 |
| narrow-u64-window (Frac64 → f64)    |              800 / 10257 | 11969 / 32829 |            31 |
| analytic-density (Frac64 → f64)     |            10756 / 10756 | 25157 / 25157 |            31 |

Reused sampling buffers performed zero allocations with these callbacks. Exact
BigInt/rational work still allocates inside layout. Reusing buffers means reusing
vector capacity, not eliminating every allocation. The JSON also reports fresh
buffer counts, reallocations, requested bytes, pixel/split/skip counts, and the
minimum/maximum/per-batch elapsed times. Requested bytes count allocation traffic,
including replacement sizes; they are not peak live memory.

Reproduce from the repository root:

```sh
cargo bench --locked -p qbar-core --bench layout > /tmp/qbar-native-benchmark.json
```

Override dimensions with `QBAR_BENCH_WIDTH` and `QBAR_BENCH_ROUNDS`. Timing varies
with machine load. Exact output equality and operation counts are asserted by
the harness before measurement.
