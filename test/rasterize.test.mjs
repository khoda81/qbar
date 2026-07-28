import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createTickRaster,
  fillQuantileBoundaries,
  fillTickRaster,
  powerOfTenTicks,
  rasterizeQuantiles,
} from "../dist/index.js";

describe("tick rasterization", () => {
  test("uses two contiguous sweeps and returns parallel float arrays", () => {
    const raster = rasterizeQuantiles({
      width: 4,
      quantile: (p) => p * 4,
      ticks: powerOfTenTicks(),
      visibility: (pixelSpacing) => pixelSpacing / 2,
    });

    assert.ok(raster.boundaries instanceof Float64Array);
    assert.equal(raster.boundaries.length, 5);
    assert.ok(raster.values instanceof Float64Array);
    assert.equal(raster.values.length, 4);
    assert.ok(raster.visibility instanceof Float64Array);
    assert.equal(raster.visibility.length, 4);
    assert.deepEqual([...raster.values], [1, 2, 3, 4]);
    assert.deepEqual([...raster.spacings], [1, 1, 1, 1]);
    assert.deepEqual([...raster.visibility], [0.5, 0.5, 0.5, 0.5]);
  });

  test("passes family spacing divided by bin range to visibility", () => {
    const observed = [];
    rasterizeQuantiles({
      width: 2,
      quantile: (p) => p * 20,
      ticks: powerOfTenTicks(),
      visibility: (pixelSpacing) => {
        observed.push(pixelSpacing);
        return 1;
      },
    });

    assert.deepEqual(observed, [1, 1]);
  });

  test("retains unbounded edge markers with zero visibility", () => {
    const raster = rasterizeQuantiles({
      width: 3,
      quantile: (p) => {
        if (p === 0) return -Infinity;
        if (p === 1) return Infinity;
        return p;
      },
      ticks: powerOfTenTicks(),
    });

    assert.equal(raster.values[0], -Infinity);
    assert.equal(raster.visibility[0], 0);
    assert.equal(raster.values[2], Infinity);
    assert.equal(raster.visibility[2], 0);
  });

  test("reuses caller-owned boundary and result buffers", () => {
    const boundaries = new Float64Array(5);
    const output = createTickRaster(4);

    fillQuantileBoundaries((p) => p * 4, 4, boundaries);
    assert.equal(
      fillTickRaster(boundaries, powerOfTenTicks(), { output }),
      output,
    );
  });
});
