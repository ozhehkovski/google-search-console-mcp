import type {ActionItem} from "./action-plan";
import type {TrafficChangeResult} from "./traffic-change";
import {ctrOf, Metrics, percentChange, round} from "./types";

export type ReportInput = {
    siteUrl: string;
    period: {start: string; end: string};
    previousPeriod: {start: string; end: string};
    current: Metrics;
    previous: Metrics;
    lastYear?: Metrics | null;
    change: TrafficChangeResult;
    winners: Array<{key: string; clicksDelta: number}>;
    losers: Array<{key: string; clicksDelta: number}>;
    indexing?: {indexed: number; notIndexed: number; critical: number} | null;
    actions: ActionItem[];
    audience: "owner" | "seo";
};

function formatChange(current: number, previous: number, digits = 1): string {
    const change = percentChange(current, previous);
    if (change === null) return "—";
    return `${change > 0 ? "+" : ""}${round(change, digits)}%`;
}

function formatNumber(value: number): string {
    return Math.round(value).toLocaleString("en-US");
}

/** Weekly/periodic SEO report in markdown */
export function renderSeoReport(input: ReportInput): string {
    const {current, previous, lastYear, change} = input;
    const lines: string[] = [];

    lines.push(`# SEO report: ${input.siteUrl}`);
    lines.push(`Period: ${input.period.start} — ${input.period.end} (compared with ${input.previousPeriod.start} — ${input.previousPeriod.end})`);
    lines.push("");
    lines.push("## Summary");
    lines.push(change.summary);
    lines.push("");
    lines.push("## Key metrics");
    lines.push(`| Metric | This period | Previous | Change${lastYear ? " | Year ago" : ""} |`);
    lines.push(`|---|---|---|---${lastYear ? "|---" : ""}|`);
    const rows: Array<[string, number, number, number | undefined, (value: number) => string, boolean]> = [
        ["Clicks", current.clicks, previous.clicks, lastYear?.clicks, formatNumber, false],
        ["Impressions", current.impressions, previous.impressions, lastYear?.impressions, formatNumber, false],
        ["CTR", ctrOf(current) * 100, ctrOf(previous) * 100, lastYear ? ctrOf(lastYear) * 100 : undefined, (v) => `${round(v, 2)}%`, false],
        ["Avg. position", current.position, previous.position, lastYear?.position, (v) => `${round(v)}`, true],
    ];
    for (const [label, now, before, yearAgo, format, lowerIsBetter] of rows) {
        const positionDelta = Math.abs(now - before) < 0.05 ? 0 : now - before;
        const changeText = lowerIsBetter
            ? `${positionDelta > 0 ? "+" : positionDelta < 0 ? "−" : ""}${Math.abs(positionDelta).toFixed(1)}`
            : formatChange(now, before);
        lines.push(`| ${label} | ${format(now)} | ${format(before)} | ${changeText}${lastYear ? ` | ${yearAgo === undefined ? "—" : format(yearAgo)}` : ""} |`);
    }

    if (input.winners.length || input.losers.length) {
        lines.push("");
        lines.push("## Biggest movers");
        if (input.winners.length) {
            lines.push("**Growing:**");
            for (const item of input.winners) lines.push(`- ${item.key}: +${formatNumber(item.clicksDelta)} clicks`);
        }
        if (input.losers.length) {
            lines.push("**Declining:**");
            for (const item of input.losers) lines.push(`- ${item.key}: ${formatNumber(item.clicksDelta)} clicks`);
        }
    }

    if (input.audience === "seo" && change.drivers.length) {
        lines.push("");
        lines.push("## What drove the change");
        lines.push("| Dimension | Item | Clicks Δ | Share | Position | Cause |");
        lines.push("|---|---|---|---|---|---|");
        for (const driver of change.drivers.slice(0, 10)) {
            lines.push(`| ${driver.dimension} | ${driver.key} | ${driver.clicksDelta} | ${driver.shareOfChange}% | ${driver.positionBefore} → ${driver.positionAfter} | ${driver.cause} |`);
        }
    }

    if (input.indexing) {
        lines.push("");
        lines.push("## Indexing");
        lines.push(`${input.indexing.indexed} checked pages are indexed, ${input.indexing.notIndexed} are not` +
            (input.indexing.critical ? `, including **${input.indexing.critical} pages that had traffic**.` : "."));
    }

    lines.push("");
    lines.push("## Plan for next week");
    if (input.actions.length === 0) {
        lines.push("No urgent actions found.");
    } else {
        input.actions.forEach((action, index) => {
            lines.push(`${index + 1}. **${action.title}** (~${action.expectedWeeklyClicks} clicks/week, ${action.priority})`);
            lines.push(`   - Why: ${action.why}`);
            lines.push(`   - What to do: ${action.whatToDo}`);
        });
    }

    return lines.join("\n");
}
