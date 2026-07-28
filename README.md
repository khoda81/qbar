# qbar

**qbar** is a pixel-resolution quantile rasterizer.

For a visualization that is `W` CSS pixels long, qbar evaluates a quantile
function at `W + 1` evenly spaced probabilities. Those boundaries define the
value interval represented by every pixel. A configurable tick source then
selects the best human-friendly value in each interval and estimates how many
pixels separate ticks from the same family:

```text
pixel spacing ≈ tick family spacing / value range under the pixel
```

The core is renderer-independent. Canvas, SVG, HTML, and framework components
can all consume the same typed-array output.

## Current API

```ts
import { decimalTicks, rasterizeQuantiles, smoothVisibility } from "qbar";

const raster = rasterizeQuantiles({
  width: 100,
  quantile: (probability) => model.quantile(probability),
  ticks: decimalTicks({ multipliers: [1, 2, 5] }),
  visibility: smoothVisibility({
    hiddenAt: 24,
    opaqueAt: 64,
  }),
});

raster.boundaries; // Float64Array(101)
raster.values; // Float64Array(100), NaN where no tick exists
raster.spacings; // Float64Array(100)
raster.levels; // Float64Array(100), source-defined family metadata
raster.visibility; // Float64Array(100), values in [0, 1]
```

The two sweeps are also independently available:

```ts
const boundaries = fillQuantileBoundaries(quantile, width, boundaryBuffer);
const ticks = fillTickRaster(boundaries, tickSource, {
  output: reusableTickBuffers,
});
```

## Tick families

```ts
powerOfTenTicks();
fiveTimesPowerOfTenTicks();
decimalTicks({ multipliers: [1, 2, 5] });

calendarTicks({
  levels: [
    { unit: "month" },
    { unit: "week" },
    { unit: "hour" },
    { unit: "minute" },
  ],
});
```

Calendar values are currently Unix timestamps in milliseconds with UTC
boundaries. Month and year spacing is calculated from the selected boundary,
so variable-length calendar units are preserved.

Custom tick sources implement one allocation-free method:

```ts
interface TickSource {
  select(lower: number, upper: number, out: MutableTickSelection): boolean;
}
```

The source selects the coarsest preferred tick contained in `(lower, upper]`,
writes its value, local family spacing, and numeric family identifier to `out`,
then returns `true`.

## Development

```sh
bun install
bun run check
bun run build
```

The package is intentionally marked private and unlicensed while its public API
is being designed.
