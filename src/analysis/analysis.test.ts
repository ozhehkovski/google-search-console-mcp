import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {buildCtrCurve, defaultCtrCurve, expectedCtr} from "./ctr-curve";
import {findLowCtr, findStrikingDistance} from "./opportunities";
import {countLeaderSwitches, detectCannibalization} from "./cannibalization";
import {findDecayingPages, linearSlope} from "./decay";
import {classifyCause, explainTrafficChange, findChangePoint} from "./traffic-change";
import {actionId, buildActionPlan} from "./action-plan";
import {renderSeoReport} from "./report";
import type {QueryPageRow} from "./types";

const row = (query: string, page: string, clicks: number, impressions: number, position: number): QueryPageRow =>
    ({query, page, clicks, impressions, position});

describe("ctr curve", () => {
    it("falls back to the default curve without data and interpolates", () => {
        const curve = defaultCtrCurve();
        assert.equal(expectedCtr(curve, 1), 0.28);
        assert.ok(Math.abs(expectedCtr(curve, 1.5) - 0.22) < 1e-9);
        assert.equal(expectedCtr(curve, 40), curve.byPosition[20]);
    });

    it("calibrates buckets with enough rows and keeps the curve non-increasing", () => {
        const rows = [
            ...Array.from({length: 10}, (_, i) => row(`q${i}`, "/a", 10, 100, 1)),   // 10% CTR at position 1
            ...Array.from({length: 10}, (_, i) => row(`p${i}`, "/b", 20, 100, 2)),   // 20% outlier at position 2
        ];
        const curve = buildCtrCurve(rows);
        assert.deepEqual(curve.calibratedPositions, [1, 2]);
        assert.equal(curve.byPosition[1], 0.1);
        assert.equal(curve.byPosition[2], 0.1, "position 2 must not exceed position 1");
    });
});

describe("opportunities", () => {
    const curve = defaultCtrCurve();

    it("finds striking distance queries sorted by potential", () => {
        const items = findStrikingDistance([
            row("big", "/big", 20, 5000, 6),
            row("small", "/small", 1, 100, 9),
            row("top", "/top", 500, 2000, 2),
            row("far", "/far", 0, 3000, 30),
        ], curve);
        assert.deepEqual(items.map((item) => item.query), ["big", "small"]);
        assert.equal(items[0].potentialExtraClicks, Math.round(5000 * 0.11 - 20));
        assert.equal(items[0].priority, "high");
    });

    it("finds low CTR on top positions", () => {
        const items = findLowCtr([
            row("snippet", "/s", 20, 2000, 2),  // 1% vs. an expected 16%
            row("fine", "/f", 300, 2000, 2),    // 15% — normal
        ], curve);
        assert.deepEqual(items.map((item) => item.query), ["snippet"]);
        assert.equal(items[0].expectedCtr, 16);
    });
});

describe("cannibalization", () => {
    it("detects queries split between pages and recommends consolidation for close positions", () => {
        const cases = detectCannibalization([
            row("running shoes", "/a", 50, 3000, 5),
            row("running shoes", "/b", 30, 2500, 6.5),
            row("running shoes", "/c", 0, 50, 40),
            row("single", "/x", 100, 5000, 2),
        ]);
        assert.equal(cases.length, 1);
        assert.equal(cases[0].winner, "/a");
        assert.deepEqual(cases[0].pages.map((page) => page.page), ["/a", "/b"]);
        assert.equal(cases[0].recommendation, "consolidate");
        assert.equal(cases[0].severity, "high");
    });

    it("counts daily leader switches (flip-flop)", () => {
        const switches = countLeaderSwitches([
            {query: "q", date: "2026-09-03", page: "/a"},
            {query: "q", date: "2026-09-01", page: "/a"},
            {query: "q", date: "2026-09-02", page: "/b"},
            {query: "q", date: "2026-09-04", page: "/b"},
        ]);
        assert.equal(switches.get("q"), 3);
    });
});

