import { describe, expect, test } from "bun:test";
import {
  decimalTicks,
  durationTicks,
  ladder,
  timeTicks,
} from "../src/index.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

describe("ladder", () => {
  test("selects the coarsest rung with a tick in (lower, upper]", () => {
    const scale = ladder(
      [
        { step: "ten", numerator: 10 },
        { step: "one", numerator: 1 },
      ],
      String,
    );
    expect(scale.select(9, 10)).toEqual({ value: 10, step: "ten", size: 10 });
    expect(scale.select(11, 13)).toEqual({ value: 13, step: "one", size: 1 });
    expect(scale.select(10, 10.5)).toBeUndefined();
    // Zero is on every rung.
    expect(scale.select(-0.5, 0.5)?.step).toBe("ten");
  });

  test("rejects rungs that do not nest", () => {
    expect(() =>
      ladder(
        [
          { step: 5, numerator: 5 },
          { step: 2, numerator: 2 },
        ],
        String,
      ),
    ).toThrow(/integer multiple/);
    expect(() => ladder([], String)).toThrow();
  });
});

describe("decimalTicks", () => {
  const select = (lower: number, upper: number, scale = decimalTicks()) =>
    scale.select(lower, upper);

  test("follows the chosen chain", () => {
    expect(select(14, 21)?.value).toBe(20);
    expect(select(14, 21)?.step).toEqual({ multiplier: 1, exponent: 1 });
    expect(select(4, 6)?.step).toEqual({ multiplier: 5, exponent: 0 });
    const oneTwo = decimalTicks({ multipliers: [1, 2] });
    expect(select(4, 6, oneTwo)?.value).toBe(6);
    expect(select(4, 6, oneTwo)?.step).toEqual({ multiplier: 2, exponent: 0 });
  });

  test("produces exact decimal values", () => {
    expect(select(0.29, 0.31)?.value).toBe(0.3);
    expect(select(-0.71, -0.69)?.value).toBe(-0.7);
    expect(select(1.2344, 1.2346)?.value).toBe(1.2345);
    // A tick exactly at upper, despite 0.58 × 50 rounding below 29.
    expect(select(0.578, 0.58, decimalTicks({ multipliers: [1, 2] }))).toEqual({
      value: 0.58,
      step: { multiplier: 2, exponent: -2 },
      size: 0.02,
    });
  });

  test("handles magnitudes far beyond the step without overflow", () => {
    const selection = select(1e15, 1e15 + 0.5);
    expect(selection?.value).toBe(1e15 + 0.5);
    // Powers of ten beyond 10^22 are inexact, so such steps are approximate.
    expect(select(1e-250, 2.5e-250)!.value / 2e-250).toBeCloseTo(1, 12);
  });

  test("gives zero the coarsest step", () => {
    expect(select(-1, 1)?.value).toBe(0);
    expect(select(-1, 1)?.step.exponent).toBe(300);
    expect(select(-1e-300, -0)?.value).toBe(0);
    expect(Object.is(select(-1, -0)?.value, 0)).toBe(true);
  });

  test("omits steps below minStep", () => {
    expect(select(1.2, 1.4, decimalTicks({ minStep: 1 }))).toBeUndefined();
    expect(select(1.2, 2.4, decimalTicks({ minStep: 1 }))?.value).toBe(2);
  });

  test("formats the digits the step resolves", () => {
    const scale = decimalTicks();
    const at = (lower: number, upper: number) => {
      const selection = scale.select(lower, upper)!;
      return scale.format(selection.value, selection.step);
    };
    expect(at(0.29, 0.31)).toBe(
      (0.3).toLocaleString(undefined, { minimumFractionDigits: 1 }),
    );
    expect(at(-1, 1)).toBe("0");
    expect(at(1.99, 2.01)).toBe((2).toLocaleString());
  });
});

describe("durationTicks", () => {
  const scale = durationTicks();

  test("steps through clock-friendly durations", () => {
    expect(scale.select(4 * minute, 16 * minute)).toEqual({
      value: 15 * minute,
      step: { unit: "minute", count: 15 },
      size: 15 * minute,
    });
    expect(scale.select(25 * hour, 26 * hour)?.step).toEqual({
      unit: "hour",
      count: 1,
    });
    expect(scale.select(-1, 1)?.value).toBe(0);
  });

  test("formats components down to the step unit", () => {
    const format = (value: number) => {
      const selection = scale.select(value - 1, value)!;
      return scale.format(selection.value, selection.step);
    };
    expect(format(90 * minute)).toBe("1h 30m");
    expect(format(day + 61_000)).toBe("1d 1m 1s");
    expect(format(-5 * minute)).toBe("-5m");
    expect(format(1_500)).toBe("1s 500ms");
    expect(format(0)).toBe("0");
  });

  test("omits steps below minStep", () => {
    const minutes = durationTicks({ minStep: minute });
    expect(minutes.select(1_000, 59_000)).toBeUndefined();
  });
});

describe("timeTicks", () => {
  const utc = (iso: string) => Date.parse(`${iso}Z`);
  const scale = timeTicks({ zone: "utc" });

  test("uses calendar-length months and years", () => {
    expect(
      scale.select(utc("2024-01-20T00:00"), utc("2024-02-10T00:00")),
    ).toEqual({
      value: utc("2024-02-01T00:00"),
      step: { unit: "month", count: 1 },
      size: 29 * day,
    });
    expect(
      scale.select(utc("2023-12-20T00:00"), utc("2024-01-10T00:00"))?.step,
    ).toEqual({ unit: "year", count: 1 });
  });

  test("restarts seven-day steps on each 1st", () => {
    const selection = scale.select(
      utc("2024-01-23T00:00"),
      utc("2024-01-30T00:00"),
    );
    expect(selection?.value).toBe(utc("2024-01-29T00:00"));
    expect(selection?.size).toBe(3 * day);
  });

  test("steps hours and minutes", () => {
    expect(
      scale.select(utc("2024-03-05T13:20"), utc("2024-03-05T13:40")),
    ).toEqual({
      value: utc("2024-03-05T13:30"),
      step: { unit: "minute", count: 30 },
      size: 30 * minute,
    });
    expect(
      scale.select(utc("2024-03-05T05:00"), utc("2024-03-05T07:00"))?.value,
    ).toBe(utc("2024-03-05T06:00"));
  });

  test("follows the local zone by default", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      const selection = timeTicks().select(
        utc("2024-03-05T05:10"),
        utc("2024-03-05T05:40"),
      );
      // 11:00 in Kolkata (UTC+5:30).
      expect(selection?.value).toBe(utc("2024-03-05T05:30"));
      expect(selection?.step).toEqual({ unit: "hour", count: 1 });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("formats by step unit", () => {
    const format = (lower: string, upper: string) => {
      const selection = scale.select(utc(lower), utc(upper))!;
      return scale.format(selection.value, selection.step);
    };
    expect(format("2023-12-20T00:00", "2024-01-10T00:00")).toContain("2024");
    expect(format("2024-03-05T13:20", "2024-03-05T13:40")).toMatch(/30/);
  });
});
