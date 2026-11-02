import { ladder, type TickScale } from "./scale.js";

export type DurationUnit =
  | "day"
  | "hour"
  | "minute"
  | "second"
  | "millisecond"
  | "microsecond"
  | "nanosecond"
  | "picosecond"
  | "femtosecond"
  | "attosecond";

/** Ticks at multiples of count units, in milliseconds from zero. */
export interface DurationStep {
  readonly unit: DurationUnit;
  readonly count: number;
}

export interface DurationOptions {
  /** Omit steps shorter than this many milliseconds. */
  readonly minStep?: number;
}

interface Unit {
  readonly symbol: string;
  /** The unit is numerator / denominator milliseconds, both exact integers. */
  readonly numerator: number;
  readonly denominator: number;
}

// Largest first. Sub-millisecond units are exact fractions rather than floats
// such as 1e-6, which are not.
const UNITS: Record<DurationUnit, Unit> = {
  day: { symbol: "d", numerator: 86_400_000, denominator: 1 },
  hour: { symbol: "h", numerator: 3_600_000, denominator: 1 },
  minute: { symbol: "m", numerator: 60_000, denominator: 1 },
  second: { symbol: "s", numerator: 1_000, denominator: 1 },
  millisecond: { symbol: "ms", numerator: 1, denominator: 1 },
  microsecond: { symbol: "µs", numerator: 1, denominator: 1e3 },
  nanosecond: { symbol: "ns", numerator: 1, denominator: 1e6 },
  picosecond: { symbol: "ps", numerator: 1, denominator: 1e9 },
  femtosecond: { symbol: "fs", numerator: 1, denominator: 1e12 },
  attosecond: { symbol: "as", numerator: 1, denominator: 1e15 },
};

const SUBSECOND = [500, 100, 50, 10, 5, 1];

// Each count divides the one before it, also across units: 24 h is a
// multiple of 12 h, 1 h of 30 min, and so on.
const CHAIN: readonly DurationStep[] = (
  [
    ["day", [10_000, 5_000, 1_000, 500, 100, 50, 10, 5, 1]],
    ["hour", [12, 6, 3, 1]],
    ["minute", [30, 15, 5, 1]],
    ["second", [30, 15, 5, 1]],
    ["millisecond", SUBSECOND],
    ["microsecond", SUBSECOND],
    ["nanosecond", SUBSECOND],
    ["picosecond", SUBSECOND],
    ["femtosecond", SUBSECOND],
    ["attosecond", SUBSECOND],
  ] as const
).flatMap(([unit, counts]) => counts.map((count) => ({ unit, count })));

/** Ticks for elapsed time in milliseconds. */
export function durationTicks(
  options: DurationOptions = {},
): TickScale<DurationStep> {
  const minStep = options.minStep ?? 0;
  return ladder(
    CHAIN.map((step) => {
      const { numerator, denominator } = UNITS[step.unit];
      return { step, numerator: step.count * numerator, denominator };
    }).filter(
      ({ numerator, denominator }) => minStep <= numerator / denominator,
    ),
    formatDuration,
  );
}

/** Components from the largest nonzero unit down to the step's unit: "1h 30m". */
export function formatDuration(value: number, step: DurationStep): string {
  if (value === 0) return "0";

  // Counting in the step's unit keeps the arithmetic on integers: dividing
  // 3 ns, the float 3e-6, by a float nanosecond need not give exactly 3.
  const finest = UNITS[step.unit];
  let rest = Math.round(
    (Math.abs(value) * finest.denominator) / finest.numerator,
  );
  const parts: string[] = [];
  for (const [unit, { symbol, numerator, denominator }] of Object.entries(
    UNITS,
  )) {
    const size =
      (numerator * finest.denominator) / (denominator * finest.numerator);
    const amount = Math.floor(rest / size);
    rest -= amount * size;
    if (amount !== 0) parts.push(`${amount}${symbol}`);
    if (unit === step.unit) break;
  }
  return (value < 0 ? "-" : "") + parts.join(" ");
}
