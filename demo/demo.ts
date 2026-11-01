import { decimalTicks, durationTicks, timeTicks } from "../src/index.ts";
import { defineQBar, QBarElement } from "../src/element.ts";

defineQBar();

const minute = 60_000;
const baseTime = Date.now();
const connectionDeparture = baseTime + 13.5 * minute;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const clockTicks = timeTicks({ minStep: minute });
const centTicks = decimalTicks({ minStep: 0.01 });
const secondTicks = durationTicks({ minStep: 1_000 });
const minuteTicks = durationTicks({ minStep: minute });
const wholeTicks = decimalTicks({ minStep: 1 });

const shortTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactBytesFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

function element(id: string): HTMLElement {
  const result = document.getElementById(id);
  if (!result) throw new Error(`missing demo element #${id}`);
  return result;
}

function bar(id: string): QBarElement {
  const result = document.getElementById(id);
  if (!(result instanceof QBarElement)) {
    throw new Error(`missing q-bar element #${id}`);
  }
  return result;
}

function text(id: string, value: string): void {
  element(id).textContent = value;
}

function logisticQuantile(
  probability: number,
  median: number,
  scale: number,
): number {
  if (probability <= 0) return -Infinity;
  if (probability >= 1) return Infinity;
  return median + scale * Math.log(probability / (1 - probability));
}

function logisticCdf(value: number, median: number, scale: number): number {
  return 1 / (1 + Math.exp(-(value - median) / scale));
}

