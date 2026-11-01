import { ladder, type Rung, type TickScale } from "./scale.js";

/** Ticks at multiples of multiplier × 10^exponent. */
export interface DecimalStep {
  readonly multiplier: 1 | 2 | 5;
  readonly exponent: number;
}

/**
 * The decimal chains whose steps nest across decades. 1-2-5 is not one of
 * them: multiples of 5 are not multiples of 2.
 */
export type DecimalChain = readonly [1] | readonly [1, 2] | readonly [1, 5];

export interface DecimalOptions {
  /** Defaults to [1, 5]. */
  readonly multipliers?: DecimalChain;
  /** Omit steps smaller than this, e.g. 1 for whole numbers. */
  readonly minStep?: number;
}

// Both 10^300 and 10^-300 are finite, so every rung's numerator and
// denominator are too. Zero, being on every rung, gets the coarsest.
const MAX_EXPONENT = 300;

export function decimalTicks(
  options: DecimalOptions = {},
): TickScale<DecimalStep> {
  const multipliers = [...(options.multipliers ?? [1, 5])].reverse();
  const minStep = options.minStep ?? 0;
  const rungs: Rung<DecimalStep>[] = [];

  for (let exponent = MAX_EXPONENT; -MAX_EXPONENT <= exponent; exponent -= 1) {
    for (const multiplier of multipliers) {
      const rung =
        0 <= exponent
          ? { numerator: multiplier * 10 ** exponent }
          : { numerator: multiplier, denominator: 10 ** -exponent };
      if (minStep <= multiplier * 10 ** exponent) {
        rungs.push({ step: { multiplier, exponent }, ...rung });
      }
    }
  }

  return ladder(rungs, formatDecimal);
}

const formatters = new Map<number, Intl.NumberFormat>();

/** Shows exactly the digits the step resolves. */
export function formatDecimal(value: number, step: DecimalStep): string {
  const digits = Math.max(0, -step.exponent);
  // Intl caps fraction digits at 100; such fine steps read better anyway as
  // scientific notation.
  if (20 < digits) return value.toExponential();

  let formatter = formatters.get(digits);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(digits, formatter);
  }
  return formatter.format(value);
}
