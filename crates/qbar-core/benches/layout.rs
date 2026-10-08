//! Paired native benchmark. Timing and allocation counting run separately.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    hint::black_box,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Instant,
};

use qbar_core::{
    DecimalChain, DecimalTicks, Density, Frac32, Frac64, LayoutScratch, LayoutStats, Opacity,
    Probability, ProbabilityWindow, QuantileValue, SampleBuffer, SampledQuantile, Tick,
    layout_pixels, layout_ticks, reference::layout_reference,
};
use serde_json::{Value, json};

struct CountingAllocator;
static TRACK: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static REALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static REQUESTED_BYTES: AtomicU64 = AtomicU64::new(0);

fn count(bytes: usize, realloc: bool) {
    if TRACK.load(Ordering::Relaxed) {
        if realloc {
            REALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        } else {
            ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        }
        REQUESTED_BYTES.fetch_add(bytes as u64, Ordering::Relaxed);
    }
}

// SAFETY: this wrapper forwards each request and its original layout to System.
// Atomic counters do not allocate or change the lifetime/alignment of any block.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size(), false);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size(), false);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count(size, true);
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[derive(Clone, Copy)]
enum Algorithm {
    Adaptive,
    Pixels,
    Reference,
}
const ALGORITHMS: [Algorithm; 3] = [Algorithm::Adaptive, Algorithm::Pixels, Algorithm::Reference];

impl Algorithm {
    fn label(self) -> &'static str {
        match self {
            Self::Adaptive => "adaptive",
            Self::Pixels => "binary_pixels",
            Self::Reference => "exhaustive_reference",
        }
    }
    fn run<P: Probability, V: QuantileValue>(
        self,
        samples: SampledQuantile<'_, P, V>,
        source: &DecimalTicks,
        density: Option<Density<'_>>,
        scratch: &mut LayoutScratch,
        ticks: &mut Vec<Tick>,
    ) -> LayoutStats {
        match self {
            Self::Adaptive => {
                layout_ticks(samples, source, Opacity::default(), density, scratch, ticks)
            }
            Self::Pixels => layout_pixels(samples, source, Opacity::default(), density, ticks),
            Self::Reference => {
                layout_reference(samples, source, Opacity::default(), density, ticks)
            }
        }
        .unwrap()
    }
}

#[derive(Default)]
struct State {
    scratch: LayoutScratch,
    ticks: Vec<Tick>,
}

fn allocation_counts(run: impl FnOnce()) -> Value {
    ALLOCATIONS.store(0, Ordering::Relaxed);
    REALLOCATIONS.store(0, Ordering::Relaxed);
    REQUESTED_BYTES.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::Relaxed);
    run();
    TRACK.store(false, Ordering::Relaxed);
    json!({
        "allocations": ALLOCATIONS.load(Ordering::Relaxed),
        "reallocations": REALLOCATIONS.load(Ordering::Relaxed),
        "requested_bytes": REQUESTED_BYTES.load(Ordering::Relaxed),
    })
}

fn stats_json(stats: LayoutStats) -> Value {
    json!({
        "samples": stats.sample_count,
        "family_lookups": stats.family_lookups,
        "buckets_visited": stats.buckets_visited,
        "buckets_split": stats.buckets_split,
        "buckets_skipped": stats.buckets_skipped,
        "pixel_selections": stats.pixel_selections,
        "ticks": stats.emitted_ticks,
    })
}