function logLogisticQuantile(
  probability: number,
  median: number,
  shape: number,
): number {
  if (probability <= 0) return 0;
  if (probability >= 1) return Infinity;
  return median * (probability / (1 - probability)) ** (1 / shape);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatDuration(totalSeconds: number, compact = false): string {
  if (!Number.isFinite(totalSeconds)) return "∞";

  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  if (hours > 0) {
    return compact
      ? `${hours}h ${minutes}m`
      : `${hours}:${String(minutes).padStart(2, "0")}h`;
  }
  if (minutes > 0) {
    return compact
      ? `${minutes}m`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }
  return `${remainder}s`;
}

function formatWindow(
  lower: number,
  upper: number,
  formatter: (value: number) => string,
): string {
  return `${formatter(lower)} – ${formatter(upper)}`;
}

function percent(probability: number): string {
  return `${Math.round(clamp(probability, 0, 1) * 100)}%`;
}

const models = {
  connection: { median: baseTime, scale: minute },
  download: { median: 20, shape: 4 },
  market: { median: 184, scale: 0.4 },
  recovery: { median: 20 * 60, shape: 3 },
};

const bars = {
  connection: bar("connection-bar"),
  download: bar("download-bar"),
  market: bar("market-bar"),
  recovery: bar("recovery-bar"),
};

bars.connection.scale = clockTicks;
bars.connection.quantile = (probability) =>
  logisticQuantile(
    probability,
    models.connection.median,
    models.connection.scale,
  );

// Duration scales count milliseconds; the models count seconds.
bars.download.scale = secondTicks;
bars.download.quantile = (probability) =>
  1000 *
  logLogisticQuantile(
    probability,
    models.download.median,
    models.download.shape,
  );

bars.market.scale = centTicks;
bars.market.quantile = (probability) =>
  logisticQuantile(probability, models.market.median, models.market.scale);
bars.market.format = (value) => currencyFormatter.format(value);

bars.recovery.scale = minuteTicks;
bars.recovery.quantile = (probability) =>
  1000 *
  logLogisticQuantile(
    probability,
    models.recovery.median,
    models.recovery.shape,
  );

interface ServiceDefinition {
  name: string;
  region: string;
  color: string;
  median: number;
  phase: number;
}

interface Service extends ServiceDefinition {
  bar: QBarElement;
  model: { median: number; shape: number };
  p95: HTMLElement;
}

const serviceDefinitions: ServiceDefinition[] = [
  {
    name: "Search API",
    region: "fra-1",
    color: "#ff9eb5",
    median: 82,
    phase: 0.2,
  },
  {
    name: "Checkout",
    region: "ams-2",
    color: "#76d7ff",
    median: 138,
    phase: 1.4,
  },
  {
    name: "Vector index",
    region: "hel-1",
    color: "#c9a7ff",
    median: 205,
    phase: 2.6,
  },
  {
    name: "Media edge",
    region: "global",
    color: "#8de8b2",
    median: 44,
    phase: 3.7,
  },
];

const servicesRoot = element("services");
const services: Service[] = serviceDefinitions.map((definition, index) => {
  const row = document.createElement("article");
  row.className = "service";
  row.innerHTML = `
    <h3 class="service__name">
      ${definition.name}
      <span class="service__region">${definition.region}</span>
    </h3>
    <q-bar
      id="service-bar-${index}"
      orientation="horizontal"
      style="--service-color: ${definition.color}"
    ></q-bar>
    <output class="service__p95" id="service-p95-${index}">—</output>
  `;
  servicesRoot.append(row);

  const serviceBar = bar(`service-bar-${index}`);
  const model = { median: definition.median, shape: 5 };
  serviceBar.scale = wholeTicks;
  serviceBar.quantile = (probability) =>
    logLogisticQuantile(probability, model.median, model.shape);
  serviceBar.format = (value) => `${Math.round(value)}ms`;

  return {
    ...definition,
    bar: serviceBar,
    model,
    p95: element(`service-p95-${index}`),
  };
});

const uncertaintyInput = element("uncertainty") as HTMLInputElement;
const uncertaintyOutput = element("uncertainty-value") as HTMLOutputElement;
const pauseButton = element("pause") as HTMLButtonElement;
const shockButton = element("shock") as HTMLButtonElement;

let paused = reduceMotion;
let simulationTime = 0;
let disruption = 0;
let uncertainty = Number(uncertaintyInput.value);
let previousFrame = performance.now();
let previousPaint = -Infinity;

function setPaused(value: boolean): void {
  paused = value;
  document.body.classList.toggle("paused", paused);
  pauseButton.textContent = paused ? "Resume" : "Pause";
  pauseButton.setAttribute("aria-pressed", String(paused));
}

pauseButton.addEventListener("click", () => setPaused(!paused));

shockButton.addEventListener("click", () => {
  disruption = 1;
  shockButton.textContent = "Disruption injected";
  window.setTimeout(() => {
    shockButton.textContent = "Inject disruption";
  }, 1000);
});

uncertaintyInput.addEventListener("input", () => {
  uncertainty = Number(uncertaintyInput.value);
  uncertaintyOutput.value = `${uncertainty.toFixed(2)}×`;
});

function updateConnection(time: number): void {
  const cycle = (time % 40) / 40;
  const journeyProgress = cycle * 8;
  const trafficWave = 0.5 + 0.5 * Math.sin(time * 0.58);
  const medianMinutes =
    10.8 - journeyProgress + 0.28 * Math.sin(time * 0.33) + disruption * 2.1;
  const scaleSeconds = (14 + trafficWave * 28 + disruption * 105) * uncertainty;

  models.connection.median = baseTime + medianMinutes * minute;
  models.connection.scale = Math.max(4_000, scaleSeconds * 1000);

  const probability = logisticCdf(
    connectionDeparture,
    models.connection.median,
    models.connection.scale,
  );
  const lower = bars.connection.quantile!(0.1);
  const upper = bars.connection.quantile!(0.9);

  text(
    "connection-value",
    shortTimeFormatter.format(new Date(models.connection.median)),
  );
  text(
    "connection-context",
    `Connection departs ${shortTimeFormatter.format(new Date(connectionDeparture))}`,
  );
  text(
    "connection-probability",
    `${percent(probability)} chance of making the connection`,
  );
  text(
    "connection-window",
    formatWindow(lower, upper, (value) =>
      shortTimeFormatter.format(new Date(value)),
    ),
  );
  text("connection-spread", `${Math.round((upper - lower) / 1000)} seconds`);
}

function updateDownload(time: number): void {
  const cycle = (time % 34) / 34;
  const remainingFraction = Math.max(0.008, 1 - cycle);
  const networkWave =
    46 + 11 * Math.sin(time * 0.73) + 5 * Math.sin(time * 1.91);
  const throughput = Math.max(5, networkWave - disruption * 31);
  const remainingGigabytes = 38.4 * remainingFraction;
  const deterministicSeconds = (remainingGigabytes * 8 * 1000) / throughput;

  models.download.median = Math.max(1.5, deterministicSeconds);
  models.download.shape = Math.max(
    1.35,
    6.5 / (uncertainty * (1 + disruption * 1.8)),
  );

  const lower = bars.download.quantile!(0.1) / 1000;
  const upper = bars.download.quantile!(0.9) / 1000;
  const underMinute =
    1 / (1 + (models.download.median / 60) ** models.download.shape);

  text("download-value", formatDuration(models.download.median));
  text("download-context", `${throughput.toFixed(1)} MB/s current throughput`);
  text(
    "download-probability",
    `${percent(underMinute)} chance of finishing within one minute`,
  );
  text(
    "download-window",
    formatWindow(lower, upper, (value) => formatDuration(value)),
  );
  text(
    "download-remaining",
    `${compactBytesFormatter.format(remainingGigabytes)} GB`,
  );
}

function updateMarket(time: number): void {
  const wave = Math.sin(time * 0.29);
  const microstructure = Math.sin(time * 1.7) * 0.16;
  const volatilityWave = 0.5 + 0.5 * Math.sin(time * 0.47 + 1.2);

  models.market.median = 184.2 + wave * 2.4 + microstructure + disruption * 0.8;
  models.market.scale =
    (0.12 + volatilityWave * 0.38 + disruption * 1.1) * uncertainty;

  const lower = bars.market.quantile!(0.1);
  const upper = bars.market.quantile!(0.9);
  const below185 = logisticCdf(185, models.market.median, models.market.scale);

  text("market-value", currencyFormatter.format(models.market.median));
  text(
    "market-probability",
    `${percent(below185)} chance of executing below $185`,
  );
  text(
    "market-window",
    formatWindow(lower, upper, (value) => currencyFormatter.format(value)),
  );
  text(
    "market-state",
    models.market.scale > 0.8
      ? "elevated"
      : models.market.scale > 0.35
        ? "active"
        : "quiet",
  );
}

function updateRecovery(time: number): void {
  const cycle = time % 52;
  const baselineMinutes = Math.max(3.2, 27 - cycle * 0.43);

  models.recovery.median = (baselineMinutes + disruption * 13) * 60;
  models.recovery.shape = Math.max(
    1.25,
    4.2 / (uncertainty * (1 + disruption * 1.2)),
  );

  const lower = bars.recovery.quantile!(0.1) / 1000;
  const upper = bars.recovery.quantile!(0.9) / 1000;
  const p90 = upper;
  const within30 =
    1 / (1 + (models.recovery.median / (30 * 60)) ** models.recovery.shape);

  text("recovery-value", formatDuration(models.recovery.median, true));
  text(
    "recovery-probability",
    `${percent(within30)} chance of recovery within 30 minutes`,
  );
  text(
    "recovery-window",
    formatWindow(lower, upper, (value) => formatDuration(value, true)),
  );
  text("recovery-tail", `${(p90 / models.recovery.median).toFixed(1)}×`);
}

function updateServices(time: number): void {
  for (const service of services) {
    const movement =
      1 +
      0.14 * Math.sin(time * 0.72 + service.phase) +
      0.05 * Math.sin(time * 2.1 + service.phase);
    service.model.median = service.median * movement * (1 + disruption * 0.35);
    service.model.shape = Math.max(
      1.4,
      7 / (uncertainty * (1 + disruption * 1.4)),
    );

    const p95 = service.bar.quantile!(0.95);
    service.p95.textContent = `${Math.round(p95)} ms`;
  }
}

function paint(): void {
  updateConnection(simulationTime);
  updateDownload(simulationTime);
  updateMarket(simulationTime);
  updateRecovery(simulationTime);
  updateServices(simulationTime);

  for (const b of [...Object.values(bars), ...services.map(({ bar }) => bar)]) {
    b.refresh();
  }
}

function frame(now: number): void {
  const delta = Math.min(0.1, (now - previousFrame) / 1000);
  previousFrame = now;

  if (!paused) {
    simulationTime += delta;
    disruption = Math.max(0, disruption - delta * 0.055);
  }

  const paintInterval = reduceMotion ? 500 : 50;
  if (now - previousPaint >= paintInterval) {
    previousPaint = now;
    paint();
  }

  requestAnimationFrame(frame);
}

setPaused(paused);
paint();
requestAnimationFrame(frame);
