import {CtrCurve, expectedCtr} from "./ctr-curve";
import {ctrOf, Priority, QueryPageRow, round} from "./types";

export type StrikingDistanceItem = {
    query: string;
    page: string;
    position: number;
    impressions: number;
    clicks: number;
    ctr: number;
    targetPosition: number;
    // expected click gain over the same period if pushed to targetPosition
    potentialExtraClicks: number;
    priority: Priority;
};

function priorityByClicks(extraClicks: number, high: number, medium: number): Priority {
    if (extraClicks >= high) return "high";
    if (extraClicks >= medium) return "medium";
    return "low";
}

/** Queries at positions minPosition..maxPosition that are realistically achievable in the TOP 3 */
export function findStrikingDistance(
    rows: QueryPageRow[],
    curve: CtrCurve,
    options: {minPosition?: number; maxPosition?: number; minImpressions?: number; targetPosition?: number; limit?: number} = {},
): StrikingDistanceItem[] {
    const {minPosition = 4, maxPosition = 15, minImpressions = 50, targetPosition = 3, limit = 20} = options;
    const targetCtr = expectedCtr(curve, targetPosition);

    return rows
        .filter((row) => row.position >= minPosition && row.position <= maxPosition && row.impressions >= minImpressions)
        .map((row) => {
            const ctr = ctrOf(row);
            const potentialExtraClicks = Math.max(0, row.impressions * (targetCtr - ctr));
            return {
                query: row.query,
                page: row.page,
                position: round(row.position),
                impressions: row.impressions,
                clicks: row.clicks,
                ctr: round(ctr * 100, 2),
                targetPosition,
                potentialExtraClicks: Math.round(potentialExtraClicks),
                priority: priorityByClicks(potentialExtraClicks, 100, 20),
            };
        })
        .filter((item) => item.potentialExtraClicks > 0)
        .sort((a, b) => b.potentialExtraClicks - a.potentialExtraClicks)
        .slice(0, limit);
}

export type LowCtrItem = {
    query: string;
    page: string;
    position: number;
    impressions: number;
    clicks: number;
    ctr: number;
    expectedCtr: number;
    lostClicks: number;
    priority: Priority;
};

/** Top positions with CTR far below expected: candidates for rewriting the title/description */
export function findLowCtr(
    rows: QueryPageRow[],
    curve: CtrCurve,
    options: {maxPosition?: number; minImpressions?: number; maxRatio?: number; limit?: number} = {},
): LowCtrItem[] {
    const {maxPosition = 5, minImpressions = 100, maxRatio = 0.6, limit = 20} = options;

    return rows
        .filter((row) => row.position > 0 && row.position <= maxPosition && row.impressions >= minImpressions)
        .map((row) => {
            const ctr = ctrOf(row);
            const expected = expectedCtr(curve, row.position);
            return {row, ctr, expected};
        })
        .filter(({ctr, expected}) => expected > 0 && ctr < expected * maxRatio)
        .map(({row, ctr, expected}) => {
            const lostClicks = row.impressions * (expected - ctr);
            return {
                query: row.query,
                page: row.page,
                position: round(row.position),
                impressions: row.impressions,
                clicks: row.clicks,
                ctr: round(ctr * 100, 2),
                expectedCtr: round(expected * 100, 2),
                lostClicks: Math.round(lostClicks),
                priority: priorityByClicks(lostClicks, 100, 20),
            };
        })
        .sort((a, b) => b.lostClicks - a.lostClicks)
        .slice(0, limit);
}
