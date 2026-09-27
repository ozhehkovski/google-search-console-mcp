/** Metrics for a period. position is the average, weighted by impressions */
export type Metrics = {
    clicks: number;
    impressions: number;
    position: number;
};

/** A "query x page" row for a period */
export type QueryPageRow = Metrics & {
    query: string;
    page: string;
};

export type Priority = "high" | "medium" | "low";

export function ctrOf(metrics: Pick<Metrics, "clicks" | "impressions">): number {
    return metrics.impressions > 0 ? metrics.clicks / metrics.impressions : 0;
}

export function round(value: number, digits = 1): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

export function percentChange(current: number, previous: number): number | null {
    return previous > 0 ? ((current - previous) / previous) * 100 : null;
}
