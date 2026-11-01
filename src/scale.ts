/**
 * A spectrum of tick steps, from coarse to fine, in which every tick of a
 * coarser step is also a tick of each finer step.
 *
 * Nesting is what lets a layout keep only the coarsest tick of each
 * `minSpacing` bucket: any finer tick sharing that bucket has the coarser tick
 * as a same-step neighbour less than `minSpacing` pixels away, so it would be
 * hidden anyway.
 */
export interface TickScale<Step> {
  /**
   * The coarsest tick in the half-open interval (lower, upper], given finite
   * lower < upper, or undefined when the interval contains none.
   */
  select(lower: number, upper: number): Selection<Step> | undefined;
  format(value: number, step: Step): string;
}

export interface Selection<Step> {
  readonly value: number;
  readonly step: Step;
  /** Value distance to the next tick of the same step. */
  readonly size: number;
}

/**
 * One step of a ladder: ticks at every integer multiple of
 * numerator / denominator, both integers. Keeping the step rational lets
 * decimal fractions stay exact: 3 / 10 is 0.3, whereas 3 × 0.1 is
 * 0.30000000000000004.
 */
export interface Rung<Step> {
  readonly step: Step;
  readonly numerator: number;
  readonly denominator?: number;
}

interface ResolvedRung<Step> {
  readonly step: Step;
  readonly numerator: number;
  readonly denominator: number;
  readonly size: number;
}

/**
 * A scale of uniform lattices anchored at zero. Rungs run from coarse to fine
 * and each coarser size must be an integer multiple of the next finer one.
 */
export function ladder<Step>(
  rungs: readonly Rung<Step>[],
  format: (value: number, step: Step) => string,
): TickScale<Step> {
  if (rungs.length === 0) throw new RangeError("a ladder needs a rung");

  const resolved = rungs.map(({ step, numerator, denominator = 1 }) => {
    if (
      !(Number.isInteger(numerator) && 0 < numerator) ||
      !(Number.isInteger(denominator) && 0 < denominator)
    ) {
      throw new RangeError(
        `ladder rung must be a positive integer ratio; got ${numerator}/${denominator}`,
      );
    }
    // Lowest terms keep index × numerator exact: 0.5 as 1/2 rather than 5/10.
    const divisor = gcd(numerator, denominator);
    return {
      step,
      numerator: numerator / divisor,
      denominator: denominator / divisor,
      size: numerator / denominator,
    };
  });

  for (let index = 1; index < resolved.length; index += 1) {
    const ratio = resolved[index - 1]!.size / resolved[index]!.size;
    const multiple = Math.round(ratio);
    if (multiple < 2 || 1e-9 < Math.abs(ratio - multiple) / multiple) {
      throw new RangeError(
        `ladder rung ${index - 1} must be an integer multiple (at least 2) of rung ${index}; got ratio ${ratio}`,
      );
    }
  }

  return {
    select(lower, upper) {
      // Nesting makes "has a tick in (lower, upper]" monotone along the
      // ladder. Rungs no larger than the interval always qualify, so they are
      // never probed: that also keeps upper / size far from overflow.
      const width = upper - lower;
      let lo = 0;
      let hi = resolved.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const rung = resolved[mid]!;
        if (rung.size <= width || latest(rung, lower, upper) !== undefined) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      if (lo === resolved.length) return undefined;

      const rung = resolved[lo]!;
      // Undefined only when float rounding defeats a rung no larger than the
      // interval, which needs an interval at the edge of binary64 precision.
      const value = latest(rung, lower, upper);
      return value === undefined
        ? undefined
        : { value, step: rung.step, size: rung.size };
    },
    format,
  };
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/** The largest multiple of the rung in (lower, upper]. */
function latest<Step>(
  rung: ResolvedRung<Step>,
  lower: number,
  upper: number,
): number | undefined {
  const at = (index: number) => (index * rung.numerator) / rung.denominator;
  // The quotient can round across an integer either way: 0.58 × 50 is
  // 28.999999999999996, yet 29 / 50 is the float 0.58.
  let index = Math.floor((upper * rung.denominator) / rung.numerator);
  if (at(index + 1) <= upper) index += 1;
  else if (upper < at(index)) index -= 1;
  const value = at(index);
  // Adding zero turns the -0 that upper = -0 produces into 0.
  return lower < value ? value + 0 : undefined;
}
