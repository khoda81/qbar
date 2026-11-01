import type { TickScale } from "./scale.js";

/**
 * Maps a probability in [0, 1] to a value. It must be nondecreasing and never
 * NaN; ±Infinity is allowed, typically at 0 and 1 for unbounded support.
 */
export type Quantile = (probability: number) => number;

export interface LayoutOptions<Step> {
  readonly quantile: Quantile;
  readonly scale: TickScale<Step>;
  /** Bar length in whole pixels. Probability p sits at p × width. */
  readonly width: number;
  /**
   * Ticks whose same-step neighbours are closer than this many pixels are
   * omitted. It is also the bucket width, so at most one tick per
   * floor(minSpacing) pixels survives. Defaults to 24.
   */
  readonly minSpacing?: number;
  /**
   * Probability density at Q(p), per value unit. When omitted, the density at
   * a tick is estimated from its pixel, 1 / (width × (Q((i+1)/width) - Q(i/width))).
   */
  readonly density?: (probability: number) => number;
}

export interface Tick<Step> {
  readonly value: number;
  readonly step: Step;
  /** Pixels from the p = 0 end of the bar. */
  readonly position: number;
  /**
   * Pixel distance to the adjacent ticks of the same step, at the local
   * density: how much room the tick has. At least minSpacing.
   */
  readonly spacing: number;
}

/**
 * Places the coarsest tick of each floor(minSpacing)-pixel bucket and keeps it
 * if its local spacing is at least minSpacing.
 *
 * Pixel i owns the values (Q(i/W), Q((i+1)/W)], except the first, which is
 * closed: the pixels partition [Q(0), Q(1)], so both ends of a bounded bar
 * can be ticks.
 *
 * The quantile is evaluated at the width / minSpacing + 1 bucket edges, then
 * bisected down to the pixel holding each bucket's candidate, at most
 * log2(minSpacing) more calls per bucket. Assuming Q is close to linear
 * across a bucket, no visible tick is lost: a finer tick sharing a bucket
 * with a coarser one has it as a same-step neighbour (scales nest) less than
 * minSpacing pixels away.
 */
export function layoutTicks<Step>(options: LayoutOptions<Step>): Tick<Step>[] {
  const { quantile, scale, width, density, minSpacing = 24 } = options;
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new RangeError(`width must be a positive integer; got ${width}`);
  }
  if (!(1 <= minSpacing && minSpacing < Infinity)) {
    throw new RangeError(`minSpacing must be at least 1; got ${minSpacing}`);
  }

  const sample = sampler(quantile, width);
  const first = sample(0);

  /** The tick of the bucket between boundaries start and end, if visible. */
  const place = (
    start: number,
    startValue: number,
    end: number,
    endValue: number,
  ): Tick<Step> | undefined => {
    const [lo, loValue, hi, hiValue] = finitePart(
      sample,
      start,
      startValue,
      end,
      endValue,
    );
    if (!(loValue < hiValue)) return undefined;

    // Buckets starting at the value Q(0), at boundary 0 or on a plateau
    // from it, are closed below. Scales take (lower, upper], and the floats
    // in (nextDown(a), b] are exactly those in [a, b].
    const atStart = loValue === first;
    const lower = atStart ? nextDown(loValue) : loValue;
    const selection = scale.select(lower, hiValue);
    if (selection === undefined) return undefined;
    const { value, step, size } = selection;
    if (!(lower < value && value <= hiValue)) {
      throw new RangeError(
        `scale selected ${value} outside (${lower}, ${hiValue}]`,
      );
    }
    // Two ticks of the coarsest step in one bucket are closer than
    // minSpacing to each other: crowded, without locating either.
    if (lower < value - size) return undefined;

    // A tick at Q(0) sits at 0, where its plateau starts, and takes its
    // density from the first pixel rising above it.
    const onStart = value === first;
    const [pixel, from, , to] = bisect(
      sample,
      lo,
      loValue,
      hi,
      hiValue,
      onStart ? (sampled) => value < sampled : (sampled) => value <= sampled,
    );
    const position = onStart ? 0 : pixel + (value - from) / (to - from);
    const spacing =
      density === undefined
        ? size / (to - from)
        : size * width * checkDensity(density(position / width));
    return minSpacing <= spacing
      ? { value, step, position, spacing }
      : undefined;
  };

  const bucket = Math.floor(minSpacing);
  const ticks: Tick<Step>[] = [];
  let start = 0;
  let startValue = first;
  while (start < width) {
    const end = Math.min(start + bucket, width);
    const endValue = sample(end);
    if (endValue < startValue) throw nondecreasing(end);

    const tick = place(start, startValue, end, endValue);
    if (tick !== undefined) ticks.push(tick);
    start = end;
    startValue = endValue;
  }

  return ticks;
}

