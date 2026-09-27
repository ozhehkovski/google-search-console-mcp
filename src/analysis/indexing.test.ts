import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {explainInspection, InspectionInput, summarizeInspections} from "./explain-inspection";
import {selectUrlsForInspection} from "./select-urls";
import {sitemapHealth, SitemapInput} from "./sitemap-health";

function inspection(overrides: Partial<InspectionInput>): InspectionInput {
    return {
        verdict: "NEUTRAL",
        coverageState: null,
        indexingState: null,
        robotsTxtState: null,
        pageFetchState: null,
        googleCanonical: null,
        userCanonical: null,
        clicks28d: 0,
        ...overrides,
    };
}

describe("explainInspection", () => {
    const coverageCases: Array<[string, string, string]> = [
        ["Submitted and indexed", "indexed", "ok"],
        ["Indexed, not submitted in sitemap", "indexed_not_in_sitemap", "info"],
        ["Indexed, though blocked by robots.txt", "indexed_blocked_by_robots", "info"],
        ["Crawled - currently not indexed", "crawled_not_indexed", "warning"],
        ["Discovered - currently not indexed", "discovered_not_indexed", "warning"],
        ["Excluded by 'noindex' tag", "noindex", "warning"],
        ["Blocked by robots.txt", "blocked_by_robots", "warning"],
        ["Duplicate, Google chose different canonical than user", "canonical_mismatch", "warning"],
        ["Duplicate without user-selected canonical", "duplicate_without_canonical", "warning"],
        ["Alternate page with proper canonical tag", "alternate_canonical", "info"],
        ["Page with redirect", "redirect", "info"],
        ["Soft 404", "soft_404", "warning"],
        ["Not found (404)", "not_found", "warning"],
        ["Server error (5xx)", "server_error", "warning"],
        ["Blocked due to access forbidden (403)", "access_denied", "warning"],
        ["URL is unknown to Google", "unknown_to_google", "warning"],
        ["Something Google invents tomorrow", "other", "warning"],
    ];

    for (const [coverageState, key, severity] of coverageCases) {
        it(`maps "${coverageState}"`, () => {
            const result = explainInspection(inspection({coverageState}));
            assert.equal(result.key, key);
            assert.equal(result.severity, severity);
        });
    }

    it("escalates not-indexed pages with traffic to critical", () => {
        const result = explainInspection(inspection({coverageState: "Crawled - currently not indexed", clicks28d: 40}));
        assert.equal(result.severity, "critical");
        assert.equal(result.isIndexed, false);
    });

    it("keeps expected exclusions as info even with clicks", () => {
        assert.equal(explainInspection(inspection({coverageState: "Page with redirect", clicks28d: 10})).severity, "info");
    });

    it("falls back to technical states when coverage is missing", () => {
        assert.equal(explainInspection(inspection({indexingState: "BLOCKED_BY_META_TAG"})).key, "noindex");
        assert.equal(explainInspection(inspection({robotsTxtState: "DISALLOWED"})).key, "blocked_by_robots");
        assert.equal(explainInspection(inspection({pageFetchState: "SOFT_404"})).key, "soft_404");
        assert.equal(explainInspection(inspection({pageFetchState: "SERVER_ERROR"})).key, "server_error");
        assert.equal(explainInspection(inspection({verdict: "PASS"})).key, "indexed");
    });

    it("flags canonical mismatch on indexed pages as warning", () => {
        const result = explainInspection(inspection({
            coverageState: "Submitted and indexed",
            googleCanonical: "https://shop.com/a",
            userCanonical: "https://shop.com/a?variant=1",
        }));
        assert.equal(result.canonicalMismatch, true);
        assert.equal(result.severity, "warning");
    });

    it("summarizes explanations", () => {
        const summary = summarizeInspections([
            explainInspection(inspection({coverageState: "Submitted and indexed"})),
            explainInspection(inspection({coverageState: "Soft 404", clicks28d: 3})),
            explainInspection(inspection({coverageState: "Soft 404"})),
        ]);
        assert.deepEqual(summary, {total: 3, indexed: 1, notIndexed: 2, critical: 1, warnings: 1});
    });
});

describe("selectUrlsForInspection", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600 * 1000);

    it("prioritizes dropping, then never inspected, then stale", () => {
        const result = selectUrlsForInspection({
            now,
            limit: 10,
            droppingPages: [{url: "/drop", clicks28d: 5}],
            topPages: [
                {url: "/fresh", clicks28d: 100},
                {url: "/new-low", clicks28d: 1},
                {url: "/new-high", clicks28d: 50},
                {url: "/stale", clicks28d: 30},
                {url: "/drop", clicks28d: 5},
            ],
            lastInspectedAt: new Map([
                ["/fresh", daysAgo(1)],
                ["/stale", daysAgo(10)],
            ]),
        });
        assert.deepEqual(result.map((r) => [r.url, r.reason]), [
            ["/drop", "dropping"],
            ["/new-high", "never_inspected"],
            ["/new-low", "never_inspected"],
            ["/stale", "stale"],
        ]);
    });

    it("does not recheck dropping pages inspected recently", () => {
        const result = selectUrlsForInspection({
            now,
            limit: 10,
            droppingPages: [{url: "/drop", clicks28d: 5}],
            topPages: [],
            lastInspectedAt: new Map([["/drop", daysAgo(0.25)]]),
        });
        assert.equal(result.length, 0);
    });

    it("respects the limit", () => {
        const topPages = Array.from({length: 20}, (_, i) => ({url: `/p${i}`, clicks28d: i}));
        assert.equal(selectUrlsForInspection({now, limit: 5, droppingPages: [], topPages, lastInspectedAt: new Map()}).length, 5);
        assert.equal(selectUrlsForInspection({now, limit: 0, droppingPages: [], topPages, lastInspectedAt: new Map()}).length, 0);
    });
});

describe("sitemapHealth", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const base: SitemapInput = {
        path: "https://shop.com/sitemap.xml",
        isSitemapsIndex: true,
        isPending: false,
        lastSubmitted: "2026-09-01T00:00:00Z",
        lastDownloaded: "2026-09-24T00:00:00Z",
        errors: 0,
        warnings: 0,
        submittedUrls: 100,
    };

    it("reports missing sitemaps", () => {
        assert.deepEqual(sitemapHealth([], {now}).map((i) => i.key), ["no_sitemaps"]);
    });

    it("is healthy for a fresh sitemap", () => {
        assert.deepEqual(sitemapHealth([base], {now}), []);
    });

    it("reports errors, warnings, stale and empty sitemaps", () => {
        const keys = sitemapHealth([
            {...base, errors: 1, warnings: 2},
            {...base, path: "https://shop.com/old.xml", lastDownloaded: "2026-08-01T00:00:00Z"},
            {...base, path: "https://shop.com/empty.xml", submittedUrls: 0},
        ], {now}).map((i) => `${i.key}:${i.path}`);
        assert.deepEqual(keys, [
            "has_errors:https://shop.com/sitemap.xml",
            "has_warnings:https://shop.com/sitemap.xml",
            "stale_download:https://shop.com/old.xml",
            "empty_sitemap:https://shop.com/empty.xml",
        ]);
    });

    it("reports sitemaps pending for too long", () => {
        const issues = sitemapHealth([{...base, isPending: true, lastDownloaded: null, lastSubmitted: "2026-09-10T00:00:00Z"}], {now});
        assert.deepEqual(issues.map((i) => i.key), ["pending_too_long"]);
    });
});
