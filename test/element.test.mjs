import assert from "node:assert/strict";
import { describe, test } from "node:test";

const definitions = new Map();

const { QBarElement, defineQBar } = await import("../dist/element.js");

globalThis.customElements = {
  define(name, constructor) {
    definitions.set(name, constructor);
  },
  get(name) {
    return definitions.get(name);
  },
};

describe("QBarElement registration", () => {
  test("imports outside a browser without registering as a side effect", () => {
    assert.equal(definitions.size, 0);
  });

  test("registers idempotently under the default name", () => {
    assert.equal(defineQBar(), QBarElement);
    assert.equal(defineQBar(), QBarElement);
    assert.equal(definitions.get("q-bar"), QBarElement);
  });

  test("observes only renderer-owned attributes", () => {
    assert.deepEqual(QBarElement.observedAttributes, ["orientation"]);
  });

  test("rejects a tag name owned by another constructor", () => {
    definitions.set("other-bar", class {});
    assert.throws(() => defineQBar("other-bar"), {
      name: "NotSupportedError",
    });
  });
});
