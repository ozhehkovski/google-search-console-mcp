/**
 * Selecting URLs for scheduled checks via the URL Inspection API within the quota.
 * Priority: pages with dropping impressions -> never inspected -> long-inspected.
 */

export type PageCandidate = {
    url: string;
    clicks28d: number;
};

export type SelectedUrl = PageCandidate & {
    reason: "dropping" | "never_inspected" | "stale";
};

export type SelectUrlsOptions = {
    topPages: PageCandidate[];
    droppingPages: PageCandidate[];
    lastInspectedAt: ReadonlyMap<string, Date>;
    limit: number;
    now?: Date;
    staleAfterDays?: number;
    // dropping pages are rechecked no more often than this interval
    droppingRecheckAfterHours?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function selectUrlsForInspection(options: SelectUrlsOptions): SelectedUrl[] {
    const {
        topPages,
        droppingPages,
        lastInspectedAt,
        limit,
        now = new Date(),
        staleAfterDays = 7,
        droppingRecheckAfterHours = 20,
    } = options;

    if (limit <= 0) return [];

    const ageMs = (url: string): number | null => {
        const last = lastInspectedAt.get(url);
        return last ? now.getTime() - last.getTime() : null;
    };

    const dropping: SelectedUrl[] = [];
    const neverInspected: SelectedUrl[] = [];
    const stale: Array<SelectedUrl & {age: number}> = [];
    const seen = new Set<string>();

    for (const page of droppingPages) {
        if (seen.has(page.url)) continue;
        seen.add(page.url);
        const age = ageMs(page.url);
        if (age === null || age >= droppingRecheckAfterHours * 60 * 60 * 1000) {
            dropping.push({...page, reason: "dropping"});
        }
    }

    for (const page of topPages) {
        if (seen.has(page.url)) continue;
        seen.add(page.url);
        const age = ageMs(page.url);
        if (age === null) {
            neverInspected.push({...page, reason: "never_inspected"});
        } else if (age >= staleAfterDays * DAY_MS) {
            stale.push({...page, reason: "stale", age});
        }
    }

    const byClicks = (a: PageCandidate, b: PageCandidate) => b.clicks28d - a.clicks28d;
    dropping.sort(byClicks);
    neverInspected.sort(byClicks);
    stale.sort((a, b) => b.age - a.age || b.clicks28d - a.clicks28d);

    return [
        ...dropping,
        ...neverInspected,
        ...stale.map(({age: _age, ...rest}) => rest),
    ].slice(0, limit);
}
