import { layoutTicks, locate, type Quantile, type Tick } from "./layout.js";
import type { Selection, TickScale } from "./scale.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** One step of 8-bit alpha: fainter ticks, and smaller fades, don't show. */
const MINIMUM_VISIBLE_OPACITY = 1 / 255;
/**
 * Tick moves below this many device pixels don't show: a still frame can't
 * resolve them, and motion built from such steps reads as continuous.
 */
const MINIMUM_VISIBLE_SHIFT = 1 / 4;
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

/** A tick as drawn; its position is in SVG pixels along the axis. */
interface Mark {
  readonly position: number;
  readonly label: string;
  readonly opacity: number;
}

interface Drawing {
  /** Pixels along the bar. */
  readonly length: number;
  /** Pixels across it. */
  readonly crossLength: number;
  readonly vertical: boolean;
  readonly marks: readonly Mark[];
}

/** Whether drawing b over a would show any difference. */
function looksSame(a: Drawing, b: Drawing): boolean {
  const shift = MINIMUM_VISIBLE_SHIFT / devicePixelRatio;
  return (
    a.length === b.length &&
    a.crossLength === b.crossLength &&
    a.vertical === b.vertical &&
    a.marks.length === b.marks.length &&
    a.marks.every((mark, index) => {
      const other = b.marks[index]!;
      return (
        mark.label === other.label &&
        Math.abs(mark.position - other.position) < shift &&
        Math.abs(mark.opacity - other.opacity) < MINIMUM_VISIBLE_OPACITY
      );
    })
  );
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
 *
 * Every change is laid out again, but the SVG is rebuilt only when a tick
 * would visibly move, fade or change its label. Replacing the quantile each
 * animation frame, as times counted from a moving now need, is therefore
 * cheap while the ticks crawl.
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
  /** What the SVG shows; undefined before the first render. */
  #drawing: Drawing | undefined;
  readonly #svg: SVGSVGElement;
  readonly #axis: SVGLineElement;
  readonly #ticks: SVGGElement;

  constructor() {
    super();

    // Focusing the host, as a <label> click does, reaches its first thumb.
    const shadow = this.attachShadow({ mode: "open", delegatesFocus: true });
    const style = document.createElement("style");
    style.textContent = styles;

    this.#svg = svgElement("svg");
    this.#svg.setAttribute("aria-hidden", "true");
    this.#svg.setAttribute("preserveAspectRatio", "none");

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
   * Schedules a new layout after mutable model state changes.
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
    const vertical = this.orientation === "vertical";
    const length = Math.max(1, Math.round(vertical ? rect.height : rect.width));
    const crossLength = Math.max(
      1,
      Math.round(vertical ? rect.width : rect.height),
    );

    const quantile = this.#quantile;
    const scale = this.#scale;
    if (quantile === undefined || scale === undefined) {
      this.#paint({ length, crossLength, vertical, marks: [] });
      this.rendered([], length);
      return;
    }

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
    const marks: Mark[] = [];
    for (const tick of ticks) {
      const opacity = smoothstep(minSpacing, fullSpacing, tick.spacing);
      if (opacity < MINIMUM_VISIBLE_OPACITY) continue;
      marks.push({
        position: vertical ? length - tick.position : tick.position,
        label: format(tick.value, tick.step),
        opacity,
      });
    }
    this.#paint({ length, crossLength, vertical, marks });

    const currentAriaLabel = this.getAttribute("aria-label");
    const ownsAriaLabel =
      currentAriaLabel === null ||
      currentAriaLabel === this.#generatedAriaLabel;
    const median = quantile(0.5);
    // The step of the tick nearest the middle gives the median's precision.
    const middle = nearest(ticks, length / 2);

    if (
      this.getAttribute("role") === "img" &&
      ownsAriaLabel &&
      Number.isFinite(median) &&
      middle !== undefined
    ) {
      const label = `Distribution with median ${format(median, middle.step)}`;
      this.#generatedAriaLabel = label;
      if (currentAriaLabel !== label) this.setAttribute("aria-label", label);
    }
    this.rendered(ticks, length);
  }

  /**
   * Rebuilds the SVG unless the new drawing would look the same. Comparing
   * with what is shown, rather than with the last layout, keeps slow drift
   * from accumulating unseen.
   */
  #paint(drawing: Drawing): void {
    if (this.#drawing !== undefined && looksSame(this.#drawing, drawing)) {
      return;
    }
    this.#drawing = drawing;

    const { length, crossLength, vertical, marks } = drawing;
    this.#svg.setAttribute(
      "viewBox",
      vertical
        ? `0 0 ${crossLength} ${length}`
        : `0 0 ${length} ${crossLength}`,
    );
    this.#renderAxis(length, vertical);
    this.#ticks.replaceChildren(
      ...marks.map(({ position, label, opacity }) =>
        vertical
          ? this.#verticalTick(position, label, opacity)
          : this.#horizontalTick(position, label, opacity),
      ),
    );
  }

  /** Called after each layout with its ticks and the bar length in pixels. */
  protected rendered(_ticks: readonly Tick<Step>[], _length: number): void {}

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

