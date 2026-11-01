/** Closed-form and black-box distributions for the playground. */

/**
 * A parameter is itself chosen on a qbar slider. Its track is a quantile
 * that may depend on the other parameters' current values and on its anchor:
 * its own value when the last interaction on it ended.
 */
export interface Parameter {
  readonly name: string;
  readonly value: number;
  track(values: readonly number[], anchor: number): (p: number) => number;
}

export interface Distribution {
  readonly name: string;
  readonly note: string;
  readonly parameters: readonly Parameter[];
  quantile(p: number, values: readonly number[]): number;
  pdf(x: number, values: readonly number[]): number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

// Acklam's rational approximation, relative error below 1.2e-9.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
];

function polynomial(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((sum, coefficient) => sum * x + coefficient, 0);
}

export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (1 <= p) return Infinity;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return polynomial(C, q) / polynomial([...D, 1], q);
  }
  if (p <= 1 - 0.02425) {
    const q = p - 0.5;
    const r = q * q;
    return (polynomial(A, r) * q) / polynomial([...B, 1], r);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -polynomial(C, q) / polynomial([...D, 1], q);
}

export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

function logisticCdf(x: number, location: number, scale: number): number {
  return 1 / (1 + Math.exp(-(x - location) / scale));
}

function logisticPdf(x: number, location: number, scale: number): number {
  const t = Math.exp(-Math.abs(x - location) / scale);
  return t / (scale * (1 + t) ** 2);
}

/**
 * Inverts a CDF by bisection: the "only a black box" case. Fixed iterations
 * keep it monotone in p.
 */