describe("decaying pages", () => {
    it("computes linear slope", () => {
        assert.equal(linearSlope([1, 2, 3, 4]), 1);
        assert.equal(linearSlope([5]), 0);
    });

    it("classifies sudden drops, gradual decay and seasonality", () => {
        const pages = findDecayingPages([
            {page: "/sudden", weeklyClicks: [100, 100, 100, 100, 100, 100, 100, 100, 20, 20, 20, 20]},
            {page: "/gradual", weeklyClicks: [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45]},
            {page: "/seasonal", weeklyClicks: [80, 80, 80, 80, 80, 80, 80, 80, 40, 40, 40, 40],
                lastYearWeeklyClicks: [70, 70, 70, 70, 70, 70, 70, 70, 30, 30, 30, 30]},
            {page: "/stable", weeklyClicks: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]},
        ]);
        const byPage = new Map(pages.map((page) => [page.page, page]));
        assert.equal(byPage.get("/sudden")?.class, "sudden_drop");
        assert.equal(byPage.get("/gradual")?.class, "gradual_decay");
        assert.equal(byPage.get("/seasonal")?.class, "seasonal");
        assert.equal(byPage.has("/stable"), false);
        assert.equal(pages[0].page, "/sudden");
    });
});

describe("traffic change", () => {
    it("classifies causes", () => {
        assert.equal(classifyCause({clicks: 50, impressions: 1000, position: 7}, {clicks: 100, impressions: 1000, position: 4}), "rankings");
        assert.equal(classifyCause({clicks: 50, impressions: 500, position: 4.2}, {clicks: 100, impressions: 1000, position: 4}), "demand");
        assert.equal(classifyCause({clicks: 50, impressions: 1000, position: 4.2}, {clicks: 100, impressions: 1000, position: 4}), "ctr");
    });

    it("finds the change point", () => {
        const daily = [100, 102, 98, 101, 99, 50, 52, 48, 51].map((clicks, i) => ({date: `2026-09-0${i + 1}`, clicks}));
        assert.equal(findChangePoint(daily), "2026-09-06");
    });

    it("explains a drop with drivers and seasonality", () => {
        const result = explainTrafficChange({
            current: {clicks: 700, impressions: 20000, position: 8},
            previous: {clicks: 1000, impressions: 21000, position: 5},
            daily: [],
            deltas: {
                page: [
                    {key: "/blog/a", current: {clicks: 100, impressions: 5000, position: 9}, previous: {clicks: 300, impressions: 5200, position: 4}},
                    {key: "/grew", current: {clicks: 120, impressions: 2000, position: 3}, previous: {clicks: 100, impressions: 2000, position: 3}},
                ],
            },
            lastYear: {current: {clicks: 100, impressions: 1, position: 1}, previous: {clicks: 110, impressions: 1, position: 1}},
        });
        assert.equal(result.direction, "drop");
        assert.equal(result.primaryCause, "rankings");
        assert.deepEqual(result.causeBreakdown, [{cause: "rankings", shareOfChange: 66.7}]);
        assert.deepEqual(result.drivers.map((driver) => driver.key), ["/blog/a"]);
        assert.equal(result.drivers[0].shareOfChange, 66.7);
        assert.equal(result.seasonality.likelySeasonal, false);
        assert.match(result.summary, /dropped 30%/);
    });

    it("reports mixed causes when no cause dominates", () => {
        const result = explainTrafficChange({
            current: {clicks: 700, impressions: 20000, position: 5},
            previous: {clicks: 1000, impressions: 20000, position: 5},
            daily: [],
            deltas: {
                page: [
                    {key: "/ranks", current: {clicks: 100, impressions: 5000, position: 9}, previous: {clicks: 250, impressions: 5000, position: 5}},
                    {key: "/ctr", current: {clicks: 100, impressions: 5000, position: 4}, previous: {clicks: 250, impressions: 5000, position: 4}},
                ],
            },
        });
        assert.equal(result.primaryCause, "mixed");
        assert.match(result.summary, /several causes: rankings changed \(50% of the change\)/);
    });

    it("reports stable traffic", () => {
        const result = explainTrafficChange({
            current: {clicks: 1010, impressions: 1, position: 1},
            previous: {clicks: 1000, impressions: 1, position: 1},
            daily: [],
            deltas: {},
        });
        assert.equal(result.direction, "stable");
        assert.equal(result.changeStartDate, null);
    });
});

