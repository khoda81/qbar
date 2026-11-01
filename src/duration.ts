import { ladder, type TickScale } from "./scale.js";

export type DurationUnit = "day" | "hour" | "minute" | "second" | "millisecond";

/** Ticks at multiples of count units, in milliseconds from zero. */
export interface DurationStep {
  readonly unit: DurationUnit;
  readonly count: number;
}

export interface DurationOptions {
  /** Omit steps shorter than this many milliseconds. */
  readonly minStep?: number;
}

const MILLISECONDS: Record<DurationUnit, number> = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
  millisecond: 1,
};

// Each count divides the one before it, also across units: 24 h is a
// multiple of 12 h, 1 h of 30 min, and so on.
const CHAIN: readonly DurationStep[] = [
  ...[10_000, 5_000, 1_000, 500, 100, 50, 10, 5, 1].map((count) => ({
    unit: "day" as const,
    count,
  })),
  ...[12, 6, 3, 1].map((count) => ({ unit: "hour" as const, count })),
  ...[30, 15, 5, 1].map((count) => ({ unit: "minute" as const, count })),
  ...[30, 15, 5, 1].map((count) => ({ unit: "second" as const, count })),
  ...[500, 100, 50, 10, 5, 1].map((count) => ({
    unit: "millisecond" as const,
    count,
  })),
];

/** Ticks for elapsed time in milliseconds. */
export function durationTicks(
  options: DurationOptions = {},
): TickScale<DurationStep> {
  const minStep = options.minStep ?? 0;
  return ladder(
    CHAIN.map((step) => ({
      step,
      numerator: step.count * MILLISECONDS[step.unit],
    })).filter(({ numerator }) => minStep <= numerator),
    formatDuration,
  );
}

const UNITS: readonly [DurationUnit, string][] = [
  ["day", "d"],
  ["hour", "h"],
  ["minute", "m"],
  ["second", "s"],
  ["millisecond", "ms"],
];

/** Components from the largest nonzero unit down to the step's unit: "1h 30m". */
export function formatDuration(value: number, step: DurationStep): string {
  if (value === 0) return "0";

  let rest = Math.abs(value);
  const parts: string[] = [];
  for (const [unit, symbol] of UNITS) {
    const amount = Math.floor(rest / MILLISECONDS[unit]);
    rest -= amount * MILLISECONDS[unit];
    if (amount !== 0) parts.push(`${amount}${symbol}`);
    if (unit === step.unit) break;
  }
  return (value < 0 ? "-" : "") + parts.join(" ");
}