function invert(cdf: (x: number) => number, p: number): number {
  if (p <= 0) return -Infinity;
  if (1 <= p) return Infinity;
  let lo = -1e6;
  let hi = 1e6;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A location on a normal track: anchor ± a few of `spread`. */
const around =
  (spread: (values: readonly number[]) => number) =>
  (values: readonly number[], anchor: number) =>
  (p: number) =>
    anchor + spread(values) * normalQuantile(p);

/** A scale on an uncapped exponential track with the given mean. */
const exponential =
  (mean: (values: readonly number[]) => number) =>
  (values: readonly number[]) =>
  (p: number) =>
    -mean(values) * Math.log1p(-p);

/**
 * A positive value that anchors itself walks multiplicatively: a log-normal
 * track around the anchor. An exponential track scaled by its own anchor
 * would collapse for good once dragged to zero.
 */
const multiplicative = (_: readonly number[], anchor: number) => (p: number) =>
  anchor * Math.exp(normalQuantile(p));

/** Rate 1 / |location|, or 1 near zero. */
const byMagnitude = (index: number) => (values: readonly number[]) =>
  Math.max(1, Math.abs(values[index]!));

export const DISTRIBUTIONS: readonly Distribution[] = [
  {
    name: "Normal",
    note: "Symmetric, light tails: fine ticks gather in the middle.",
    parameters: [
      { name: "mean", value: 50, track: around(([, sd]) => sd!) },
      { name: "sd", value: 10, track: exponential(byMagnitude(0)) },
    ],
    quantile: (p, [mean, sd]) => mean! + sd! * normalQuantile(p),
    pdf: (x, [mean, sd]) => normalPdf((x - mean!) / sd!) / sd!,
  },
  {
    name: "Log-normal",
    note: "Right-skewed, like an ETA: steps coarsen toward the tail.",
    parameters: [
      {
        name: "median",
        value: 20,
        track:
          ([, sigma], anchor) =>
          (p) =>
            anchor * Math.exp(sigma! * normalQuantile(p)),
      },
      { name: "sigma", value: 0.6, track: exponential(() => 0.5) },
    ],
    quantile: (p, [median, sigma]) =>
      median! * Math.exp(sigma! * normalQuantile(p)),
    pdf: (x, [median, sigma]) =>
      x <= 0 ? 0 : normalPdf(Math.log(x / median!) / sigma!) / (x * sigma!),
  },
  {
    name: "Logistic",
    note: "Closed-form quantile log(p / (1 − p)) with heavier tails than normal.",
    parameters: [
      { name: "location", value: 30, track: around(([, scale]) => scale!) },
      { name: "scale", value: 4, track: exponential(byMagnitude(0)) },
    ],
    quantile: (p, [location, scale]) =>
      location! + scale! * Math.log(p / (1 - p)),
    pdf: (x, [location, scale]) => logisticPdf(x, location!, scale!),
  },
  {
    name: "Exponential",
    note: "Waiting times: dense at zero, thinning forever.",
    parameters: [
      {
        name: "mean",
        value: 15,
        track: multiplicative,
      },
    ],
    quantile: (p, [mean]) => -mean! * Math.log1p(-p),
    pdf: (x, [mean]) => (x < 0 ? 0 : Math.exp(-x / mean!) / mean!),
  },
  {
    name: "Cauchy",
    note: "No mean at all: the outer pixels span huge value ranges.",
    parameters: [
      {
        name: "location",
        value: 20,
        track:
          ([, scale], anchor) =>
          (p) =>
            anchor + scale! * Math.tan(Math.PI * (p - 0.5)),
      },
      { name: "scale", value: 2, track: exponential(byMagnitude(0)) },
    ],
    quantile: (p, [location, scale]) =>
      p <= 0
        ? -Infinity
        : 1 <= p
          ? Infinity
          : location! + scale! * Math.tan(Math.PI * (p - 0.5)),
    pdf: (x, [location, scale]) =>
      1 / (Math.PI * scale! * (1 + ((x - location!) / scale!) ** 2)),
  },
  {
    name: "Pareto",
    note: "Power-law tail with a hard minimum.",
    parameters: [
      {
        name: "minimum",
        value: 5,
        track: multiplicative,
      },
      { name: "alpha", value: 1.5, track: exponential(() => 1.5) },
    ],
    quantile: (p, [minimum, alpha]) => minimum! * (1 - p) ** (-1 / alpha!),
    pdf: (x, [minimum, alpha]) =>
      x < minimum! ? 0 : (alpha! * minimum! ** alpha!) / x ** (alpha! + 1),
  },
  {
    name: "Bimodal",
    note: "A mixture with no closed-form quantile, inverted from its CDF by bisection.",
    parameters: [
      { name: "left", value: 10, track: around(([, , spread]) => 4 * spread!) },
      {
        name: "right",
        value: 45,
        track: around(([, , spread]) => 4 * spread!),
      },
      {
        name: "spread",
        value: 3,
        track: exponential(([left, right]) =>
          Math.max(0.5, Math.abs(right! - left!) / 4),
        ),
      },
      {
        // Logit-normal: bounded by (0, 1) yet uncapped in log-odds.
        name: "weight",
        value: 0.5,
        track: (_, anchor) => (p) =>
          1 /
          (1 +
            Math.exp(-(Math.log(anchor / (1 - anchor)) + normalQuantile(p)))),
      },
    ],
    quantile: (p, [left, right, spread, weight]) =>
      invert(
        (x) =>
          weight! * logisticCdf(x, left!, spread!) +
          (1 - weight!) * logisticCdf(x, right!, spread!),
        p,
      ),
    pdf: (x, [left, right, spread, weight]) =>
      weight! * logisticPdf(x, left!, spread!) +
      (1 - weight!) * logisticPdf(x, right!, spread!),
  },
  {
    name: "Uniform",
    note: "A linear quantile: one step size across the whole bar.",
    parameters: [
      { name: "low", value: 0, track: around(([, width]) => width!) },
      {
        name: "width",
        value: 40,
        track: exponential((values) => Math.max(10, Math.abs(values[0]!))),
      },
    ],
    quantile: (p, [low, width]) => low! + p * width!,
    pdf: (x, [low, width]) =>
      low! <= x && x <= low! + width! ? 1 / width! : 0,
  },
];
