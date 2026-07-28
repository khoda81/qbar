import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fillQuantileBoundaries } from "../dist/index.js";

describe("fillQuantileBoundaries", () => {
  test("evaluates exactly W+1 quantile boundaries", () => {
    const probabilities = [];
    const output = fillQuantileBoundaries((probability) => {
      probabilities.push(probability);
      return probability * 10;
    }, 4);

    assert.deepEqual(probabilities, [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual([...output], [0, 2.5, 5, 7.5, 10]);
  });

  test("retains infinite endpoint quantiles", () => {
    const output = fillQuantileBoundaries((probability) => {
      if (probability === 0) return -Infinity;
      if (probability === 1) return Infinity;
      return probability;
    }, 2);

    assert.equal(output[0], -Infinity);
    assert.equal(output[1], 0.5);
    assert.equal(output[2], Infinity);
  });

  test("accepts a caller-owned output buffer", () => {
    const target = new Float64Array(3);
    assert.equal(
      fillQuantileBoundaries((p) => p, 2, target),
      target,
    );
  });

  test("rejects decreasing quantiles", () => {
    assert.throws(
      () => fillQuantileBoundaries((p) => (p < 0.75 ? p : -1), 4),
      /nondecreasing/,
    );
  });
});
