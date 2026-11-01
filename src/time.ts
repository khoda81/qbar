import type { Selection, TickScale } from "./scale.js";

export type CalendarUnit =
  "year" | "month" | "day" | "hour" | "minute" | "second" | "millisecond";

/**
 * Ticks where the unit's calendar field is a multiple of count, counting days
 * of the month from the 1st: days with count 7 are the 1st, 8th, 15th, 22nd
 * and 29th.
 */
export interface CalendarStep {
  readonly unit: CalendarUnit;
  readonly count: number;
}

export interface TimeOptions {
  /** Calendar fields in the runtime's local time zone or in UTC. Defaults to local. */
  readonly zone?: "local" | "utc";
  /** Omit steps whose nominal length is shorter than this many milliseconds. */
  readonly minStep?: number;
}

// Field order matches the Date constructor's arguments.
const FIELD: Record<CalendarUnit, number> = {
  year: 0,
  month: 1,
  day: 2,
  hour: 3,
  minute: 4,
  second: 5,
  millisecond: 6,
};

const NOMINAL: Record<CalendarUnit, number> = {
  year: 31_556_952_000,
  month: 2_629_746_000,
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
  millisecond: 1,
};

// Nested: January 1st is a month tick, each 1st a 7-day tick, midnight a
// 12-hour tick, and every count divides the coarser count of its unit.
const CHAIN: readonly CalendarStep[] = (
  [
    ["year", [1_000, 500, 100, 50, 10, 5, 1]],
    ["month", [6, 3, 1]],
    ["day", [7, 1]],
    ["hour", [12, 6, 3, 1]],
    ["minute", [30, 15, 5, 1]],
    ["second", [30, 15, 5, 1]],
    ["millisecond", [500, 100, 50, 10, 5, 1]],
  ] as const
).flatMap(([unit, counts]) => counts.map((count) => ({ unit, count })));

/** Days of the month count from 1, every other field from 0. */
const firstOf = (field: number): number => (field === FIELD.day ? 1 : 0);

type Fields = [number, number, number, number, number, number, number];

interface Calendar {
  fields(time: number): Fields;
  time(fields: Fields): number;
}

const local: Calendar = {
  fields(time) {
    const date = new Date(time);
    return [
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds(),
    ];
  },
  time([year, month, day, hour, minute, second, millisecond]) {
    // setFullYear, unlike the constructor, keeps years 0–99 literal.
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(hour, minute, second, millisecond);
    return date.getTime();
  },
};

const utc: Calendar = {
  fields(time) {
    const date = new Date(time);
    return [
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ];
  },
  time([year, month, day, hour, minute, second, millisecond]) {
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, second, millisecond);
    return date.getTime();
  },
};

/** Ticks for Unix timestamps in milliseconds, on calendar boundaries. */
export function timeTicks(options: TimeOptions = {}): TickScale<CalendarStep> {
  const zone = options.zone ?? "local";
  const calendar = zone === "utc" ? utc : local;
  const minStep = options.minStep ?? 0;
  const chain = CHAIN.filter(
    ({ unit, count }) => minStep <= count * NOMINAL[unit],
  );
  if (chain.length === 0) throw new RangeError("minStep excludes every step");

  const floor = (time: number, step: CalendarStep): number => {
    const fields = calendar.fields(time);
    const field = FIELD[step.unit];
    const base = firstOf(field);
    fields[field] =
      Math.floor((fields[field]! - base) / step.count) * step.count + base;
    for (let finer = field + 1; finer < fields.length; finer += 1) {
      fields[finer] = firstOf(finer);
    }
    return calendar.time(fields);
  };

  // Overflowing the field lets Date roll into the next month or year; flooring
  // again sends the 29th + 7 days to the next 1st.
  const next = (tick: number, step: CalendarStep): number => {
    const fields = calendar.fields(tick);
    const field = FIELD[step.unit];
    fields[field] = fields[field]! + step.count;
    return floor(calendar.time(fields), step);
  };

  const format = calendarFormat(zone);

  return {
    select(lower, upper): Selection<CalendarStep> | undefined {
      // Nesting makes containment monotone along the chain.
      let lo = 0;
      let hi = chain.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lower < floor(upper, chain[mid]!)) hi = mid;
        else lo = mid + 1;
      }
      if (lo === chain.length) return undefined;

      const step = chain[lo]!;
      const value = floor(upper, step);
      return { value, step, size: next(value, step) - value };
    },
    format,
  };
}

function calendarFormat(
  zone: "local" | "utc",
): (value: number, step: CalendarStep) => string {
  const timeZone = zone === "utc" ? { timeZone: "UTC" } : {};
  const formatter = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { ...options, ...timeZone });

  // A tick is never on a coarser step's boundary: January 1st is a year tick,
  // so month ticks need no year, and midnight is a day tick.
  const formatters: Record<CalendarUnit, Intl.DateTimeFormat> = {
    year: formatter({ year: "numeric" }),
    month: formatter({ month: "short" }),
    day: formatter({ month: "short", day: "numeric" }),
    hour: formatter({ hour: "2-digit", minute: "2-digit" }),
    minute: formatter({ hour: "2-digit", minute: "2-digit" }),
    second: formatter({
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    millisecond: formatter({
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    }),
  };

  return (value, step) => formatters[step.unit].format(value);
}
