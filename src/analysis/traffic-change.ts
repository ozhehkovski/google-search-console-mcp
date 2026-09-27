import {ctrOf, Metrics, percentChange, round} from "./types";

export type ChangeCause = "rankings" | "demand" | "ctr" | "mixed";

export type DeltaRow = {
    key: string;
    current: Metrics;
    previous: Metrics;
};

export type ChangeDimension = "page" | "query" | "device" | "country" | "brand";

export type ChangeDriver = {
    dimension: ChangeDimension;
    key: string;
    clicksBefore: number;
    clicksAfter: number;
    clicksDelta: number;
    // this item's share of the total change in clicks, %
    shareOfChange: number;
    positionBefore: number;
    positionAfter: number;
    impressionsChangePercent: number | null;
    cause: ChangeCause;
};

export type DailyPoint = {date: string; clicks: number};

export type TrafficChangeInput = {
    current: Metrics;
    previous: Metrics;
    // daily click series for the previous + current period (dates ascending)
    daily: DailyPoint[];
    deltas: Partial<Record<ChangeDimension, DeltaRow[]>>;
    // the same period a year ago and the period preceding it — used to check seasonality
    lastYear?: {current: Metrics; previous: Metrics} | null;
    annotations?: Array<{date: string; name: string}>;
    driversPerDimension?: number;
};

export type TrafficChangeResult = {
    direction: "drop" | "growth" | "stable";
    clicks: {before: number; after: number; delta: number; changePercent: number | null};
    impressionsChangePercent: number | null;
    ctrBefore: number;
    ctrAfter: number;
    positionBefore: number;
    positionAfter: number;
    primaryCause: ChangeCause;
    // share of the click change by cause (based on page drivers), %
    causeBreakdown: Array<{cause: ChangeCause; shareOfChange: number}>;
    changeStartDate: string | null;
    drivers: ChangeDriver[];
    seasonality: {lastYearChangePercent: number | null; likelySeasonal: boolean};
    annotations: Array<{date: string; name: string}>;
    summary: string;
};

const STABLE_THRESHOLD_PERCENT = 5;

/** Classifies the cause of a change: rankings, demand (impressions), or CTR */
export function classifyCause(current: Metrics, previous: Metrics): ChangeCause {
    const positionDelta = current.position - previous.position;
    const impressionsChange = percentChange(current.impressions, previous.impressions);
    const ctrBefore = ctrOf(previous);
    const ctrChange = ctrBefore > 0 ? ((ctrOf(current) - ctrBefore) / ctrBefore) * 100 : null;

    if (previous.position > 0 && current.position > 0 && Math.abs(positionDelta) >= 1) return "rankings";
    if (impressionsChange !== null && Math.abs(impressionsChange) >= 20) return "demand";
    if (ctrChange !== null && Math.abs(ctrChange) >= 20) return "ctr";
    return "mixed";
}

/** The day after which the average click level changed the most */
export function findChangePoint(daily: DailyPoint[], minSegment = 3): string | null {
    if (daily.length < minSegment * 2) return null;
    let bestIndex = -1;
    let bestDiff = 0;
    const total = daily.reduce((sum, point) => sum + point.clicks, 0);
    let before = 0;
    for (let index = 1; index < daily.length; index++) {
        before += daily[index - 1].clicks;
        if (index < minSegment || daily.length - index < minSegment) continue;
        const meanBefore = before / index;
        const meanAfter = (total - before) / (daily.length - index);
        const diff = Math.abs(meanAfter - meanBefore);
        if (diff > bestDiff) {
            bestDiff = diff;
            bestIndex = index;
        }
    }
    return bestIndex > 0 ? daily[bestIndex].date : null;
}

const CAUSE_TEXT: Record<ChangeCause, string> = {
    rankings: "rankings changed",
    demand: "search demand (impressions) changed",
    ctr: "click-through rate changed while rankings and demand stayed similar",
    mixed: "a mix of small changes",
};

