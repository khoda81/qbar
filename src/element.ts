import { layoutTicks, type Quantile, type Tick } from "./layout.js";
import type { TickScale } from "./scale.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MINIMUM_VISIBLE_OPACITY = 1 / 255;
const HTMLElementBase =
  typeof HTMLElement === "undefined"
    ? (class {} as unknown as typeof HTMLElement)
    : HTMLElement;

const styles = `
  :host {
    box-sizing: border-box;
    color: inherit;
    contain: size layout style;
    display: inline-block;
    height: 10rem;
    min-height: 1px;
    min-width: 1px;
    vertical-align: top;
    width: 7rem;
  }

  :host([orientation="horizontal"]) {
    height: 7rem;
    width: 10rem;
  }

  svg {
    display: block;
    height: 100%;
    overflow: visible;
    width: 100%;
  }

  [part="axis"],
  [part="tick"] {
    fill: none;
    stroke: var(--qbar-color, currentColor);
    vector-effect: non-scaling-stroke;
  }

  [part="axis"] {
    opacity: var(--qbar-axis-opacity, 0.25);
  }

  [part="label"] {
    fill: var(--qbar-color, currentColor);
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
`;

export type QBarOrientation = "vertical" | "horizontal";

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function setAttributes(
  element: Element,
  attributes: Readonly<Record<string, string | number>>,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
}

