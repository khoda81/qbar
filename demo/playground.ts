import {
  decimalTicks,
  durationTicks,
  ladder,
  layoutTicks,
  locate,
  timeTicks,
  type DecimalChain,
  type Quantile,
  type TickScale,
} from "../src/index.ts";
import {
  defineQBar,
  defineQRange,
  defineQSlider,
  QBarElement,
  QRangeElement,
  QSliderElement,
} from "../src/element.ts";
import { DISTRIBUTIONS, type Distribution } from "./distributions.ts";

defineQBar();
defineQSlider();
defineQRange();

const minute = 60_000;
const now = Math.round(Date.now() / minute) * minute;

function element<T extends Element>(id: string, type: new () => T): T {
  const result = document.getElementById(id);
  if (!(result instanceof type)) throw new Error(`missing #${id}`);
  return result;
}

/**
 * Parameter tracks are uncapped, but their ends map to ±Infinity. Truncating
 * at one in a billion keeps every reachable value finite.
 */
const truncated =
  (quantile: Quantile): Quantile =>
  (p) =>
    quantile(Math.min(1 - 1e-9, Math.max(1e-9, p)));

// Parsing reads back what the scales' labels show: "1,250.5", "1h 30m",
// "09:42 PM". A bare number counts minutes for the time units.

function parseInfinity(text: string): number | undefined {
  if (text === "∞" || text === "+∞") return Infinity;
  if (text === "−∞" || text === "-∞") return -Infinity;
  return undefined;
}

function parseNumber(text: string): number | undefined {
  const value = Number(text.replace(/[,\s]/g, "").replace("−", "-"));
  return text !== "" && Number.isFinite(value) ? value : undefined;
}

const DURATION_UNITS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: minute,
  s: 1_000,
  ms: 1,
};

function parseDuration(text: string): number | undefined {
  const sign = /^[-−]/.test(text) ? -1 : 1;
  const body = text.replace(/^[-−]\s*/, "");
  const minutes = parseNumber(body);
  if (minutes !== undefined) return sign * minutes * minute;
  if (!/^(\s*\d+(\.\d+)?\s*(ms|d|h|m|s))+$/i.test(body)) return undefined;
  let total = 0;
  for (const [, amount, unit] of body.matchAll(
    /(\d+(?:\.\d+)?)\s*(ms|d|h|m|s)/gi,
  )) {
    total += Number(amount) * DURATION_UNITS[unit!.toLowerCase()]!;
  }
  return sign * total;
}

function parseTime(text: string): number | undefined {
  const minutes = parseNumber(text);
  if (minutes !== undefined) return now + minutes * minute;
  const match =
    /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*([ap])?\.?m?\.?$/i.exec(
      text,
    );
  if (match === null) return undefined;
  const [, hours, minutesText, seconds = "0", fraction = "0", half] = match;
  let hour = Number(hours);
  if (half !== undefined) hour = (hour % 12) + (/p/i.test(half) ? 12 : 0);
  const date = new Date(now);
  date.setHours(
    hour,
    Number(minutesText),
    Number(seconds),
    Number(fraction.padEnd(3, "0")),
  );
  return date.getTime();
}

// Units: the distributions produce plain numbers, which become minutes of
// duration or minutes from now for the time scales (both in milliseconds).
type Unit = "number" | "duration" | "time";

const UNITS: Record<
  Unit,
  {
    readonly factor: number;
    readonly offset: number;
    parse(text: string): number | undefined;
  }
> = {
  number: { factor: 1, offset: 0, parse: parseNumber },
  duration: { factor: minute, offset: 0, parse: parseDuration },
  time: { factor: minute, offset: now, parse: parseTime },
};

const state = {
  distribution: DISTRIBUTIONS[0]!,
  values: [] as number[],
  anchors: [] as number[],
  unit: "number" as Unit,
  chain: [1, 5] as DecimalChain,
  analytic: false,
  trackWidth: 0,
};