/**
 * The pixel position of a value on the bar, or undefined outside
 * [Q(0), Q(1)]. On a plateau it is the plateau's start. A value in a pixel
 * with an infinite boundary maps to that pixel's finite edge.
 */
export function locate(
  quantile: Quantile,
  width: number,
  value: number,
): number | undefined {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new RangeError(`width must be a positive integer; got ${width}`);
  }
  if (!Number.isFinite(value)) {
    throw new RangeError(`value must be finite; got ${value}`);
  }

  const sample = sampler(quantile, width);
  const first = sample(0);
  const last = sample(width);
  if (value < first || last < value) return undefined;
  if (value === first) return 0;

  const [pixel, lower, , upper] = bisect(
    sample,
    0,
    first,
    width,
    last,
    (sampled) => value <= sampled,
  );
  if (lower === -Infinity) return pixel + 1;
  if (upper === Infinity) return pixel;
  return pixel + (value - lower) / (upper - lower);
}

type Sample = (boundary: number) => number;

function sampler(quantile: Quantile, width: number): Sample {
  return (boundary) => {
    const value = quantile(boundary / width);
    if (Number.isNaN(value)) {
      throw new RangeError(`quantile returned NaN at p = ${boundary / width}`);
    }
    return value;
  };
}

/**
 * Bisects boundaries lo < hi, where !test(Q(lo)) and test(Q(hi)), down to
 * adjacent boundaries [i, Q(i), i + 1, Q(i + 1)] with the same property.
 */
function bisect(
  sample: Sample,
  lo: number,
  loValue: number,
  hi: number,
  hiValue: number,
  test: (value: number) => boolean,
): [number, number, number, number] {
  while (1 < hi - lo) {
    const mid = (lo + hi) >>> 1;
    const value = sample(mid);
    if (value < loValue || hiValue < value) throw nondecreasing(mid);
    if (test(value)) {
      hi = mid;
      hiValue = value;
    } else {
      lo = mid;
      loValue = value;
    }
  }
  return [lo, loValue, hi, hiValue];
}

/**
 * Narrows a bucket to boundaries with finite quantiles. Pixels touching an
 * infinite boundary have no finite extent and hold no tick.
 */
function finitePart(
  sample: Sample,
  lo: number,
  loValue: number,
  hi: number,
  hiValue: number,
): [number, number, number, number] {
  if (loValue === -Infinity && -Infinity < hiValue) {
    [, , lo, loValue] = bisect(
      sample,
      lo,
      loValue,
      hi,
      hiValue,
      (value) => -Infinity < value,
    );
  }
  if (hiValue === Infinity && loValue < Infinity) {
    [hi, hiValue] = bisect(
      sample,
      lo,
      loValue,
      hi,
      hiValue,
      (value) => value === Infinity,
    );
  }
  return [lo, loValue, hi, hiValue];
}

/** The largest float below x. */
function nextDown(x: number): number {
  if (x === 0) return -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigInt64(0, view.getBigInt64(0) + (0 < x ? -1n : 1n));
  return view.getFloat64(0);
}

function checkDensity(value: number): number {
  if (!(0 <= value)) {
    throw new RangeError(`density must be nonnegative; got ${value}`);
  }
  return value;
}

function nondecreasing(boundary: number): RangeError {
  return new RangeError(
    `quantile must be nondecreasing; it falls at pixel boundary ${boundary}`,
  );
}