#[allow(clippy::too_many_arguments)]
fn scenario<P: Probability, V: QuantileValue>(
    name: &str,
    width: usize,
    rounds: usize,
    window: ProbabilityWindow<P>,
    source: &DecimalTicks,
    quantile: impl Fn(P) -> V,
    density: Option<Density<'_>>,
    output_bits: u8,
) -> Value {
    let mut buffer = SampleBuffer::<V>::default();
    let mut callback_count = 0;
    let samples = buffer
        .sample(width, window, |p| {
            callback_count += 1;
            quantile(p)
        })
        .unwrap();
    assert_eq!(callback_count, width + 1);
    let mut states: [State; 3] = std::array::from_fn(|_| State::default());
    let mut stats = [LayoutStats::default(); 3];
    for (index, algorithm) in ALGORITHMS.iter().enumerate() {
        let state = &mut states[index];
        stats[index] = algorithm.run(
            samples,
            source,
            density,
            &mut state.scratch,
            &mut state.ticks,
        );
    }
    assert_eq!(
        states[0].ticks, states[2].ticks,
        "{name}: adaptive/reference"
    );
    assert_eq!(states[1].ticks, states[2].ticks, "{name}: binary/reference");
    let mut allocations = Vec::new();
    let mut fresh_allocations = Vec::new();
    for (index, algorithm) in ALGORITHMS.iter().enumerate() {
        let state = &mut states[index];
        allocations.push(allocation_counts(|| {
            algorithm.run(
                samples,
                source,
                density,
                &mut state.scratch,
                &mut state.ticks,
            );
            black_box(&state.ticks);
        }));
        let mut fresh = State::default();
        fresh_allocations.push(allocation_counts(|| {
            algorithm.run(
                samples,
                source,
                density,
                &mut fresh.scratch,
                &mut fresh.ticks,
            );
            black_box(&fresh.ticks);
        }));
    }

    let (sampling_reuse, sampling_timings) = {
        let mut sample_buffer = SampleBuffer::<V>::default();
        sample_buffer.sample(width, window, &quantile).unwrap();
        let allocations = allocation_counts(|| {
            black_box(sample_buffer.sample(width, window, &quantile).unwrap());
        });
        let mut timings = Vec::with_capacity(rounds);
        for _ in 0..rounds {
            let start = Instant::now();
            for _ in 0..5 {
                black_box(sample_buffer.sample(width, window, &quantile).unwrap());
            }
            timings.push(start.elapsed().as_secs_f64() * 1e6 / 5.0);
        }
        timings.sort_by(f64::total_cmp);
        (allocations, timings)
    };
    // Interleave paths and rotate their order between rounds to limit drift.
    let mut timings: [Vec<f64>; 3] = std::array::from_fn(|_| Vec::with_capacity(rounds));
    for round in 0..rounds {
        for slot in 0..3 {
            let index = (slot + round) % 3;
            let state = &mut states[index];
            let repetitions = if index == 2 { 1 } else { 5 };
            let start = Instant::now();
            for _ in 0..repetitions {
                black_box(ALGORITHMS[index].run(
                    black_box(samples),
                    black_box(source),
                    density,
                    &mut state.scratch,
                    &mut state.ticks,
                ));
                black_box(&state.ticks);
            }
            timings[index].push(start.elapsed().as_secs_f64() * 1e6 / f64::from(repetitions));
        }
    }
    let rows: Vec<Value> = ALGORITHMS
        .iter()
        .enumerate()
        .map(|(index, algorithm)| {
            timings[index].sort_by(f64::total_cmp);
            json!({
                "algorithm": algorithm.label(),
                "median_us": timings[index][rounds / 2],
                "min_us": timings[index][0],
                "max_us": timings[index][rounds - 1],
                "batch_us_per_frame": timings[index],
                "stats": stats_json(stats[index]),
                "reused_buffer_allocations": allocations[index],
                "fresh_buffer_allocations": fresh_allocations[index],
                "quantile_callbacks_in_timed_layout": 0,
            })
        })
        .collect();
    eprintln!(
        "{name} {}/{}: {}px, {} ticks, all paths agree",
        P::BITS,
        output_bits,
        width,
        states[0].ticks.len()
    );
    json!({
        "scenario": name, "probability_bits": P::BITS, "output_bits": output_bits,
        "width": width, "rounds": rounds, "identical_output": true,
        "sampling_callbacks": callback_count,
        "sampling_median_us": sampling_timings[rounds / 2],
        "sampling_batch_us_per_frame": sampling_timings,
        "sampling_reused_buffer_allocations": sampling_reuse,
        "analytic_density": density.is_some(), "algorithms": rows,
    })
}

