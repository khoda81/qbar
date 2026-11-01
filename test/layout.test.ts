import { describe, expect, test } from "bun:test";
import {
  decimalTicks,
  layoutTicks,
  locate,
  type Quantile,
  type Tick,
  type TickScale,
} from "../src/index.ts";

const logistic: Quantile = (p) => Math.log(p / (1 - p));
const uniform =
  (lower: number, upper: number): Quantile =>
  (p) =>
    lower + p * (upper - lower);

/** Every pixel picks its coarsest tick; the definition buckets approximate. */
function perPixel<Step>(
  quantile: Quantile,
  scale: TickScale<Step>,
  width: number,
  minSpacing: number,
): Tick<Step>[] {
  const ticks: Tick<Step>[] = [];
  for (let pixel = 0; pixel < width; pixel += 1) {
    const lower = quantile(pixel / width);
    const upper = quantile((pixel + 1) / width);
    if (!(-Infinity < lower && lower < upper && upper < Infinity)) continue;
    const selection = scale.select(lower, upper);
    if (selection === undefined) continue;
    const spacing = selection.size / (upper - lower);
    if (minSpacing <= spacing) {
      ticks.push({
        value: selection.value,
        step: selection.step,
        position: pixel + (selection.value - lower) / (upper - lower),
        spacing,
      });
    }
  }
  return ticks;
}

function counting(quantile: Quantile): [Quantile, () => number] {
  let calls = 0;
  return [
    (p) => {
      calls += 1;
      return quantile(p);
    },
    () => calls,
  ];
}

describe("layoutTicks", () => {
  const scale = decimalTicks({ multipliers: [1, 2] });

  test("matches the per-pixel definition when the quantile is linear", () => {
    for (const [lower, upper] of [
      [0, 1],
      [-3.7, 12.2],
      [1e6, 1e6 + 0.37],
      [184.1, 186.9],
    ] as const) {
      const linear = uniform(lower, upper);
      // Infinite ends must not change the interior.
      const tailed: Quantile = (p) =>
        p === 0 ? -Infinity : p === 1 ? Infinity : linear(p);
      for (const quantile of [linear, tailed]) {
        for (const minSpacing of [8, 24, 40.5]) {
          expect(
            layoutTicks({ quantile, scale, width: 500, minSpacing }),
          ).toEqual(perPixel(quantile, scale, 500, minSpacing));
        }
      }
    }
  });

  test("keeps nearly every per-pixel tick of a curved quantile", () => {
    const reference = perPixel(logistic, scale, 1000, 24);
    const ticks = layoutTicks({ quantile: logistic, scale, width: 1000 });
    for (const tick of ticks) expect(reference).toContainEqual(tick);
    expect(reference.length - ticks.length).toBeLessThanOrEqual(1);
  });

  test("keeps at most one tick per bucket, each with room", () => {
    const ticks = layoutTicks({
      quantile: logistic,
      scale,
      width: 1000,
      minSpacing: 30,
    });
    expect(ticks.length).toBeGreaterThan(5);
    const buckets = ticks.map(({ position }) => Math.floor(position / 30));
    expect(new Set(buckets).size).toBe(ticks.length);
    for (const tick of ticks) expect(tick.spacing).toBeGreaterThanOrEqual(30);
  });

  test("calls the quantile far fewer than once per pixel", () => {
    for (const shape of [uniform(0, 100), uniform(0, 1), logistic]) {
      const [quantile, calls] = counting(shape);
      layoutTicks({ quantile, scale, width: 1000 });
      const buckets = Math.ceil(1000 / 24);
      expect(calls()).toBeLessThanOrEqual(
        buckets + 1 + buckets * Math.ceil(Math.log2(24)),
      );
      expect(calls()).toBeLessThan(1000 / 4);
    }
  });

  test("puts ticks where the quantile reaches their value", () => {
    for (const tick of layoutTicks({ quantile: logistic, scale, width: 800 })) {
      expect(logistic(tick.position / 800)).toBeCloseTo(tick.value, 2);
    }
  });

  test("skips pixels with infinite or flat extent", () => {
    const steps: Quantile = (p) => (p < 0.5 ? 3 : 7);
    expect(layoutTicks({ quantile: steps, scale, width: 100 })).toEqual([]);

    const infinite: Quantile = (p) => (p < 0.5 ? -Infinity : Infinity);
    expect(layoutTicks({ quantile: infinite, scale, width: 100 })).toEqual([]);

    // The finite part of an edge bucket still gets its tick: Q(0.01) = -5.
    const tailed: Quantile = (p) => (p === 0 ? -Infinity : 1000 * p - 15);
    const [first] = layoutTicks({ quantile: tailed, scale, width: 100 });
    expect(first?.value).toBe(0);
    expect(first?.position).toBeCloseTo(1.5, 10);
  });

  test("uses a supplied density instead of the pixel estimate", () => {
    const quantile = uniform(0, 10);
    const ticks = layoutTicks({
      quantile,
      scale,
      width: 100,
      density: () => 0.1,
    });
    // Size 10 × density 0.1 per unit × 100 px.
    expect(ticks.find(({ value }) => value === 10)?.spacing).toBe(100);
    const estimated = layoutTicks({ quantile, scale, width: 100 });
    expect(estimated.map(({ value }) => value)).toEqual(
      ticks.map(({ value }) => value),
    );

    expect(() =>
      layoutTicks({ quantile, scale, width: 100, density: () => -1 }),
    ).toThrow(/density/);
  });

  test("rejects invalid input", () => {
    expect(() =>
      layoutTicks({ quantile: () => NaN, scale, width: 10 }),
    ).toThrow(/NaN/);
    expect(() =>
      layoutTicks({ quantile: (p) => -p, scale, width: 100 }),
    ).toThrow(/nondecreasing/);
    expect(() => layoutTicks({ quantile: logistic, scale, width: 0 })).toThrow(
      /width/,
    );
    expect(() =>
      layoutTicks({ quantile: logistic, scale, width: 10, minSpacing: 0.5 }),
    ).toThrow(/minSpacing/);
    const liar: TickScale<null> = {
      select: () => ({ value: 1e9, step: null, size: 1 }),
      format: String,
    };
    expect(() =>
      layoutTicks({ quantile: logistic, scale: liar, width: 10 }),
    ).toThrow(/outside/);
  });
});

describe("locate", () => {
  test("inverts the quantile to sub-pixel accuracy", () => {
    expect(locate(uniform(0, 10), 100, 2.5)).toBeCloseTo(25, 10);
    expect(locate(logistic, 1000, 0)).toBeCloseTo(500, 10);
    expect(locate(logistic, 1000, Math.log(3))).toBeCloseTo(750, 1);
  });

  test("is undefined outside the bar and pins edges", () => {
    expect(locate(uniform(0, 10), 100, -1)).toBeUndefined();
    expect(locate(uniform(0, 10), 100, 11)).toBeUndefined();
    expect(locate(uniform(0, 10), 100, 0)).toBe(0);
    expect(locate(uniform(0, 10), 100, 10)).toBe(100);
    // Inside a pixel bounded by an infinity, the finite edge.
    expect(locate(logistic, 10, -100)).toBe(1);
    expect(locate(logistic, 10, 100)).toBe(9);
  });

  test("maps a plateau to its start", () => {
    const steps: Quantile = (p) => (p <= 0.5 ? 0 : 1);
    expect(locate(steps, 10, 0)).toBe(0);
    expect(locate(steps, 10, 1)).toBe(6);
  });
});
