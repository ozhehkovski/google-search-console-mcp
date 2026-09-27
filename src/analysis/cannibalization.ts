import {ctrOf, Priority, QueryPageRow, round} from "./types";

export type CannibalizationPage = {
    page: string;
    clicks: number;
    impressions: number;
    position: number;
    ctr: number;
    impressionShare: number;
};

export type CannibalizationRecommendation = "consolidate" | "differentiate" | "canonical";

export type CannibalizationCase = {
    query: string;
    totalImpressions: number;
    totalClicks: number;
    pages: CannibalizationPage[];
    winner: string;
    // how many times the leading page for the query changed over the period (based on daily data)
    leaderSwitches: number | null;
    severity: Priority;
    recommendation: CannibalizationRecommendation;
};

/** Daily leader for a query: the page with the most impressions that day */
export type DailyLeader = {query: string; date: string; page: string};

export function countLeaderSwitches(leaders: DailyLeader[]): Map<string, number> {
    const byQuery = new Map<string, DailyLeader[]>();
    for (const leader of leaders) {
        const list = byQuery.get(leader.query) ?? [];
        list.push(leader);
        byQuery.set(leader.query, list);
    }
    const result = new Map<string, number>();
    for (const [query, list] of byQuery) {
        list.sort((a, b) => a.date.localeCompare(b.date));
        let switches = 0;
        for (let index = 1; index < list.length; index++) {
            if (list[index].page !== list[index - 1].page) switches += 1;
        }
        result.set(query, switches);
    }
    return result;
}

/**
 * Queries where several pages on the site noticeably split impressions.
 * A page is counted if it has at least minShare of the query's impressions.
 */
export function detectCannibalization(
    rows: QueryPageRow[],
    options: {minQueryImpressions?: number; minShare?: number; limit?: number; leaderSwitches?: Map<string, number>} = {},
): CannibalizationCase[] {
    const {minQueryImpressions = 100, minShare = 0.1, limit = 20, leaderSwitches} = options;

    const byQuery = new Map<string, QueryPageRow[]>();
    for (const row of rows) {
        const list = byQuery.get(row.query) ?? [];
        list.push(row);
        byQuery.set(row.query, list);
    }

    const cases: CannibalizationCase[] = [];
    for (const [query, queryRows] of byQuery) {
        const totalImpressions = queryRows.reduce((sum, row) => sum + row.impressions, 0);
        if (totalImpressions < minQueryImpressions) continue;

        const pages = queryRows
            .map((row) => ({
                page: row.page,
                clicks: row.clicks,
                impressions: row.impressions,
                position: round(row.position),
                ctr: round(ctrOf(row) * 100, 2),
                impressionShare: round((row.impressions / totalImpressions) * 100),
            }))
            .filter((page) => page.impressionShare >= minShare * 100)
            .sort((a, b) => a.position - b.position || b.clicks - a.clicks);

        if (pages.length < 2) continue;

        const [best, second] = pages;
        const switches = leaderSwitches?.get(query) ?? null;
        const positionsClose = Math.abs(best.position - second.position) <= 3;

        let recommendation: CannibalizationRecommendation;
        if ((switches ?? 0) >= 3 || positionsClose) {
            // The pages are genuinely competing — merge the content and 301-redirect to the strong page
            recommendation = "consolidate";
        } else if (second.impressionShare >= 30) {
            recommendation = "differentiate";
        } else {
            recommendation = "canonical";
        }

        const severity: Priority = totalImpressions >= 5000 || (switches ?? 0) >= 5
            ? "high"
            : totalImpressions >= 1000 ? "medium" : "low";

        cases.push({
            query,
            totalImpressions,
            totalClicks: queryRows.reduce((sum, row) => sum + row.clicks, 0),
            pages,
            winner: best.page,
            leaderSwitches: switches,
            severity,
            recommendation,
        });
    }

    const severityOrder = {high: 0, medium: 1, low: 2};
    return cases
        .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.totalImpressions - a.totalImpressions)
        .slice(0, limit);
}
