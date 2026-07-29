import { rasterizeQuantiles } from "./rasterize.js";
import type {
  QuantileFunction,
  TickSource,
  VisibilityFunction,
} from "./types.js";

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

export type TickFormatter = (value: number, level: number) => string;

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 6,
});

function defaultTickFormatter(value: number): string {
  return numberFormatter.format(value);
}

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

/**
 * Framework-independent SVG renderer for a quantile raster.
 *
 * The component deliberately accepts functions and objects as properties,
 * rather than trying to serialize distributions into HTML attributes.
 */
export class QBarElement extends HTMLElementBase {
  static readonly observedAttributes = ["orientation"];

  #quantile: QuantileFunction | undefined;
  #tickSource: TickSource | undefined;
  #visibility: VisibilityFunction | undefined;
  #formatTick: TickFormatter = defaultTickFormatter;
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

  get quantile(): QuantileFunction | undefined {
    return this.#quantile;
  }

  set quantile(value: QuantileFunction | undefined) {
    this.#quantile = value;
    this.refresh();
  }

  get tickSource(): TickSource | undefined {
    return this.#tickSource;
  }

  set tickSource(value: TickSource | undefined) {
    this.#tickSource = value;
    this.refresh();
  }

  get visibility(): VisibilityFunction | undefined {
    return this.#visibility;
  }

  set visibility(value: VisibilityFunction | undefined) {
    this.#visibility = value;
    this.refresh();
  }

  get formatTick(): TickFormatter {
    return this.#formatTick;
  }

  set formatTick(value: TickFormatter) {
    this.#formatTick = value;
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

    if (!this.#quantile || !this.#tickSource) return;

    const rasterOptions = {
      width: length,
      quantile: this.#quantile,
      ticks: this.#tickSource,
      ...(this.#visibility ? { visibility: this.#visibility } : {}),
    };
    const raster = rasterizeQuantiles(rasterOptions);
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < length; index += 1) {
      const value = raster.values[index]!;
      const opacity = raster.visibility[index]!;

      if (!Number.isFinite(opacity) || opacity < MINIMUM_VISIBLE_OPACITY) {
        continue;
      }

      const level = raster.levels[index]!;
      const position = vertical ? length - index - 0.5 : index + 0.5;
      fragment.append(
        vertical
          ? this.#verticalTick(position, value, level, opacity)
          : this.#horizontalTick(position, value, level, opacity),
      );
    }

    this.#ticks.append(fragment);

    const currentAriaLabel = this.getAttribute("aria-label");
    const ownsAriaLabel =
      currentAriaLabel === null ||
      currentAriaLabel === this.#generatedAriaLabel;
    const median = this.#quantile(0.5);

    if (ownsAriaLabel && Number.isFinite(median)) {
      this.#generatedAriaLabel = `Distribution with median ${this.#formatTick(
        median,
        Number.NaN,
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

  #verticalTick(
    position: number,
    value: number,
    level: number,
    opacity: number,
  ): SVGGElement {
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
    label.textContent = this.#formatTick(value, level);

    group.append(line, label);
    return group;
  }

  #horizontalTick(
    position: number,
    value: number,
    level: number,
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
    label.textContent = this.#formatTick(value, level);

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
