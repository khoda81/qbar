import { fillQuantileBoundaries } from "./boundaries.js";
import { defaultVisibility } from "./visibility.js";
import type {
  MutableTickSelection,
  QuantileRaster,
  RasterizeOptions,
  RasterizeTickOptions,
  TickRaster,
  TickSource,
} from "./types.js";

export function createTickRaster(width: number): TickRaster {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError(
      `width must be a positive safe integer; received ${width}`,
    );
  }

  return {
    values: new Float64Array(width),
    spacings: new Float64Array(width),
    levels: new Float64Array(width),
    visibility: new Float64Array(width),
  };
}

function assertOutputLength(output: TickRaster, width: number): void {
  for (const [name, buffer] of Object.entries(output)) {
    if (buffer.length !== width) {
      throw new RangeError(
        `${name} output must have length ${width}; received ${buffer.length}`,
      );
    }
  }
}

function clampVisibility(value: number): number {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Sweeps W adjacent boundary pairs and emits one tick selection per pixel bin.
 */
export function fillTickRaster(
  boundaries: Float64Array,
  ticks: TickSource,
  options: RasterizeTickOptions = {},
): TickRaster {
  if (boundaries.length < 2) {
    throw new RangeError("boundaries must contain at least two values");
  }

  const width = boundaries.length - 1;
  const output = options.output ?? createTickRaster(width);
  const visibilityFunction = options.visibility ?? defaultVisibility;
  assertOutputLength(output, width);

  const selection: MutableTickSelection = {
    value: Number.NaN,
    spacing: Number.NaN,
    level: Number.NaN,
  };

  for (let index = 0; index < width; index += 1) {
    const lower = boundaries[index]!;
    const upper = boundaries[index + 1]!;

    output.values[index] = Number.NaN;
    output.spacings[index] = Number.NaN;
    output.levels[index] = Number.NaN;
    output.visibility[index] = 0;

    if (Number.isNaN(lower) || Number.isNaN(upper) || upper < lower) {
      throw new RangeError(
        `invalid boundary interval at bin ${index}: [${lower}, ${upper}]`,
      );
    }

    // Unbounded edge bins deliberately retain their infinity marker. Their
    // infinite value range gives them zero finite-resolution visibility.
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      output.values[index] = lower === -Infinity ? -Infinity : Infinity;
      output.spacings[index] = Infinity;
      output.levels[index] = -Infinity;
      continue;
    }

    if (!ticks.select(lower, upper, selection)) {
      continue;
    }

    const binRange = upper - lower;
    const pixelSpacing =
      binRange === 0
        ? Infinity
        : selection.spacing === Infinity
          ? Infinity
          : selection.spacing / binRange;

    output.values[index] = selection.value;
    output.spacings[index] = selection.spacing;
    output.levels[index] = selection.level;
    output.visibility[index] = clampVisibility(
      visibilityFunction(pixelSpacing),
    );
  }

  return output;
}

/**
 * Runs the boundary sweep followed by the tick/visibility sweep.
 */
export function rasterizeQuantiles(options: RasterizeOptions): QuantileRaster {
  const boundaries = fillQuantileBoundaries(
    options.quantile,
    options.width,
    options.boundaries,
  );
  const raster = fillTickRaster(boundaries, options.ticks, options);

  return {
    boundaries,
    ...raster,
  };
}