const trackStyles = `
  :host {
    cursor: pointer;
    position: relative;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }

  [part~="thumb"] {
    background: var(--qbar-color, currentColor);
    border: 2px solid var(--qbar-thumb-border, Canvas);
    border-radius: 50%;
    box-sizing: border-box;
    height: var(--qbar-thumb-size, 1rem);
    outline: none;
    pointer-events: none;
    position: absolute;
    transform: translate(-50%, -50%);
    width: var(--qbar-thumb-size, 1rem);
  }

  [part~="thumb"]:focus-visible {
    box-shadow: 0 0 0 3px var(--qbar-color, currentColor);
  }

  [part~="thumb"][hidden] {
    display: none;
  }

  :host(:disabled) {
    cursor: default;
    opacity: 0.5;
  }
`;

/**
 * A bar with ordered thumbs whose positions are probabilities and whose
 * values are the quantile there: a non-linear track with density-aware
 * ticks. Each thumb is a focusable `role="slider"`.
 *
 * Dragging moves the nearest thumb and picks the nicest value within half a
 * pixel of the pointer, the coarsest tick the scale has there, so values
 * read like 0.5 or 12 rather than 11.9837. Thumbs never pass each other.
 * With the `snap` attribute a thumb also jumps to fully visible ticks within
 * 8 pixels. Arrow keys step between fully visible ticks; Shift, PageUp and
 * PageDown move a tenth of the track.
 *
 * Like `<input type="range">` it fires `input` while values change through
 * interaction and `change` when the interaction ends; setting values fires
 * neither.
 *
 * It is a form control. With a `name`, a form submits each value under it,
 * as raw numbers rather than labels; a range repeats the name, like
 * `<select multiple>`. Reset restores the defaults; `disabled` (or a
 * disabled fieldset) stops interaction and submission; `required` blocks
 * submitting without values; a `<label for>` names and focuses the thumbs.
 */
export abstract class QTrackElement<Step = unknown> extends QBarElement<Step> {
  static readonly formAssociated = true;
  static override readonly observedAttributes = [
    ...QBarElement.observedAttributes,
    "snap",
    "aria-label",
    "name",
    "required",
  ];

  /** Ascending; empty or one per thumb. */
  #values: readonly number[] = [];
  /** What a form reset restores; the same shape as the values. */
  #defaults: readonly number[] = [];
  /** Set by the form, from the disabled attribute or a disabled fieldset. */
  #disabled = false;
  readonly #internals: ElementInternals;
  #ticks: readonly Tick<Step>[] = [];
  #length = 1;
  #initial: readonly number[] = [];
  /** The thumb under the pointer while it is captured. */
  #dragging: number | undefined;
  readonly #names: readonly string[];
  readonly #thumbs: readonly HTMLDivElement[];