const distributionSelect = element("distribution", HTMLSelectElement);
const parametersRoot = element("parameters", HTMLDivElement);
const unitSelect = element("unit", HTMLSelectElement);
const chainField = element("chain-field", HTMLLabelElement);
const chainSelect = element("chain", HTMLSelectElement);
const spacing = element("spacing", QRangeElement);
const analyticInput = element("analytic", HTMLInputElement);
const snapInput = element("snap", HTMLInputElement);
const slider = element("slider", QSliderElement);
const densitySvg = element("density", SVGSVGElement);
const valueForm = element("value-form", HTMLFormElement);
const valueInput = element("value", HTMLInputElement);
const meta = element("meta", HTMLOutputElement);

function quantile(): Quantile {
  const { distribution, values, unit } = state;
  const { factor, offset } = UNITS[unit];
  return (p) => offset + factor * distribution.quantile(p, values);
}

function density(): (p: number) => number {
  const { distribution, values, unit } = state;
  return (p) =>
    distribution.pdf(distribution.quantile(p, values), values) /
    UNITS[unit].factor;
}

function scale(): TickScale<unknown> {
  switch (state.unit) {
    case "number":
      return decimalTicks({ multipliers: state.chain });
    case "duration":
      return durationTicks({ minStep: 1_000 });
    case "time":
      return timeTicks({ minStep: 1_000 });
  }
}

function sliderWidth(): number {
  return Math.max(1, Math.round(slider.getBoundingClientRect().width));
}

/** Lays out the main slider again after any model or option change. */
function update(): void {
  const width = sliderWidth();
  // Spacing is log-uniform from 1 pixel (layouts need at least one) to the
  // main slider's width: Q(p) = width^p, densest near the small end, where
  // 24 vs 64 pixels matters and 600 vs 640 does not.
  if (width !== state.trackWidth) {
    state.trackWidth = width;
    spacing.quantile = (p) => width ** p;
  }
  const [minSpacing, fullSpacing] = spacing.range!;

  const base = quantile();
  const tickScale = scale();
  let calls = 0;
  const counted: Quantile = (p) => {
    calls += 1;
    return base(p);
  };

  const start = performance.now();
  const ticks = layoutTicks({
    quantile: counted,
    scale: tickScale,
    width,
    minSpacing,
    ...(state.analytic ? { density: density() } : {}),
  });
  const elapsed = performance.now() - start;

  slider.quantile = base;
  slider.scale = tickScale;
  slider.density = state.analytic ? density() : undefined;
  slider.setAttribute("min-spacing", String(minSpacing));
  slider.setAttribute("full-spacing", String(fullSpacing));

  element("spacing-value", HTMLOutputElement).value =
    `${minSpacing} → ${fullSpacing} px`;
  element("stat-calls", HTMLElement).textContent = String(calls);
  element("stat-pixels", HTMLElement).textContent = String(width + 1);
  element("stat-ticks", HTMLElement).textContent = String(ticks.length);
  element("stat-time", HTMLElement).textContent = `${elapsed.toFixed(2)} ms`;
  element("note", HTMLElement).textContent = state.distribution.note;
  chainField.hidden = state.unit !== "number";

  drawDensity(width);
  readout();
}

function drawDensity(width: number): void {
  const { distribution, values } = state;
  const heights: number[] = [];
  for (let pixel = 0; pixel < width; pixel += 1) {
    const x = distribution.quantile((pixel + 0.5) / width, values);
    heights.push(distribution.pdf(x, values));
  }
  const peak = Math.max(...heights.filter(Number.isFinite));
  const points = heights.map(
    (height, pixel) =>
      `${pixel + 0.5},${100 - 96 * Math.min(1, height / peak || 0)}`,
  );
  densitySvg.setAttribute("viewBox", `0 0 ${width} 100`);
  densitySvg.setAttribute("preserveAspectRatio", "none");
  densitySvg.innerHTML = `<path d="M0,100 L${points.join(" L")} L${width},100 Z"></path>`;
}

