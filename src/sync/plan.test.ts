import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {isFinalEmptyDay, planDays} from "./plan";

describe("planDays", () => {
  const today = new Date("2026-09-27T10:00:00Z");

  it("returns missing days newest first, ending yesterday", () => {
    const days = planDays({today, historyMonths: 1, loaded: new Set(["2026-09-25"])});
    assert.equal(days[0], "2026-09-26");
    assert.equal(days[1], "2026-09-24");
    assert.ok(!days.includes("2026-09-25"));
    assert.equal(days.at(-1), "2026-08-28");
  });

  it("never goes beyond 16 months", () => {
    const days = planDays({today, historyMonths: 40, loaded: new Set()});
    assert.equal(days.at(-1), "2025-05-28");
  });

  it("treats only old empty days as final", () => {
    assert.equal(isFinalEmptyDay("2026-09-25", today), false);
    assert.equal(isFinalEmptyDay("2026-09-01", today), true);
  });
});
