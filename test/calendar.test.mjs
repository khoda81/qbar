import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calendarTicks } from "../dist/index.js";

function utc(value) {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}

describe("CalendarTickSource", () => {
  test("selects a month boundary with its actual local spacing", () => {
    const source = calendarTicks({ levels: [{ unit: "month" }] });
    const output = { value: NaN, spacing: NaN, level: NaN };

    assert.equal(
      source.select(utc("2024-01-15"), utc("2024-02-15"), output),
      true,
    );
    assert.equal(output.value, utc("2024-02-01"));
    assert.equal(output.spacing, 29 * 86_400_000);
  });

  test("supports week, hour, and minute families", () => {
    const source = calendarTicks({
      levels: [{ unit: "week" }, { unit: "hour" }, { unit: "minute" }],
    });
    const output = { value: NaN, spacing: NaN, level: NaN };
    const lower = new Date("2024-04-07T12:00:00.000Z").getTime();
    const upper = new Date("2024-04-08T12:00:00.000Z").getTime();

    assert.equal(source.select(lower, upper, output), true);
    assert.equal(output.value, new Date("2024-04-08T00:00:00.000Z").getTime());
    assert.equal(output.spacing, 7 * 86_400_000);
  });

  test("supports stepped calendar families", () => {
    const source = calendarTicks({
      levels: [{ unit: "hour", step: 6 }],
    });
    const output = { value: NaN, spacing: NaN, level: NaN };
    const lower = new Date("2024-01-01T05:00:00.000Z").getTime();
    const upper = new Date("2024-01-01T07:00:00.000Z").getTime();

    assert.equal(source.select(lower, upper, output), true);
    assert.equal(output.value, new Date("2024-01-01T06:00:00.000Z").getTime());
    assert.equal(output.spacing, 6 * 3_600_000);
  });
});