/**
 * The value field shows the slider's value, except while someone is typing
 * a new one into it.
 */
function readout(): void {
  if (document.activeElement !== valueInput) {
    valueInput.value = slider.label ?? "";
    valueInput.removeAttribute("aria-invalid");
  }
  const value = slider.value;
  if (value === undefined || !Number.isFinite(value)) {
    meta.value = "";
    return;
  }
  const width = sliderWidth();
  const position = locate(quantile(), width, value);
  meta.value =
    position === undefined
      ? "outside the bar"
      : `p = ${(position / width).toFixed(3)} · ${position.toFixed(1)} px`;
}

/** Typed text becomes the slider's value, which locate() positions. */
function commit(): void {
  const text = valueInput.value.replace(/\s+/g, " ").trim();
  const value = parseInfinity(text) ?? UNITS[state.unit].parse(text);
  if (value === undefined) {
    valueInput.setAttribute("aria-invalid", "true");
    meta.value = "Couldn't read that. Try 62.5, 1h 30m or 09:42 PM.";
    return;
  }
  slider.value = value;
  valueInput.blur();
  readout();
}

/** The main slider starts each model at its median. */
function resetValue(): void {
  slider.value = quantile()(0.5);
  requestAnimationFrame(readout);
}

// Each parameter is a qbar slider whose track depends on the others.
const parameterSliders: QSliderElement[] = [];
const parameterScale = decimalTicks({ multipliers: [1, 2] });

function retrack(): void {
  state.distribution.parameters.forEach((parameter, index) => {
    const control = parameterSliders[index]!;
    control.quantile = truncated(
      parameter.track(state.values, state.anchors[index]!),
    );
  });
}

function buildParameters(): void {
  const { parameters } = state.distribution;
  state.values = parameters.map(({ value }) => value);
  state.anchors = [...state.values];
  parametersRoot.replaceChildren();
  parameterSliders.length = 0;

  parameters.forEach((parameter, index) => {
    const field = document.createElement("div");
    field.className = "field";
    field.innerHTML = `<div class="field__row"><span>${parameter.name}</span><output></output></div>`;
    const output = field.querySelector("output")!;
    const control = new QSliderElement();
    control.setAttribute("orientation", "horizontal");
    control.setAttribute("min-spacing", "14");
    control.setAttribute("full-spacing", "40");
    control.setAttribute("aria-label", parameter.name);
    control.scale = parameterScale;
    control.value = parameter.value;
    field.append(control);
    parametersRoot.append(field);
    parameterSliders.push(control);

    const show = () => (output.textContent = control.label ?? "");
    control.addEventListener("input", () => {
      state.values[index] = control.value!;
      show();
      // The other tracks follow; this one keeps its anchor until release.
      retrack();
      update();
    });
    control.addEventListener("change", () => {
      state.anchors[index] = control.value!;
      retrack();
      requestAnimationFrame(show);
    });
    requestAnimationFrame(show);
  });
  retrack();
}

// Spacing: one range, so the hidden end can never pass the opaque end.
spacing.setAttribute("min-spacing", "14");
spacing.setAttribute("full-spacing", "40");
spacing.scale = decimalTicks();
spacing.format = (pixels) => `${pixels} px`;
spacing.range = [24, 64];
spacing.addEventListener("input", update);

// Other controls.
for (const [index, distribution] of DISTRIBUTIONS.entries()) {
  distributionSelect.add(new Option(distribution.name, String(index)));
}
distributionSelect.addEventListener("change", () => {
  state.distribution = DISTRIBUTIONS[Number(distributionSelect.value)]!;
  buildParameters();
  update();
  resetValue();
});
unitSelect.addEventListener("change", () => {
  state.unit = unitSelect.value as Unit;
  update();
  resetValue();
});
chainSelect.addEventListener("change", () => {
  state.chain = chainSelect.value
    .split(",")
    .map(Number) as unknown as DecimalChain;
  update();
});
analyticInput.addEventListener("change", () => {
  state.analytic = analyticInput.checked;
  update();
});
snapInput.addEventListener("change", () => {
  slider.toggleAttribute("snap", snapInput.checked);
});

