/**
 * A quantile function maps a probability in [0, 1] to a value.
 *
 * Infinite values at p=0 and p=1 are valid.
 */
export type QuantileFunction = (probability: number) => number;

/**
 * Reusable mutable selection populated by a TickSource.
 *
 * `spacing` is the value-space distance to the next tick in the same family.
 * `level` is source-defined numeric metadata identifying the selected family.
 */
export interface MutableTickSelection {
  value: number;
  spacing: number;
  level: number;
}

/**
 * Selects the coarsest preferred tick contained in (lower, upper].
 *
 * Implementations should mutate `out` and return true when they find a tick.
 * This avoids allocating one object for every screen pixel.
 */
export interface TickSource {
  select(lower: number, upper: number, out: MutableTickSelection): void;
}

export type VisibilityFunction = (pixelSpacing: number) => number;

export interface TickRaster {
  /** NaN means that the bin has no tick. */
  readonly values: Float64Array;
  /** The selected family's local value-space spacing. */
  readonly spacings: Float64Array;
  /** Source-defined family metadata. NaN means that the bin has no family. */
  readonly levels: Float64Array;
  /** Visibility in [0, 1]. */
  readonly visibility: Float64Array;
}

export interface RasterizeTickOptions {
  visibility?: VisibilityFunction;
  output?: TickRaster;
}

export interface RasterizeOptions extends RasterizeTickOptions {
  width: number;
  quantile: QuantileFunction;
  ticks: TickSource;
  boundaries?: Float64Array;
}

export interface QuantileRaster extends TickRaster {
  readonly boundaries: Float64Array;
}
