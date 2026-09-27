import {Priority, round} from "./types";

export type PageWeeklySeries = {
    page: string;
    // clicks per week, oldest to newest, same length for all pages
    weeklyClicks: number[];
    // clicks for the same weeks a year ago (if available) — used to filter out seasonality
    lastYearWeeklyClicks?: number[];
};

export type DecayClass = "sudden_drop" | "gradual_decay" | "seasonal";

export type DecayingPage = {
    page: string;
    class: DecayClass;
    recentWeeklyClicks: number;
    previousWeeklyClicks: number;
    changePercent: number;
    lostClicksPerWeek: number;
    // trend slope: change in clicks per week relative to the average, %
    trendPercentPerWeek: number;
    priority: Priority;
};

function average(values: number[]): number {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/** Slope of the linear regression of y over x = 0..n-1 */
export function linearSlope(values: number[]): number {
    const n = values.length;
    if (n < 2) return 0;
    const meanX = (n - 1) / 2;
    const meanY = average(values);
    let numerator = 0;
    let denominator = 0;
    for (let x = 0; x < n; x++) {
        numerator += (x - meanX) * (values[x] - meanY);
        denominator += (x - meanX) ** 2;
    }
    return denominator ? numerator / denominator : 0;
}

/**
 * Pages losing clicks. We compare the last recentWeeks weeks with the preceding ones,
 * distinguish a sudden drop from gradual decay, and filter out seasonality using last year's data.
 */
export function findDecayingPages(
    series: PageWeeklySeries[],
    options: {recentWeeks?: number; minPreviousWeeklyClicks?: number; minDropPercent?: number; limit?: number} = {},
): DecayingPage[] {
    const {recentWeeks = 4, minPreviousWeeklyClicks = 5, minDropPercent = 20, limit = 20} = options;
    const result: DecayingPage[] = [];

    for (const item of series) {
        const weeks = item.weeklyClicks;
        if (weeks.length < recentWeeks * 2) continue;

        const recent = weeks.slice(-recentWeeks);
        const previous = weeks.slice(-recentWeeks * 2, -recentWeeks);
        const recentAvg = average(recent);
        const previousAvg = average(previous);
        if (previousAvg < minPreviousWeeklyClicks) continue;

        const changePercent = ((recentAvg - previousAvg) / previousAvg) * 100;
        if (changePercent > -minDropPercent) continue;

        const overallAvg = average(weeks);
        const trendPercentPerWeek = overallAvg ? (linearSlope(weeks) / overallAvg) * 100 : 0;

        let decayClass: DecayClass;
        const lastYear = item.lastYearWeeklyClicks;
        const lastYearChange = lastYear && lastYear.length === weeks.length
            ? (() => {
                const lyPrevious = average(lastYear.slice(-recentWeeks * 2, -recentWeeks));
                const lyRecent = average(lastYear.slice(-recentWeeks));
                return lyPrevious > 0 ? ((lyRecent - lyPrevious) / lyPrevious) * 100 : null;
            })()
            : null;

        if (lastYearChange !== null && lastYearChange <= changePercent * 0.7) {
            // a comparable drop happened in the same weeks last year — likely seasonal
            decayClass = "seasonal";
        } else {
            // sudden drop: most of the decline happened within 1-2 weeks
            const weekDrops = weeks.slice(1).map((value, index) => weeks[index] - value);
            const biggestDrop = Math.max(...weekDrops);
            decayClass = biggestDrop >= (previousAvg - recentAvg) * 0.6 ? "sudden_drop" : "gradual_decay";
        }

        const lostClicksPerWeek = previousAvg - recentAvg;
        result.push({
            page: item.page,
            class: decayClass,
            recentWeeklyClicks: round(recentAvg),
            previousWeeklyClicks: round(previousAvg),
            changePercent: round(changePercent),
            lostClicksPerWeek: round(lostClicksPerWeek),
            trendPercentPerWeek: round(trendPercentPerWeek),
            priority: decayClass === "seasonal" ? "low" : lostClicksPerWeek >= 50 ? "high" : lostClicksPerWeek >= 10 ? "medium" : "low",
        });
    }

    return result.sort((a, b) => b.lostClicksPerWeek - a.lostClicksPerWeek).slice(0, limit);
}