slider.addEventListener("input", readout);
valueForm.addEventListener("submit", (event) => {
  event.preventDefault();
  commit();
});
valueInput.addEventListener("change", commit);
valueInput.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // Restore first: blurring an edited field fires change, which commits.
  valueInput.value = slider.label ?? "";
  valueInput.blur();
  readout();
});

new ResizeObserver(() => update()).observe(slider);
buildParameters();
update();
resetValue();

// Gallery.
const byName = (name: string): Distribution =>
  DISTRIBUTIONS.find((distribution) => distribution.name === name)!;

const BYTE_UNITS = [
  [30, "GiB"],
  [20, "MiB"],
  [10, "KiB"],
  [0, "B"],
] as const;

const bytes = ladder(
  Array.from({ length: 51 }, (_, index) => ({
    step: 50 - index,
    numerator: 2 ** (50 - index),
  })),
  (value, exponent) => {
    if (value === 0) return "0 B";
    const [unitExponent, symbol] = BYTE_UNITS.find(
      ([unitExponent]) => unitExponent <= exponent,
    ) ?? [0, "B"];
    const digits = Math.max(0, unitExponent - exponent);
    return `${(value / 2 ** unitExponent).toFixed(digits)} ${symbol}`;
  },
);

const GALLERY: readonly {
  title: string;
  subtitle: string;
  color: string;
  quantile: Quantile;
  scale: TickScale<unknown>;
  format?: (value: number) => string;
}[] = [
  {
    title: "Exam score",
    subtitle: "normal(70, 12)",
    color: "#ff9eb5",
    quantile: (p) => byName("Normal").quantile(p, [70, 12]),
    scale: decimalTicks(),
  },
  {
    title: "Download ETA",
    subtitle: "log-normal, median 4m",
    color: "#8de8b2",
    quantile: (p) => minute * byName("Log-normal").quantile(p, [4, 0.8]),
    scale: durationTicks({ minStep: 1_000 }),
  },
  {
    title: "Train arrival",
    subtitle: "logistic, now + 12m",
    color: "#76d7ff",
    quantile: (p) => now + minute * byName("Logistic").quantile(p, [12, 1.5]),
    scale: timeTicks({ minStep: minute }),
  },
  {
    title: "Heavy tail",
    subtitle: "Cauchy(0, 1)",
    color: "#ffca7a",
    quantile: (p) => byName("Cauchy").quantile(p, [0, 1]),
    scale: decimalTicks({ multipliers: [1, 2] }),
  },
  {
    title: "File size",
    subtitle: "Pareto, min 4 KiB, α 1.1",
    color: "#c9a7ff",
    quantile: (p) => byName("Pareto").quantile(p, [4096, 1.1]),
    scale: bytes,
  },
  {
    title: "Latency",
    subtitle: "bimodal: cache hit or miss",
    color: "#ff9eb5",
    quantile: (p) => byName("Bimodal").quantile(p, [40, 180, 6, 0.7]),
    scale: decimalTicks({ minStep: 1 }),
    format: (value) => `${value} ms`,
  },
];

const gallery = element("gallery", HTMLDivElement);
for (const example of GALLERY) {
  const card = document.createElement("article");
  card.className = "card";
  card.style.setProperty("--card-color", example.color);
  card.innerHTML = `<h3>${example.title}<span>${example.subtitle}</span></h3><q-bar></q-bar>`;
  gallery.append(card);

  const bar = card.querySelector("q-bar") as QBarElement;
  bar.quantile = example.quantile;
  bar.scale = example.scale;
  if (example.format) bar.format = example.format;
}
