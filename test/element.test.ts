import { describe, expect, test } from "bun:test";

const definitions = new Map<string, unknown>();
const {
  QBarElement,
  QRangeElement,
  QSliderElement,
  defineQBar,
  defineQRange,
  defineQSlider,
} = await import("../src/element.ts");

globalThis.customElements = {
  define(name: string, constructor: unknown) {
    definitions.set(name, constructor);
  },
  get(name: string) {
    return definitions.get(name);
  },
} as unknown as CustomElementRegistry;

describe("QBarElement registration", () => {
  test("imports outside a browser without registering as a side effect", () => {
    expect(definitions.size).toBe(0);
  });

  test("registers idempotently under the default name", () => {
    expect(defineQBar()).toBe(QBarElement);
    expect(defineQBar()).toBe(QBarElement);
    expect(definitions.get("q-bar")).toBe(QBarElement);
  });

  test("registers the slider beside the bar", () => {
    expect(defineQSlider()).toBe(QSliderElement);
    expect(definitions.get("q-slider")).toBe(QSliderElement);
    expect(QSliderElement.observedAttributes).toContain("snap");
    expect(QSliderElement.observedAttributes).toContain("min-spacing");
  });

  test("registers the range slider", () => {
    expect(defineQRange()).toBe(QRangeElement);
    expect(definitions.get("q-range")).toBe(QRangeElement);
  });

  test("makes the tracks form controls, not the bar", () => {
    expect(QSliderElement.formAssociated).toBe(true);
    expect(QRangeElement.formAssociated).toBe(true);
    expect("formAssociated" in QBarElement).toBe(false);
    expect(QRangeElement.observedAttributes).toContain("name");
  });

  test("rejects a tag name owned by another constructor", () => {
    definitions.set("other-bar", class {});
    expect(() => defineQBar("other-bar")).toThrow(
      expect.objectContaining({ name: "NotSupportedError" }),
    );
  });
});
