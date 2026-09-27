/**
 * Analysis periods. A period ends on the last day that has Search Console data (Google lags 2–3 days),
 * not "today" — otherwise the latest days would look like a drop.
 */

export type PeriodPreset = "last_7d" | "last_28d" | "last_3m" | "custom";
export type CompareMode = "previous_period" | "previous_year";

export type DateRange = {start: string; end: string};

export type ResolvedPeriods = {
    current: DateRange;
    previous: DateRange;
    days: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const PRESET_DAYS: Record<Exclude<PeriodPreset, "custom">, number> = {last_7d: 7, last_28d: 28, last_3m: 90};

export function toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): Date {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${value}`);
    }
    return date;
}

export function addDays(value: string, days: number): string {
    return toIsoDate(new Date(parseIsoDate(value).getTime() + days * DAY_MS));
}

export function shiftYears(value: string, years: number): string {
    const date = parseIsoDate(value);
    date.setUTCFullYear(date.getUTCFullYear() + years);
    return toIsoDate(date);
}

export function daysBetween(start: string, end: string): number {
    return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / DAY_MS) + 1;
}

export function resolvePeriods(options: {
    preset: PeriodPreset;
    lastDataDate: string;
    compare?: CompareMode;
    custom?: DateRange;
}): ResolvedPeriods {
    const {preset, lastDataDate, compare = "previous_period"} = options;

    let current: DateRange;
    if (preset === "custom") {
        if (!options.custom) {
            throw new Error("custom period requires start and end");
        }
        const end = options.custom.end > lastDataDate ? lastDataDate : options.custom.end;
        if (options.custom.start > end) {
            throw new Error("start must be before end and within available data");
        }
        current = {start: options.custom.start, end};
    } else {
        const days = PRESET_DAYS[preset];
        current = {start: addDays(lastDataDate, -(days - 1)), end: lastDataDate};
    }

    const days = daysBetween(current.start, current.end);
    const previous = compare === "previous_year"
        ? {start: shiftYears(current.start, -1), end: shiftYears(current.end, -1)}
        : {start: addDays(current.start, -days), end: addDays(current.start, -1)};

    return {current, previous, days};
}

export function dataLagDays(lastDataDate: string, today: Date = new Date()): number {
    return Math.max(0, Math.round((parseIsoDate(toIsoDate(today)).getTime() - parseIsoDate(lastDataDate).getTime()) / DAY_MS));
}