export function explainTrafficChange(input: TrafficChangeInput): TrafficChangeResult {
    const {current, previous, driversPerDimension = 5} = input;
    const delta = current.clicks - previous.clicks;
    const changePercent = percentChange(current.clicks, previous.clicks);
    const direction = changePercent === null || Math.abs(changePercent) < STABLE_THRESHOLD_PERCENT
        ? "stable"
        : delta < 0 ? "drop" : "growth";

    const drivers: ChangeDriver[] = [];
    for (const [dimension, rows] of Object.entries(input.deltas) as Array<[ChangeDimension, DeltaRow[]]>) {
        const relevant = rows
            .map((row) => ({row, rowDelta: row.current.clicks - row.previous.clicks}))
            // drivers — items that changed in the same direction as the overall total
            .filter(({rowDelta}) => direction === "stable" ? rowDelta !== 0 : Math.sign(rowDelta) === Math.sign(delta))
            .sort((a, b) => Math.abs(b.rowDelta) - Math.abs(a.rowDelta))
            .slice(0, driversPerDimension);

        for (const {row, rowDelta} of relevant) {
            drivers.push({
                dimension,
                key: row.key,
                clicksBefore: row.previous.clicks,
                clicksAfter: row.current.clicks,
                clicksDelta: rowDelta,
                shareOfChange: delta !== 0 ? round((rowDelta / delta) * 100) : 0,
                positionBefore: round(row.previous.position),
                positionAfter: round(row.current.position),
                impressionsChangePercent: (() => {
                    const value = percentChange(row.current.impressions, row.previous.impressions);
                    return value === null ? null : round(value);
                })(),
                cause: classifyCause(row.current, row.previous),
            });
        }
    }

    const lastYearChangePercent = input.lastYear
        ? percentChange(input.lastYear.current.clicks, input.lastYear.previous.clicks)
        : null;
    const likelySeasonal = direction !== "stable"
        && lastYearChangePercent !== null
        && changePercent !== null
        && Math.sign(lastYearChangePercent) === Math.sign(changePercent)
        && Math.abs(lastYearChangePercent) >= Math.abs(changePercent) * 0.7;

    // Cause is determined from page drivers: aggregate metrics smooth out opposing effects
    const pageDriversForCause = drivers.filter((driver) => driver.dimension === "page");
    const causeShares = new Map<ChangeCause, number>();
    for (const driver of pageDriversForCause) {
        causeShares.set(driver.cause, (causeShares.get(driver.cause) ?? 0) + Math.max(0, driver.shareOfChange));
    }
    const causeBreakdown = Array.from(causeShares.entries())
        .map(([cause, share]) => ({cause, shareOfChange: round(share)}))
        .sort((a, b) => b.shareOfChange - a.shareOfChange);
    const primaryCause: ChangeCause = causeBreakdown.length === 0
        ? classifyCause(current, previous)
        : causeBreakdown[0].shareOfChange >= 60 ? causeBreakdown[0].cause : "mixed";
    const changeStartDate = direction === "stable" ? null : findChangePoint(input.daily);

    const pageDrivers = drivers.filter((driver) => driver.dimension === "page");
    const topPagesShare = round(pageDrivers.reduce((sum, driver) => sum + driver.shareOfChange, 0));

    const parts: string[] = [];
    if (direction === "stable") {
        parts.push(`Clicks are stable (${changePercent === null ? "no previous data" : `${round(changePercent)}%`}).`);
    } else {
        parts.push(`Clicks ${direction === "drop" ? "dropped" : "grew"} ${Math.abs(round(changePercent ?? 0))}% (${previous.clicks} → ${current.clicks}).`);
        const breakdownText = primaryCause === "mixed" && causeBreakdown.length > 1
            ? `several causes: ${causeBreakdown.slice(0, 2).map((item) => `${CAUSE_TEXT[item.cause]} (${item.shareOfChange}% of the change)`).join(" and ")}`
            : CAUSE_TEXT[primaryCause];
        parts.push(`Main reason: ${breakdownText} (avg. position ${round(previous.position)} → ${round(current.position)}).`);
        if (pageDrivers.length) {
            parts.push(`Top ${pageDrivers.length} pages explain ${topPagesShare}% of the change.`);
        }
        if (changeStartDate) parts.push(`The shift started around ${changeStartDate}.`);
        if (likelySeasonal) parts.push(`A similar change happened last year in the same weeks, so it is likely seasonal.`);
        if (input.annotations?.length) parts.push(`Annotated events in this window: ${input.annotations.map((a) => `${a.date} ${a.name}`).join("; ")}.`);
    }

    return {
        direction,
        clicks: {before: previous.clicks, after: current.clicks, delta, changePercent: changePercent === null ? null : round(changePercent)},
        impressionsChangePercent: (() => {
            const value = percentChange(current.impressions, previous.impressions);
            return value === null ? null : round(value);
        })(),
        ctrBefore: round(ctrOf(previous) * 100, 2),
        ctrAfter: round(ctrOf(current) * 100, 2),
        positionBefore: round(previous.position),
        positionAfter: round(current.position),
        primaryCause,
        causeBreakdown,
        changeStartDate,
        drivers,
        seasonality: {lastYearChangePercent: lastYearChangePercent === null ? null : round(lastYearChangePercent), likelySeasonal},
        annotations: input.annotations ?? [],
        summary: parts.join(" "),
    };
}
