import type { QuantileFunction } from "./types.js";

function assertWidth(width: number): void {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError(
      `width must be a positive safe integer; received ${width}`,
    );
  }
}

/**
 * Evaluates a quantile function exactly W+1 times into a contiguous buffer.
 */
export function fillQuantileBoundaries(
  quantile: QuantileFunction,
  width: number,
  output: Float64Array = new Float64Array(width + 1),
): Float64Array {
  assertWidth(width);

  if (output.length !== width + 1) {
    throw new RangeError(
      `boundary output must have length ${width + 1}; received ${output.length}`,
    );
  }

  let previous = -Infinity;

  for (let index = 0; index <= width; index += 1) {
    const value = quantile(index / width);

    if (Number.isNaN(value)) {
      throw new RangeError(
        `quantile returned NaN at probability ${index / width}`,
      );
    }

    if (value < previous) {
      throw new RangeError(
        `quantile must be nondecreasing; Q(${index / width})=${value} is below ${previous}`,
      );
    }

    output[index] = value;
    previous = value;
  }

  return output;
}
