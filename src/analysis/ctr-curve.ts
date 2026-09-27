import {ctrOf, QueryPageRow} from "./types";

/**
 * Expected CTR by position. Calibrated from the site's own data (median CTR in a position bucket),
 * and falls back to a default industry curve for buckets with too little volume.
 */
export type CtrCurve = {
    byPosition: number[]; // index = position 1..20 (0 is unused)
    calibratedPositions: number[];
};

// Averaged industry curve of organic CTR (as a fraction, not %), positions 1..20
const DEFAULT_CTR: number[] = [
    0, 0.28, 0.16, 0.11, 0.08, 0.06, 0.045, 0.035, 0.028, 0.022, 0.018,
    0.012, 0.01, 0.009, 0.008, 0.007, 0.006, 0.005, 0.005, 0.004, 0.004,
];

const MAX_POSITION = 20;

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildCtrCurve(
    rows: QueryPageRow[],
    options: {minRowsPerBucket?: number; minImpressions?: number} = {},
): CtrCurve {
    const {minRowsPerBucket = 8, minImpressions = 20} = options;
    const buckets = new Map<number, number[]>();

    for (const row of rows) {
        if (row.impressions < minImpressions || row.position < 1) continue;
        const bucket = Math.round(row.position);
        if (bucket > MAX_POSITION) continue;
        const list = buckets.get(bucket) ?? [];
        list.push(ctrOf(row));
        buckets.set(bucket, list);
    }

    const byPosition = [...DEFAULT_CTR];
    const calibratedPositions: number[] = [];
    for (let position = 1; position <= MAX_POSITION; position++) {
        const values = buckets.get(position);
        if (values && values.length >= minRowsPerBucket) {
            byPosition[position] = median(values);
            calibratedPositions.push(position);
        }
    }

    // The curve must not increase with position — smooth out calibration outliers
    for (let position = 2; position <= MAX_POSITION; position++) {
        byPosition[position] = Math.min(byPosition[position], byPosition[position - 1]);
    }

    return {byPosition, calibratedPositions};
}

export function expectedCtr(curve: CtrCurve, position: number): number {
    if (position <= 1) return curve.byPosition[1];
    if (position >= MAX_POSITION) return curve.byPosition[MAX_POSITION];
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return curve.byPosition[lower];
    // linear interpolation between neighboring positions
    const weight = position - lower;
    return curve.byPosition[lower] * (1 - weight) + curve.byPosition[upper] * weight;
}

export function defaultCtrCurve(): CtrCurve {
    return {byPosition: [...DEFAULT_CTR], calibratedPositions: []};
}
