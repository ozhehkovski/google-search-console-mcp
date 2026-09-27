import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {addDays, dataLagDays, daysBetween, resolvePeriods, shiftYears} from "./periods";

describe("periods", () => {
    it("resolves presets ending at the last data date", () => {
        const periods = resolvePeriods({preset: "last_7d", lastDataDate: "2026-09-23"});
        assert.deepEqual(periods, {
            current: {start: "2026-09-17", end: "2026-09-23"},
            previous: {start: "2026-09-10", end: "2026-09-16"},
            days: 7,
        });
    });

    it("supports year-over-year comparison", () => {
        const periods = resolvePeriods({preset: "last_28d", lastDataDate: "2026-09-23", compare: "previous_year"});
        assert.deepEqual(periods.previous, {start: "2025-08-27", end: "2025-09-23"});
        assert.equal(periods.days, 28);
    });

    it("clamps custom periods to available data and validates order", () => {
        const periods = resolvePeriods({preset: "custom", lastDataDate: "2026-09-23", custom: {start: "2026-09-01", end: "2026-09-30"}});
        assert.deepEqual(periods.current, {start: "2026-09-01", end: "2026-09-23"});
        assert.throws(() => resolvePeriods({preset: "custom", lastDataDate: "2026-09-23", custom: {start: "2026-09-25", end: "2026-09-30"}}));
        assert.throws(() => resolvePeriods({preset: "custom", lastDataDate: "2026-09-23"}));
    });

    it("does date math in UTC", () => {
        assert.equal(addDays("2026-03-01", -1), "2026-02-28");
        assert.equal(shiftYears("2024-02-29", -1), "2023-03-01");
        assert.equal(daysBetween("2026-09-01", "2026-09-07"), 7);
        assert.equal(dataLagDays("2026-09-23", new Date("2026-09-26T10:00:00Z")), 3);
    });
});
