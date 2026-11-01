# qbar

**qbar** places density-aware ticks on anything laid out by a quantile
function: ETA and latency distributions, price forecasts, non-linear sliders,
any one-dimensional mapping from position to value.

There are no "major" and "minor" ticks. Every tick has a step from a nested
spectrum (…, 10, 5, 1, 0.5, … or year, month, day, hour, …) and a **spacing**:
the pixels between it and its same-step neighbours at the local density. Wide
spacing means a stable, prominent tick; a renderer fades ticks as their
spacing shrinks.

## Layout

```ts
import { decimalTicks, layoutTicks } from "qbar";

const ticks = layoutTicks({
  quantile: (p) => model.quantile(p), // [0, 1] → value, nondecreasing
  scale: decimalTicks(),
  width: 400, // pixels; p sits at p × width
  minSpacing: 24, // optional, pixels
  density: (p) => model.pdf(model.quantile(p)), // optional
});

for (const { value, step, position, spacing } of ticks) {
  // position: pixels from the p = 0 end; spacing ≥ minSpacing
}
```

`minSpacing` divides the bar into buckets that can hold at most one tick. Each
bucket asks the scale for its coarsest tick, bisects to the pixel holding it,
and keeps it when `size / (Q((i+1)/W) − Q(i/W)) ≥ minSpacing`. That costs about
`W / minSpacing` quantile calls plus `log2(minSpacing)` per bucket, rather than
one per pixel; at 1000 pixels it is roughly 200 calls instead of 1001.

Only the quantile is required. `density(p)`, the probability density at
`Q(p)`, replaces the pixel estimate when you have it. Infinite quantiles at the
ends are allowed; pixels with an infinite boundary hold no tick.

The bucket shortcut assumes the quantile is close to linear across one bucket.
Where density changes sharply within `minSpacing` pixels, a tick the per-pixel
definition would keep can be dropped as crowded.

`locate(quantile, width, value)` inverts the layout for markers and slider
thumbs; the other direction is just `quantile(x / width)`.

## Scales

```ts
decimalTicks({ multipliers: [1, 5], minStep: 0.01 }); // [1], [1, 2] or [1, 5]
durationTicks({ minStep: 1_000 }); // milliseconds: 500ms, 1s, 5s, 15s, 30s, 1m, …
timeTicks({ zone: "local", minStep: 60_000 }); // Unix ms on calendar boundaries
```

`minStep` drops steps finer than a size: cents, whole seconds, whole minutes.
Each scale also formats its own ticks with `scale.format(value, step)`.

A scale is two functions:

```ts
interface TickScale<Step> {
  /** The coarsest tick in (lower, upper]. */
  select(
    lower: number,
    upper: number,
  ): { value: number; step: Step; size: number } | undefined;
  format(value: number, step: Step): string;
}
```

Steps must **nest**: every tick of a coarser step is also a tick of each finer
step. That is what makes one tick per bucket enough, and why 1-2-5 decimals
and weeks are not offered: a 5 is not a multiple of 2, and weeks straddle
months. `ladder(rungs, format)` builds a nested scale of uniform steps from
zero, such as powers of 1024 for bytes. Each rung is an integer ratio
`numerator / denominator`, so decimal fractions stay exact.

## Web component

`qbar/element` renders ticks as SVG. It works in any framework, and it defaults
to a vertical bar so labels stay horizontal.

```ts
import { durationTicks } from "qbar";
import { defineQBar } from "qbar/element";

defineQBar(); // registers <q-bar>; importing alone has no side effects

const bar = document.querySelector("q-bar")!;
bar.quantile = (p) => model.quantile(p);
bar.scale = durationTicks();
bar.format = (value, step) => …; // optional; defaults to the scale's
bar.refresh(); // after mutating a model in place
```

```html
<q-bar min-spacing="24" full-spacing="64"></q-bar>
<q-bar orientation="horizontal"></q-bar>
```

Tick opacity rises from 0 at `min-spacing` pixels of spacing to 1 at
`full-spacing`. The element inherits typography and color:

```css
q-bar {
  --qbar-color: currentColor;
  --qbar-axis-opacity: 0.25;
}
```

## Development

```sh
bun install
bun run check # types, tests, build, formatting
bun run demo # live demo: clock times, durations, prices, latencies
```

The package remains private while its public API is being designed. It is
licensed under the MIT License.
