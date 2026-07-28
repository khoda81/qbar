import type { MutableTickSelection, TickSource } from "../types.js";

export interface DecimalTickOptions {
  /**
   * Spacing mantissas within each decade.
   *
   * [1] produces powers of ten.
   * [5] produces five times powers of ten.
   * [1, 2, 5] produces the conventional 1-2-5 hierarchy.
   */
  multipliers?: readonly number[];
  /** Shared origin of all ticks. Defaults to zero. */
  origin?: number;
  minExponent?: number;
  maxExponent?: number;
}

function normalizeMultipliers(input: readonly number[]): number[] {
  if (input.length === 0) {
    throw new RangeError("decimal tick multipliers must not be empty");
  }

  const normalized = [...new Set(input)].sort((a, b) => b - a);

  for (const multiplier of normalized) {
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier >= 10) {
      throw new RangeError(
        `decimal tick multipliers must be finite and within (0, 10); received ${multiplier}`,
      );
    }
  }

  return normalized;
}

/**
 * A decimal hierarchy whose tick spacings are m × 10^k.
 */
export class DecimalTickSource implements TickSource {
  readonly multipliers: readonly number[];
  readonly origin: number;
  readonly minExponent: number;
  readonly maxExponent: number;

  constructor(options: DecimalTickOptions = {}) {
    this.multipliers = normalizeMultipliers(options.multipliers ?? [1, 2, 5]);
    this.origin = options.origin ?? 0;
    this.minExponent = options.minExponent ?? -323;
    this.maxExponent = options.maxExponent ?? 308;

    if (!Number.isFinite(this.origin)) {
      throw new RangeError("decimal tick origin must be finite");
    }
    if (
      !Number.isInteger(this.minExponent) ||
      !Number.isInteger(this.maxExponent) ||
      this.minExponent > this.maxExponent
    ) {
      throw new RangeError("decimal exponent bounds must be ordered integers");
    }
  }

  select(lower: number, upper: number, out: MutableTickSelection): boolean {
    if (
      !Number.isFinite(lower) ||
      !Number.isFinite(upper) ||
      upper < lower ||
      lower === upper
    ) {
      return false;
    }

    // The origin belongs to every level in the hierarchy, so it is the
    // maximally stable anchor rather than an arbitrary finite family member.
    if (lower < this.origin && this.origin <= upper) {
      out.value = this.origin;
      out.spacing = Infinity;
      out.level = Infinity;
      return true;
    }

    const relativeLower = lower - this.origin;
    const relativeUpper = upper - this.origin;
    const magnitude = Math.max(
      Math.abs(relativeLower),
      Math.abs(relativeUpper),
    );

    if (!Number.isFinite(magnitude) || magnitude === 0) {
      return false;
    }

    const estimatedExponent = Math.floor(Math.log10(magnitude)) + 1;
    const startExponent = Math.min(this.maxExponent, estimatedExponent);

    for (
      let exponent = startExponent;
      exponent >= this.minExponent;
      exponent -= 1
    ) {
      const power = 10 ** exponent;
      if (power === 0) break;

      for (
        let multiplierIndex = 0;
        multiplierIndex < this.multipliers.length;
        multiplierIndex += 1
      ) {
        const multiplier = this.multipliers[multiplierIndex]!;
        const spacing = multiplier * power;

        if (!Number.isFinite(spacing) || spacing === 0) {
          continue;
        }

        const tickIndex = Math.floor(relativeUpper / spacing);
        const value = this.origin + tickIndex * spacing;
        const tolerance =
          Number.EPSILON *
          8 *
          Math.max(1, Math.abs(lower), Math.abs(upper), Math.abs(value));

        if (value > lower + tolerance && value <= upper + tolerance) {
          out.value = value;
          out.spacing = spacing;
          out.level = exponent * this.multipliers.length + multiplierIndex;
          return true;
        }
      }
    }

    return false;
  }
}

export function decimalTicks(options: DecimalTickOptions = {}): TickSource {
  return new DecimalTickSource(options);
}

export function powerOfTenTicks(
  options: Omit<DecimalTickOptions, "multipliers"> = {},
): TickSource {
  return new DecimalTickSource({ ...options, multipliers: [1] });
}

export function fiveTimesPowerOfTenTicks(
  options: Omit<DecimalTickOptions, "multipliers"> = {},
): TickSource {
  return new DecimalTickSource({ ...options, multipliers: [5] });
}
