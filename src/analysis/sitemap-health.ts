export type SitemapInput = {
    path: string;
    isSitemapsIndex: boolean;
    isPending: boolean;
    lastSubmitted: string | null;
    lastDownloaded: string | null;
    errors: number;
    warnings: number;
    submittedUrls: number;
};

export type SitemapIssueKey =
    | "no_sitemaps"
    | "has_errors"
    | "has_warnings"
    | "stale_download"
    | "pending_too_long"
    | "empty_sitemap";

export type SitemapIssue = {
    key: SitemapIssueKey;
    severity: "warning" | "critical";
    path: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(value: string | null, now: Date): number | null {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : (now.getTime() - time) / DAY_MS;
}

export function sitemapHealth(
    sitemaps: SitemapInput[],
    options: {now?: Date; staleDownloadDays?: number; pendingDays?: number} = {},
): SitemapIssue[] {
    const {now = new Date(), staleDownloadDays = 14, pendingDays = 3} = options;

    if (sitemaps.length === 0) {
        return [{key: "no_sitemaps", severity: "critical", path: null}];
    }

    const issues: SitemapIssue[] = [];
    for (const sitemap of sitemaps) {
        if (sitemap.errors > 0) {
            issues.push({key: "has_errors", severity: "critical", path: sitemap.path});
        }
        if (sitemap.warnings > 0) {
            issues.push({key: "has_warnings", severity: "warning", path: sitemap.path});
        }

        const submittedAgo = daysSince(sitemap.lastSubmitted, now);
        if (sitemap.isPending && submittedAgo !== null && submittedAgo > pendingDays) {
            issues.push({key: "pending_too_long", severity: "warning", path: sitemap.path});
        }

        const downloadedAgo = daysSince(sitemap.lastDownloaded, now);
        if (!sitemap.isPending && (downloadedAgo === null || downloadedAgo > staleDownloadDays)) {
            issues.push({key: "stale_download", severity: "warning", path: sitemap.path});
        }

        if (!sitemap.isPending && downloadedAgo !== null && sitemap.submittedUrls === 0) {
            issues.push({key: "empty_sitemap", severity: "warning", path: sitemap.path});
        }
    }

    return issues;
}