describe("action plan and report", () => {
    const plan = buildActionPlan({
        siteKey: "ws_1",
        periodDays: 28,
        decaying: [{page: "/old", class: "gradual_decay", recentWeeklyClicks: 20, previousWeeklyClicks: 60, changePercent: -66.7,
            lostClicksPerWeek: 40, trendPercentPerWeek: -5, priority: "medium"}],
        strikingDistance: [{query: "q", page: "/old", position: 6, impressions: 1000, clicks: 10, ctr: 1, targetPosition: 3,
            potentialExtraClicks: 100, priority: "high"}],
        lowCtr: [],
        cannibalization: [],
        indexingIssues: [{url: "/lost", issueKey: "crawled_not_indexed", clicks28d: 400}],
    }, 5);

    it("prefers fixing indexing and skips cannibalized queries", () => {
        const items = buildActionPlan({
            siteKey: "ws_1",
            periodDays: 28,
            decaying: [],
            strikingDistance: [
                {query: "shoes", page: "/a", position: 7, impressions: 4000, clicks: 10, ctr: 0.3, targetPosition: 3, potentialExtraClicks: 1600, priority: "high"},
                {query: "shoes", page: "/b", position: 6, impressions: 3000, clicks: 10, ctr: 0.3, targetPosition: 3, potentialExtraClicks: 1200, priority: "high"},
                {query: "boots", page: "/a", position: 5, impressions: 3000, clicks: 10, ctr: 0.3, targetPosition: 3, potentialExtraClicks: 900, priority: "high"},
            ],
            lowCtr: [],
            cannibalization: [{query: "shoes", totalImpressions: 7000, totalClicks: 20, winner: "/a", leaderSwitches: 10, severity: "high",
                recommendation: "consolidate", pages: [
                    {page: "/a", clicks: 10, impressions: 4000, position: 7, ctr: 0.25, impressionShare: 57},
                    {page: "/b", clicks: 10, impressions: 3000, position: 6, ctr: 0.33, impressionShare: 43},
                ]}],
            indexingIssues: [{url: "/a", issueKey: "crawled_not_indexed", clicks28d: 40}],
        }, 5);
        assert.deepEqual(items.map((item) => [item.target, item.type]), [["/a", "fix_indexing"]]);
        assert.ok(!items.some((item) => item.title.includes('"shoes" from')));
    });

    it("dedupes by page, keeps the most valuable action and sorts", () => {
        assert.deepEqual(plan.map((item) => [item.target, item.type]), [["/lost", "fix_indexing"], ["/old", "refresh_content"]]);
        assert.equal(plan[0].expectedWeeklyClicks, 100);
        assert.equal(plan[0].priority, "high");
    });

    it("uses stable ids", () => {
        assert.equal(plan[0].id, actionId("ws_1", "fix_indexing", "/lost"));
        assert.match(plan[0].id, /^[0-9a-f]{12}$/);
    });

    it("renders a markdown report", () => {
        const change = explainTrafficChange({
            current: {clicks: 1200, impressions: 30000, position: 6},
            previous: {clicks: 1000, impressions: 28000, position: 6.5},
            daily: [],
            deltas: {},
        });
        const markdown = renderSeoReport({
            siteUrl: "example.com",
            period: {start: "2026-09-15", end: "2026-09-21"},
            previousPeriod: {start: "2026-09-08", end: "2026-09-14"},
            current: {clicks: 1200, impressions: 30000, position: 6},
            previous: {clicks: 1000, impressions: 28000, position: 6.5},
            lastYear: null,
            change,
            winners: [{key: "/new", clicksDelta: 150}],
            losers: [],
            indexing: {indexed: 90, notIndexed: 10, critical: 2},
            actions: plan,
            audience: "owner",
        });
        assert.match(markdown, /# SEO report: example.com/);
        assert.match(markdown, /\| Clicks \| 1,200 \| 1,000 \| \+20%/);
        assert.match(markdown, /\| Avg\. position \| 6 \| 6\.5 \| −0\.5/);
        assert.match(markdown, /2 pages that had traffic/);
        assert.match(markdown, /1\. \*\*Get \/lost back into Google's index\*\*/);
    });
});