function numberAttribute(
  element: Element,
  name: string,
  fallback: number,
): number {
  const value = element.getAttribute(name);
  return value === null ? fallback : Number(value);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return edge0 <= value ? 1 : 0;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Framework-independent SVG renderer for density-aware ticks.
 *
 * Distributions and scales are properties, not attributes, because they are
 * functions and objects. Tick opacity rises from 0 at `min-spacing` pixels of
 * room to 1 at `full-spacing`.
 */
export class QBarElement<Step = unknown> extends HTMLElementBase {
  static readonly observedAttributes = [
    "orientation",
    "min-spacing",
    "full-spacing",
  ];

  #quantile: Quantile | undefined;
  #density: ((probability: number) => number) | undefined;
  #scale: TickScale<Step> | undefined;
  #format: ((value: number, step: Step) => string) | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #frame: number | undefined;
  #generatedAriaLabel: string | undefined;
  readonly #svg: SVGSVGElement;
  readonly #axis: SVGLineElement;
  readonly #ticks: SVGGElement;

  constructor() {
    super();

    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;

    this.#svg = svgElement("svg");
    this.#svg.setAttribute("aria-hidden", "true");

    this.#axis = svgElement("line");
    this.#axis.setAttribute("part", "axis");

    this.#ticks = svgElement("g");
    this.#ticks.setAttribute("part", "ticks");

    this.#svg.append(this.#axis, this.#ticks);
    shadow.append(style, this.#svg);
  }

  get quantile(): Quantile | undefined {
    return this.#quantile;
  }

  set quantile(value: Quantile | undefined) {
    this.#quantile = value;
    this.refresh();
  }

  /** Optional probability density at Q(p); see LayoutOptions.density. */
  get density(): ((probability: number) => number) | undefined {
    return this.#density;
  }

  set density(value: ((probability: number) => number) | undefined) {
    this.#density = value;
    this.refresh();
  }

  get scale(): TickScale<Step> | undefined {
    return this.#scale;
  }

  set scale(value: TickScale<Step> | undefined) {
    this.#scale = value;
    this.refresh();
  }

  /** Overrides the scale's own label format. */
  get format(): ((value: number, step: Step) => string) | undefined {
    return this.#format;
  }

  set format(value: ((value: number, step: Step) => string) | undefined) {
    this.#format = value;
    this.refresh();
  }

  get orientation(): QBarOrientation {
    return this.getAttribute("orientation") === "horizontal"
      ? "horizontal"
      : "vertical";
  }

  set orientation(value: QBarOrientation) {
    if (value === "vertical") {
      this.removeAttribute("orientation");
    } else if (value === "horizontal") {
      this.setAttribute("orientation", value);
    } else {
      throw new TypeError(`unsupported qbar orientation: ${String(value)}`);
    }
  }

  connectedCallback(): void {
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "img");
    }

    this.#resizeObserver = new ResizeObserver(() => this.refresh());
    this.#resizeObserver.observe(this);
    this.refresh();
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;

    if (this.#frame !== undefined) {
      cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
    }
  }

  attributeChangedCallback(): void {
    this.refresh();
  }

  /**
   * Schedules a new rasterization after mutable model state changes.
   */
  refresh(): void {
    if (!this.isConnected || this.#frame !== undefined) return;

    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      this.#render();
    });
  }

  #render(): void {
    const rect = this.getBoundingClientRect();
    const orientation = this.orientation;
    const vertical = orientation === "vertical";
    const length = Math.max(1, Math.round(vertical ? rect.height : rect.width));
    const crossLength = Math.max(
      1,
      Math.round(vertical ? rect.width : rect.height),
    );

    setAttributes(this.#svg, {
      viewBox: `0 0 ${vertical ? crossLength : length} ${
        vertical ? length : crossLength
      }`,
      preserveAspectRatio: "none",
    });

    this.#renderAxis(length, vertical);
    this.#ticks.replaceChildren();

    const quantile = this.#quantile;
    const scale = this.#scale;
    if (quantile === undefined || scale === undefined) return;

    const minSpacing = numberAttribute(this, "min-spacing", 24);
    const fullSpacing = numberAttribute(this, "full-spacing", 64);
    const format =
      this.#format ??
      ((value: number, step: Step) => scale.format(value, step));
    const ticks = layoutTicks({
      quantile,
      scale,
      width: length,
      minSpacing,
      ...(this.#density === undefined ? {} : { density: this.#density }),
    });
    const fragment = document.createDocumentFragment();
    // The step of the tick nearest the middle gives the median's precision.
    let middle: Tick<Step> | undefined;

    for (const tick of ticks) {
      const offset = Math.abs(tick.position - length / 2);
      if (
        middle === undefined ||
        offset < Math.abs(middle.position - length / 2)
      ) {
        middle = tick;
      }

      const opacity = smoothstep(minSpacing, fullSpacing, tick.spacing);
      if (opacity < MINIMUM_VISIBLE_OPACITY) continue;

      const label = format(tick.value, tick.step);
      fragment.append(
        vertical
          ? this.#verticalTick(length - tick.position, label, opacity)
          : this.#horizontalTick(tick.position, label, opacity),
      );
    }

    this.#ticks.append(fragment);

    const currentAriaLabel = this.getAttribute("aria-label");
    const ownsAriaLabel =
      currentAriaLabel === null ||
      currentAriaLabel === this.#generatedAriaLabel;
    const median = quantile(0.5);

    if (ownsAriaLabel && Number.isFinite(median) && middle !== undefined) {
      this.#generatedAriaLabel = `Distribution with median ${format(
        median,
        middle.step,
      )}`;
      this.setAttribute("aria-label", this.#generatedAriaLabel);
    }
  }

  #renderAxis(length: number, vertical: boolean): void {
    if (vertical) {
      setAttributes(this.#axis, {
        x1: 0.5,
        x2: 0.5,
        y1: 0,
        y2: length,
      });
    } else {
      setAttributes(this.#axis, {
        x1: 0,
        x2: length,
        y1: 0.5,
        y2: 0.5,
      });
    }
  }

  #verticalTick(position: number, text: string, opacity: number): SVGGElement {
    const group = svgElement("g");
    group.setAttribute("opacity", String(opacity));

    const line = svgElement("line");
    line.setAttribute("part", "tick");
    setAttributes(line, {
      x1: 0.5,
      x2: 8.5,
      y1: position,
      y2: position,
    });

    const label = svgElement("text");
    label.setAttribute("part", "label");
    setAttributes(label, {
      x: 12.5,
      y: position,
      "dominant-baseline": "middle",
      "text-anchor": "start",
    });
    label.textContent = text;

    group.append(line, label);
    return group;
  }

  #horizontalTick(
    position: number,
    text: string,
    opacity: number,
  ): SVGGElement {
    const group = svgElement("g");
    group.setAttribute("opacity", String(opacity));

    const line = svgElement("line");
    line.setAttribute("part", "tick");
    setAttributes(line, {
      x1: position,
      x2: position,
      y1: 0.5,
      y2: 8.5,
    });

    const label = svgElement("text");
    label.setAttribute("part", "label");
    setAttributes(label, {
      transform: `translate(${position} 12.5) rotate(90)`,
      "dominant-baseline": "middle",
      "text-anchor": "start",
    });
    label.textContent = text;

    group.append(line, label);
    return group;
  }
}

/**
 * Registers QBarElement without introducing an import-time global side effect.
 */
export function defineQBar(tagName = "q-bar"): typeof QBarElement {
  const existing = customElements.get(tagName);

  if (existing && existing !== QBarElement) {
    throw new DOMException(
      `a different custom element is already registered as <${tagName}>`,
      "NotSupportedError",
    );
  }

  if (!existing) {
    customElements.define(tagName, QBarElement);
  }

  return QBarElement;
}
