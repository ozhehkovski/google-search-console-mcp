import {createHash} from "crypto";
import type {CannibalizationCase} from "./cannibalization";
import type {DecayingPage} from "./decay";
import type {LowCtrItem, StrikingDistanceItem} from "./opportunities";
import type {InspectionIssueKey} from "./explain-inspection";
import {Priority} from "./types";

export type ActionType = "fix_indexing" | "refresh_content" | "push_to_top3" | "improve_snippet" | "resolve_cannibalization";

export type ActionItem = {
    // stable id: the same for the same finding across runs
    id: string;
    type: ActionType;
    target: string;
    title: string;
    why: string;
    whatToDo: string;
    // estimated clicks per week that can be recovered or gained
    expectedWeeklyClicks: number;
    priority: Priority;
};

export type IndexingIssueInput = {
    url: string;
    issueKey: InspectionIssueKey;
    clicks28d: number | null;
};

export type ActionPlanInput = {
    siteKey: string;
    periodDays: number;
    decaying: DecayingPage[];
    strikingDistance: StrikingDistanceItem[];
    lowCtr: LowCtrItem[];
    cannibalization: CannibalizationCase[];
    indexingIssues: IndexingIssueInput[];
};

export function actionId(siteKey: string, type: ActionType, target: string): string {
    return createHash("sha1").update(`${siteKey}|${type}|${target}`).digest("hex").slice(0, 12);
}

function priorityOf(weeklyClicks: number): Priority {
    if (weeklyClicks >= 25) return "high";
    if (weeklyClicks >= 5) return "medium";
    return "low";
}

/**
 * Weekly summary plan: all findings are normalized to expected clicks per week,
 * deduplicated by page (each page keeps its most valuable action) and ranked.
 */
export function buildActionPlan(input: ActionPlanInput, capacity = 5): ActionItem[] {
    const weeksInPeriod = Math.max(1, input.periodDays / 7);
    const candidates: ActionItem[] = [];
    const add = (item: Omit<ActionItem, "id" | "priority">) => {
        candidates.push({
            ...item,
            expectedWeeklyClicks: Math.round(item.expectedWeeklyClicks),
            id: actionId(input.siteKey, item.type, item.target),
            priority: priorityOf(item.expectedWeeklyClicks),
        });
    };

    for (const issue of input.indexingIssues) {
        const weekly = (issue.clicks28d ?? 0) / 4;
        if (weekly <= 0) continue;
        add({
            type: "fix_indexing",
            target: issue.url,
            title: `Get ${issue.url} back into Google's index`,
            why: `The page had ${issue.clicks28d} clicks in 28 days but Google reports "${issue.issueKey}".`,
            whatToDo: "Fix the indexing issue (see get_indexing_issues for the exact reason) and request a recrawl.",
            expectedWeeklyClicks: weekly,
        });
    }

    for (const page of input.decaying) {
        if (page.class === "seasonal") continue;
        add({
            type: "refresh_content",
            target: page.page,
            title: `Refresh ${page.page}`,
            why: `Clicks fell ${Math.abs(page.changePercent)}% (${page.previousWeeklyClicks} → ${page.recentWeeklyClicks} per week, ${page.class.replace("_", " ")}).`,
            whatToDo: "Check which queries were lost (analyze_page), update the content for them, and add internal links from strong pages.",
            expectedWeeklyClicks: page.lostClicksPerWeek,
        });
    }

    // Queries with cannibalization are resolved by consolidation, not by "pushing up" individual pages
    const cannibalizedQueries = new Set(input.cannibalization.map((item) => item.query));
    const strikingByQuery = new Map<string, StrikingDistanceItem>();
    for (const item of input.strikingDistance) {
        if (cannibalizedQueries.has(item.query)) continue;
        const existing = strikingByQuery.get(item.query);
        if (!existing || item.potentialExtraClicks > existing.potentialExtraClicks) strikingByQuery.set(item.query, item);
    }

    for (const item of strikingByQuery.values()) {
        add({
            type: "push_to_top3",
            target: item.page,
            title: `Push "${item.query}" from #${item.position} into the top 3`,
            why: `${item.impressions} impressions at position ${item.position}; the top 3 would bring about ${item.potentialExtraClicks} more clicks per period.`,
            whatToDo: `Use "${item.query}" in the title and H1 of ${item.page}, expand the section answering it, and link to the page from related pages.`,
            expectedWeeklyClicks: item.potentialExtraClicks / weeksInPeriod,
        });
    }

    for (const item of input.lowCtr.filter((lowCtr) => !cannibalizedQueries.has(lowCtr.query))) {
        add({
            type: "improve_snippet",
            target: item.page,
            title: `Improve the search snippet of ${item.page}`,
            why: `Ranks #${item.position} for "${item.query}" but CTR is ${item.ctr}% vs ~${item.expectedCtr}% expected.`,
            whatToDo: "Rewrite the title and meta description to match the query intent; add structured data for rich results where possible.",
            expectedWeeklyClicks: item.lostClicks / weeksInPeriod,
        });
    }

    for (const item of input.cannibalization) {
        const losers = item.pages.filter((page) => page.page !== item.winner).map((page) => page.page);
        add({
            type: "resolve_cannibalization",
            target: item.winner,
            title: `Resolve cannibalization for "${item.query}"`,
            why: `${item.pages.length} pages compete for the query (${item.totalImpressions} impressions)${item.leaderSwitches ? `, the ranking page switched ${item.leaderSwitches} times` : ""}.`,
            whatToDo: item.recommendation === "consolidate"
                ? `Merge ${losers.join(", ")} into ${item.winner} and 301-redirect.`
                : item.recommendation === "differentiate"
                    ? `Give ${losers.join(", ")} a distinct intent and keep "${item.query}" on ${item.winner}.`
                    : `Add a canonical from ${losers.join(", ")} to ${item.winner} or remove the query from those pages.`,
            // estimate: half of the losing pages' clicks could shift to the winning page
            expectedWeeklyClicks: item.pages.filter((page) => page.page !== item.winner)
                .reduce((sum, page) => sum + page.clicks, 0) / 2 / weeksInPeriod,
        });
    }

    // One action per page. A non-indexed page must get back into the index first,
    // other improvements are pointless before that.
    const bestPerTarget = new Map<string, ActionItem>();
    for (const candidate of candidates) {
        const existing = bestPerTarget.get(candidate.target);
        const candidateWins = !existing
            || (candidate.type === "fix_indexing" && existing.type !== "fix_indexing")
            || (existing.type !== "fix_indexing" && candidate.expectedWeeklyClicks > existing.expectedWeeklyClicks);
        if (candidateWins) {
            bestPerTarget.set(candidate.target, candidate);
        }
    }

    return Array.from(bestPerTarget.values())
        .sort((a, b) => b.expectedWeeklyClicks - a.expectedWeeklyClicks)
        .slice(0, capacity);
}