fn logistic<P: Probability>(p: P) -> f64 {
    (p.raw() as f64).ln() - (p.complement_units() as f64).ln()
}

fn main() {
    // cargo test --all-targets runs harness=false benches too. Keep that run short;
    // cargo bench uses the optimized release profile and the measured defaults.
    let default_width = if cfg!(debug_assertions) { 32 } else { 1024 };
    let default_rounds = if cfg!(debug_assertions) { 1 } else { 5 };
    let width = std::env::var("QBAR_BENCH_WIDTH")
        .ok()
        .map(|value| value.parse().unwrap())
        .unwrap_or(default_width);
    let rounds = std::env::var("QBAR_BENCH_ROUNDS")
        .ok()
        .map(|value| value.parse().unwrap())
        .unwrap_or(default_rounds);
    assert!(width > 0 && rounds > 0);
    let source = DecimalTicks::new(DecimalChain::OneTwo);
    let mut results = vec![
        scenario(
            "uniform",
            width,
            rounds,
            ProbabilityWindow::<Frac32>::default(),
            &source,
            |p: Frac32| (100.0 * f64::from(p.raw()) / 4294967296.0 - 50.0) as f32,
            None,
            32,
        ),
        scenario(
            "uniform",
            width,
            rounds,
            ProbabilityWindow::<Frac64>::default(),
            &source,
            |p: Frac64| 100.0 * p.raw() as f64 / 18446744073709551616.0 - 50.0,
            None,
            64,
        ),
        scenario(
            "logistic",
            width,
            rounds,
            ProbabilityWindow::<Frac32>::default(),
            &source,
            |p: Frac32| logistic(p),
            None,
            64,
        ),
        scenario(
            "logistic",
            width,
            rounds,
            ProbabilityWindow::<Frac64>::default(),
            &source,
            |p: Frac64| logistic(p) as f32,
            None,
            32,
        ),
        scenario(
            "nonlinear-refinement",
            width,
            rounds,
            ProbabilityWindow::<Frac64>::default(),
            &source,
            |p: Frac64| {
                let scaled = p.raw() as f64 / 18446744073709551616.0 * 8.0;
                scaled.floor() + (scaled - scaled.floor()) * 0.002
            },
            None,
            64,
        ),
        scenario(
            "flat-regions",
            width,
            rounds,
            ProbabilityWindow::<Frac32>::default(),
            &source,
            |p: Frac32| (f64::from(p.raw()) / 4294967296.0 * 8.0).floor() as f32,
            None,
            32,
        ),
    ];
    let span = width as u64 * 3 + 1;
    let window = ProbabilityWindow::new(Frac64::new(u64::MAX - span), Frac64::MAX).unwrap();
    results.push(scenario(
        "narrow-u64-window",
        width,
        rounds,
        window,
        &source,
        |p: Frac64| (p.raw() - window.lo().raw()) as f64 * 0.0001 - 0.1,
        None,
        64,
    ));
    let density = |x: f64| {
        let t = (-x.abs()).exp();
        t / (1.0 + t).powi(2)
    };
    results.push(scenario(
        "analytic-density",
        width,
        rounds,
        ProbabilityWindow::<Frac64>::default(),
        &source,
        |p: Frac64| logistic(p),
        Some(&density),
        64,
    ));
    println!("{}", serde_json::to_string_pretty(&json!({
        "schema": 1, "crate_version": env!("CARGO_PKG_VERSION"),
        "target_os": std::env::consts::OS, "target_arch": std::env::consts::ARCH,
        "optimized": !cfg!(debug_assertions),
        "method": "cached identical samples; warm buffers; interleaved/rotated paths; median of batches; allocations counted separately; source construction excluded",
        "allocation_definition": "alloc/alloc_zeroed and realloc calls per frame; requested bytes include replacement sizes and are not peak/live memory",
        "results": results,
    })).unwrap());
}
