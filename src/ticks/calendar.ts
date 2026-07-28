import type { MutableTickSelection, TickSource } from "../types.js";

export type CalendarUnit =
  "year" | "month" | "week" | "day" | "hour" | "minute" | "second";

export interface CalendarTickLevel {
  unit: CalendarUnit;
  step?: number;
}

export interface CalendarTickOptions {
  /**
   * Calendar levels to consider. They are normalized from coarsest to finest.
   * Values are Unix timestamps in milliseconds and boundaries use UTC.
   */
  levels?: readonly CalendarTickLevel[];
}

interface NormalizedLevel {
  unit: CalendarUnit;
  step: number;
  approximateMilliseconds: number;
  code: number;
}

const MILLISECONDS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_746_000,
  year: 31_556_952_000,
} as const;

const UNIT_CODE: Record<CalendarUnit, number> = {
  second: 0,
  minute: 1,
  hour: 2,
  day: 3,
  week: 4,
  month: 5,
  year: 6,
};

const DEFAULT_LEVELS: readonly CalendarTickLevel[] = [
  { unit: "year" },
  { unit: "month" },
  { unit: "week" },
  { unit: "day" },
  { unit: "hour" },
  { unit: "minute" },
];

function floorDivision(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function utcDate(year: number, month = 0, day = 1): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function floorCalendarBoundary(
  timestamp: number,
  level: NormalizedLevel,
): number {
  const { unit, step } = level;

  if (unit === "month" || unit === "year") {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return Number.NaN;

    const year = date.getUTCFullYear();

    if (unit === "year") {
      return utcDate(floorDivision(year, step) * step).getTime();
    }

    const absoluteMonth = year * 12 + date.getUTCMonth();
    const flooredMonth = floorDivision(absoluteMonth, step) * step;
    const boundaryYear = floorDivision(flooredMonth, 12);
    const boundaryMonth = flooredMonth - boundaryYear * 12;
    return utcDate(boundaryYear, boundaryMonth).getTime();
  }

  const quantum = MILLISECONDS[unit] * step;

  if (unit === "week") {
    // 1970-01-05 was a Monday, making weeks ISO-like and UTC-stable.
    const mondayEpoch = 4 * MILLISECONDS.day;
    return (
      mondayEpoch + floorDivision(timestamp - mondayEpoch, quantum) * quantum
    );
  }

  return floorDivision(timestamp, quantum) * quantum;
}

function nextCalendarBoundary(
  boundary: number,
  level: NormalizedLevel,
): number {
  const { unit, step } = level;

  if (unit === "month" || unit === "year") {
    const date = new Date(boundary);
    if (Number.isNaN(date.getTime())) return Number.NaN;

    if (unit === "year") {
      return utcDate(date.getUTCFullYear() + step).getTime();
    }

    return utcDate(date.getUTCFullYear(), date.getUTCMonth() + step).getTime();
  }

  return boundary + MILLISECONDS[unit] * step;
}

function normalizeLevels(
  input: readonly CalendarTickLevel[],
): NormalizedLevel[] {
  if (input.length === 0) {
    throw new RangeError("calendar tick levels must not be empty");
  }

  const levels = input.map(({ unit, step = 1 }) => {
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw new RangeError(
        `calendar tick step must be a positive safe integer; received ${step}`,
      );
    }

    return {
      unit,
      step,
      approximateMilliseconds: MILLISECONDS[unit] * step,
      code: UNIT_CODE[unit] * 1_000_000 + step,
    };
  });

  levels.sort(
    (left, right) =>
      right.approximateMilliseconds - left.approximateMilliseconds,
  );

  return levels;
}

/**
 * A UTC calendar hierarchy with variable month and year spacing.
 */
export class CalendarTickSource implements TickSource {
  readonly levels: readonly NormalizedLevel[];

  constructor(options: CalendarTickOptions = {}) {
    this.levels = normalizeLevels(options.levels ?? DEFAULT_LEVELS);
  }

  select(lower: number, upper: number, out: MutableTickSelection): boolean {
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
      return false;
    }

    for (const level of this.levels) {
      const boundary = floorCalendarBoundary(upper, level);

      if (!Number.isFinite(boundary) || boundary <= lower || boundary > upper) {
        continue;
      }

      const next = nextCalendarBoundary(boundary, level);
      const spacing = next - boundary;

      if (!Number.isFinite(spacing) || spacing <= 0) {
        continue;
      }

      out.value = boundary;
      out.spacing = spacing;
      out.level = level.code;
      return true;
    }

    return false;
  }
}

export function calendarTicks(options: CalendarTickOptions = {}): TickSource {
  return new CalendarTickSource(options);
}