  /** One thumb per name; a name tells the thumbs of a range apart. */
  constructor(names: readonly string[]) {
    super();
    this.#names = names;
    this.#internals = this.attachInternals();

    const style = document.createElement("style");
    style.textContent = trackStyles;
    this.#thumbs = names.map((_, index) => {
      const thumb = document.createElement("div");
      thumb.setAttribute("part", `thumb thumb-${index}`);
      thumb.setAttribute("role", "slider");
      thumb.tabIndex = 0;
      thumb.hidden = true;
      thumb.addEventListener("keydown", (event) => this.#key(index, event));
      return thumb;
    });
    this.shadowRoot!.append(style, ...this.#thumbs);

    this.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.#disabled || !this.quantile) return;
      const position = this.#pointer(event);
      const index = this.#nearestThumb(position);
      if (index === undefined) return;
      event.preventDefault();
      this.setPointerCapture(event.pointerId);
      this.#thumbs[index]!.focus();
      this.#initial = this.#values;
      this.#dragging = index;
      this.#move(index, position);
    });
    this.addEventListener("pointermove", (event) => {
      if (this.#dragging !== undefined) {
        this.#move(this.#dragging, this.#pointer(event));
      }
    });
    this.addEventListener("lostpointercapture", () => {
      this.#dragging = undefined;
      if (this.#initial !== this.#values) this.#emit("change");
    });
  }

  protected get thumbValues(): readonly number[] {
    return this.#values;
  }

  protected set thumbValues(values: readonly number[]) {
    this.#values = this.#checked(values);
    this.#syncForm();
    this.#draw();
  }

  protected get defaultThumbValues(): readonly number[] {
    return this.#defaults;
  }

  protected set defaultThumbValues(values: readonly number[]) {
    this.#defaults = this.#checked(values);
  }

  /** The submission name; values are submitted only when it is set. */
  get name(): string {
    return this.getAttribute("name") ?? "";
  }

  set name(name: string) {
    this.setAttribute("name", name);
  }

  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }

  set disabled(disabled: boolean) {
    this.toggleAttribute("disabled", disabled);
  }

  get required(): boolean {
    return this.hasAttribute("required");
  }

  set required(required: boolean) {
    this.toggleAttribute("required", required);
  }

  get form(): HTMLFormElement | null {
    return this.#internals.form;
  }

  get validity(): ValidityState {
    return this.#internals.validity;
  }

  get validationMessage(): string {
    return this.#internals.validationMessage;
  }

  checkValidity(): boolean {
    return this.#internals.checkValidity();
  }

  reportValidity(): boolean {
    return this.#internals.reportValidity();
  }

  formResetCallback(): void {
    this.thumbValues = this.#defaults;
  }

  formDisabledCallback(disabled: boolean): void {
    this.#disabled = disabled;
    for (const thumb of this.#thumbs) thumb.tabIndex = disabled ? -1 : 0;
    this.#draw();
  }

  /** Restores what #syncForm saved, as on navigating back to the page. */
  formStateRestoreCallback(state: string | File | FormData | null): void {
    if (typeof state !== "string") return;
    this.thumbValues = state === "" ? [] : state.split(" ").map(Number);
  }

  override attributeChangedCallback(): void {
    super.attributeChangedCallback();
    this.#syncForm();
  }

  #checked(values: readonly number[]): readonly number[] {
    if (values.length !== 0 && values.length !== this.#thumbs.length) {
      throw new RangeError(
        `expected ${this.#thumbs.length} values; got ${values.length}`,
      );
    }
    for (const [index, value] of values.entries()) {
      if (Number.isNaN(value)) throw new RangeError("slider value is NaN");
      if (0 < index && value < values[index - 1]!) {
        throw new RangeError(`slider values must ascend; got ${values}`);
      }
    }
    return values;
  }

  /** The form value and validity follow the values, name and required. */
  #syncForm(): void {
    const values = this.#values;
    const name = this.getAttribute("name");
    let data: FormData | null = null;
    if (name !== null && values.length !== 0) {
      data = new FormData();
      for (const value of values) data.append(name, String(value));
    }
    this.#internals.setFormValue(data, values.join(" "));

    const missing = this.hasAttribute("required") && values.length === 0;
    this.#internals.setValidity(
      missing ? { valueMissing: true } : {},
      missing ? "Select a value." : "",
      this.#thumbs[0],
    );
  }

  /** A value formatted at the precision the track resolves where it sits. */
  protected labelOf(value: number): string | undefined {
    const scale = this.scale;
    if (scale === undefined) return undefined;
    if (!Number.isFinite(value)) return value < 0 ? "−∞" : "∞";

    // The coarsest step having the value as a tick shows it exactly: typed
    // 62.537 stays 62.537. Raw quantile floats would need many more digits
    // than the track resolves, so beyond three decades they are rounded to
    // the track's resolution at their pixel instead.
    const position = this.#position(value);
    const resolved = this.#nicest(position);
    const delta = Math.abs(value) * 1e-12 || 1e-300;
    const own = scale.select(value - delta, value);
    const exact =
      own?.value === value &&
      (resolved === undefined || resolved.size <= own.size * 1000);
    const step =
      (exact ? own : resolved)?.step ?? nearest(this.#ticks, position)?.step;
    if (step === undefined) return String(value);
    return this.format ? this.format(value, step) : scale.format(value, step);
  }

  override connectedCallback(): void {
    if (!this.hasAttribute("role")) this.setAttribute("role", "group");
    super.connectedCallback();
  }

  protected override rendered(
    ticks: readonly Tick<Step>[],
    length: number,
  ): void {
    this.#ticks = ticks;
    this.#length = length;
    this.#draw();
  }

  /** Pixels along the track, from the p = 0 end. */
  #position(value: number): number {
    const quantile = this.quantile;
    if (quantile === undefined || value === -Infinity) return 0;
    if (value === Infinity) return this.#length;
    return (
      locate(quantile, this.#length, value) ??
      (value < quantile(0) ? 0 : this.#length)
    );
  }

  /** The coarsest tick within half a pixel of a position. */
  #nicest(position: number): Selection<Step> | undefined {
    const quantile = this.quantile;
    const scale = this.scale;
    if (quantile === undefined || scale === undefined) return undefined;
    const length = this.#length;
    const lower = quantile(Math.max(0, position - 0.5) / length);
    const upper = quantile(Math.min(length, position + 0.5) / length);
    return -Infinity < lower && lower < upper && upper < Infinity
      ? scale.select(lower, upper)
      : undefined;
  }

  /** Ticks with at least half their full opacity: where thumbs stop. */
  #stops(): Tick<Step>[] {
    const threshold =
      (numberAttribute(this, "min-spacing", 24) +
        numberAttribute(this, "full-spacing", 64)) /
      2;
    return this.#ticks.filter(({ spacing }) => threshold <= spacing);
  }

  /** The thumb a press at this position grabs; a lone thumb appears there. */
  #nearestThumb(position: number): number | undefined {
    if (this.#values.length === 0) {
      return this.#thumbs.length === 1 ? 0 : undefined;
    }
    let best = 0;
    let bestDistance = Infinity;
    for (const [index, value] of this.#values.entries()) {
      const offset = position - this.#position(value);
      // On ties, a press past stacked thumbs takes the last of them.
      if (
        Math.abs(offset) < bestDistance ||
        (0 <= offset && Math.abs(offset) === bestDistance)
      ) {
        best = index;
        bestDistance = Math.abs(offset);
      }
    }
    return best;
  }

  /** Moves a thumb to a position, between its neighbours. */
  #move(index: number, position: number): void {
    const quantile = this.quantile;
    if (quantile === undefined) return;
    const length = this.#length;
    const clamped = Math.min(length, Math.max(0, position));

    const snapped = this.hasAttribute("snap")
      ? nearest(this.#stops(), clamped)
      : undefined;
    const picked =
      snapped !== undefined && Math.abs(snapped.position - clamped) <= 8
        ? snapped.value
        : clamped === 0 || clamped === length
          ? quantile(clamped / length)
          : (this.#nicest(clamped)?.value ?? quantile(clamped / length));

    const values = this.#values.length === 0 ? [picked] : [...this.#values];
    const value = Math.min(
      values[index + 1] ?? Infinity,
      Math.max(values[index - 1] ?? -Infinity, picked),
    );
    if (value === this.#values[index]) return;
    values[index] = value;
    this.thumbValues = values;
    this.#emit("input");
  }

  #key(index: number, event: KeyboardEvent): void {
    if (this.#disabled) return;
    const value = this.#values[index];
    const length = this.#length;
    const position = value === undefined ? 0 : this.#position(value);
    const forward = ["ArrowRight", "ArrowUp", "PageUp", "End"].includes(
      event.key,
    );
    const large = event.shiftKey || event.key.startsWith("Page");
    let target: number;

    if (event.key === "Home" || event.key === "End") {
      target = forward ? length : 0;
    } else if (event.key.startsWith("Arrow") || event.key.startsWith("Page")) {
      const direction = forward ? 1 : -1;
      const stops = forward ? this.#stops() : this.#stops().reverse();
      const next = large
        ? undefined
        : stops.find((tick) => 0.5 < direction * (tick.position - position));
      target =
        next?.position ?? position + direction * length * (large ? 0.1 : 0.01);
    } else {
      return;
    }

    event.preventDefault();
    const before = this.#values;
    this.#move(index, target);
    if (before !== this.#values) this.#emit("change");
  }

  #pointer(event: PointerEvent): number {
    const rect = this.getBoundingClientRect();
    return this.orientation === "vertical"
      ? ((rect.bottom - event.clientY) / rect.height) * this.#length
      : ((event.clientX - rect.left) / rect.width) * this.#length;
  }

  #emit(type: "input" | "change"): void {
    this.dispatchEvent(new Event(type, { bubbles: true }));
  }

  /** The host's accessible name, which labels its thumbs. */
  #name(): string {
    const label = this.getAttribute("aria-label");
    if (label !== null) return label;
    const labelledBy = (this.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id));
    return [...labelledBy, ...this.#internals.labels]
      .map((element) => element?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
  }

  #draw(): void {
    const vertical = this.orientation === "vertical";
    const name = this.#name();

    for (const [index, thumb] of this.#thumbs.entries()) {
      const value = this.#values[index];
      thumb.hidden = value === undefined || this.quantile === undefined;
      if (value === undefined) continue;

      const position = this.#position(value);
      const offset = `${(position / this.#length) * 100}%`;
      thumb.style.left = vertical ? "0.5px" : offset;
      thumb.style.top = vertical ? `calc(100% - ${offset})` : "0.5px";
      setAttributes(thumb, {
        "aria-label": [name, this.#names[index]].filter(Boolean).join(" "),
        "aria-disabled": String(this.#disabled),
        "aria-orientation": this.orientation,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": ((position / this.#length) * 100).toFixed(1),
        "aria-valuetext": this.labelOf(value) ?? String(value),
      });
    }
  }
}

/** A one-thumb track; see QTrackElement. */
export class QSliderElement<Step = unknown> extends QTrackElement<Step> {
  constructor() {
    super([""]);
  }

  /** The selected value; undefined hides the thumb. */
  get value(): number | undefined {
    return this.thumbValues[0];
  }

  set value(value: number | undefined) {
    this.thumbValues = value === undefined ? [] : [value];
  }

  /** The value a form reset restores. */
  get defaultValue(): number | undefined {
    return this.defaultThumbValues[0];
  }

  set defaultValue(value: number | undefined) {
    this.defaultThumbValues = value === undefined ? [] : [value];
  }

  /** The value formatted at the precision the track resolves there. */
  get label(): string | undefined {
    const value = this.value;
    return value === undefined ? undefined : this.labelOf(value);
  }
}

/** A two-thumb track selecting low ≤ high; see QTrackElement. */
export class QRangeElement<Step = unknown> extends QTrackElement<Step> {
  constructor() {
    super(["minimum", "maximum"]);
  }

  /** The selected [low, high]; undefined hides both thumbs. */
  get range(): readonly [number, number] | undefined {
    const [low, high] = this.thumbValues;
    return low === undefined || high === undefined ? undefined : [low, high];
  }

  set range(range: readonly [number, number] | undefined) {
    this.thumbValues = range ?? [];
  }

  /** The range a form reset restores. */
  get defaultRange(): readonly [number, number] | undefined {
    const [low, high] = this.defaultThumbValues;
    return low === undefined || high === undefined ? undefined : [low, high];
  }

  set defaultRange(range: readonly [number, number] | undefined) {
    this.defaultThumbValues = range ?? [];
  }

  /** Both values formatted at the precision the track resolves there. */
  get labels(): readonly [string, string] | undefined {
    const range = this.range;
    if (range === undefined) return undefined;
    const [low, high] = range.map((value) => this.labelOf(value));
    return low === undefined || high === undefined ? undefined : [low, high];
  }
}

function nearest<Step>(
  ticks: readonly Tick<Step>[],
  position: number,
): Tick<Step> | undefined {
  let best: Tick<Step> | undefined;
  for (const tick of ticks) {
    if (
      best === undefined ||
      Math.abs(tick.position - position) < Math.abs(best.position - position)
    ) {
      best = tick;
    }
  }
  return best;
}

/**
 * Registers an element class without an import-time global side effect.
 */
function define<T extends CustomElementConstructor>(
  tagName: string,
  constructor: T,
): T {
  const existing = customElements.get(tagName);
  if (existing && existing !== constructor) {
    throw new DOMException(
      `a different custom element is already registered as <${tagName}>`,
      "NotSupportedError",
    );
  }
  if (!existing) customElements.define(tagName, constructor);
  return constructor;
}

export function defineQBar(tagName = "q-bar"): typeof QBarElement {
  return define(tagName, QBarElement);
}

export function defineQSlider(tagName = "q-slider"): typeof QSliderElement {
  return define(tagName, QSliderElement);
}

export function defineQRange(tagName = "q-range"): typeof QRangeElement {
  return define(tagName, QRangeElement);
}
