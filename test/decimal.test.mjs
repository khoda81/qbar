import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decimalTicks,
  fiveTimesPowerOfTenTicks,
  powerOfTenTicks,
} from "../dist/index.js";

function select(source, lower, upper) {
  const output = { value: NaN, spacing: NaN, level: NaN };
  return source.select(lower, upper, output) ? output : undefined;
}

describe("DecimalTickSource", () => {
  test("supports a powers-of-ten family", () => {
    assert.deepEqual(
      {
        value: select(powerOfTenTicks(), 4, 6)?.value,
        spacing: select(powerOfTenTicks(), 4, 6)?.spacing,
      },
      { value: 6, spacing: 1 },
    );
  });

  test("supports a five-times-powers-of-ten family", () => {
    const result = select(fiveTimesPowerOfTenTicks(), 4, 6);
    assert.equal(result?.value, 5);
    assert.equal(result?.spacing, 5);
  });

  test("selects the coarsest configured family present in the interval", () => {
    const result = select(decimalTicks({ multipliers: [1, 2, 5] }), 19, 21);
    assert.equal(result?.value, 20);
    assert.equal(result?.spacing, 20);
  });

  test("treats the shared origin as a maximally stable anchor", () => {
    const result = select(decimalTicks(), -0.01, 0);
    assert.equal(result?.value, 0);
    assert.equal(result?.spacing, Infinity);
    assert.equal(result?.level, Infinity);
  });

  test("uses half-open bins so a boundary tick belongs to the left bin", () => {
    const source = powerOfTenTicks();
    assert.equal(select(source, 0, 1)?.value, 1);
    assert.notEqual(select(source, 1, 1.5)?.value, 1);
  });
});
