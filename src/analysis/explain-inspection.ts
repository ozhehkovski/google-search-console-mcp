/**
 * Human-readable interpretation of a URL Inspection result:
 * what the status means, how severe it is, and what to do.
 * The display text lives in the UI translations, keyed by InspectionIssueKey.
 */

export type InspectionSeverity = "ok" | "info" | "warning" | "critical";

export type InspectionIssueKey =
    | "indexed"
    | "indexed_not_in_sitemap"
    | "indexed_blocked_by_robots"
    | "crawled_not_indexed"
    | "discovered_not_indexed"
    | "noindex"
    | "blocked_by_robots"
    | "canonical_mismatch"
    | "duplicate_without_canonical"
    | "alternate_canonical"
    | "redirect"
    | "soft_404"
    | "not_found"
    | "server_error"
    | "access_denied"
    | "unknown_to_google"
    | "other";

export type InspectionInput = {
    verdict: string;
    coverageState: string | null;
    indexingState: string | null;
    robotsTxtState: string | null;
    pageFetchState: string | null;
    googleCanonical: string | null;
    userCanonical: string | null;
    clicks28d?: number | null;
};

export type InspectionExplanation = {
    key: InspectionIssueKey;
    severity: InspectionSeverity;
    isIndexed: boolean;
    canonicalMismatch: boolean;
};

const EXPECTED_NOT_INDEXED: ReadonlySet<InspectionIssueKey> = new Set(["alternate_canonical", "redirect"]);

function normalize(value: string | null): string {
    return (value ?? "").trim().toLowerCase();
}

function keyFromCoverageState(coverage: string): InspectionIssueKey | null {
    if (!coverage) return null;
    if (coverage === "submitted and indexed") return "indexed";
    if (coverage.startsWith("indexed, not submitted")) return "indexed_not_in_sitemap";
    if (coverage.startsWith("indexed, though blocked")) return "indexed_blocked_by_robots";
    if (coverage.startsWith("crawled - currently not indexed")) return "crawled_not_indexed";
    if (coverage.startsWith("discovered - currently not indexed")) return "discovered_not_indexed";
    if (coverage.includes("noindex")) return "noindex";
    if (coverage.startsWith("blocked by robots.txt")) return "blocked_by_robots";
    if (coverage.includes("google chose different canonical")) return "canonical_mismatch";
    if (coverage.startsWith("duplicate without user-selected canonical")) return "duplicate_without_canonical";
    if (coverage.startsWith("alternate page with proper canonical")) return "alternate_canonical";
    if (coverage.startsWith("page with redirect") || coverage.startsWith("redirect error")) return "redirect";
    if (coverage.startsWith("soft 404")) return "soft_404";
    if (coverage.startsWith("not found")) return "not_found";
    if (coverage.startsWith("server error")) return "server_error";
    if (coverage.startsWith("blocked due to") || coverage.includes("(403)") || coverage.includes("(401)") || coverage.includes("4xx")) {
        return "access_denied";
    }
    if (coverage.startsWith("url is unknown to google")) return "unknown_to_google";
    if (coverage.startsWith("indexed")) return "indexed";
    return null;
}

function keyFromTechnicalStates(input: InspectionInput): InspectionIssueKey | null {
    const indexing = normalize(input.indexingState);
    if (indexing === "blocked_by_meta_tag" || indexing === "blocked_by_http_header") return "noindex";

    if (normalize(input.robotsTxtState) === "disallowed") return "blocked_by_robots";

    switch (normalize(input.pageFetchState)) {
        case "soft_404":
            return "soft_404";
        case "not_found":
            return "not_found";
        case "server_error":
        case "internal_crawl_error":
            return "server_error";
        case "access_denied":
        case "access_forbidden":
        case "blocked_4xx":
            return "access_denied";
        case "redirect_error":
            return "redirect";
        case "blocked_robots_txt":
            return "blocked_by_robots";
        default:
            return null;
    }
}

export function explainInspection(input: InspectionInput): InspectionExplanation {
    const coverageKey = keyFromCoverageState(normalize(input.coverageState));
    const key: InspectionIssueKey = coverageKey
        ?? keyFromTechnicalStates(input)
        ?? (input.verdict === "PASS" ? "indexed" : "other");

    const isIndexed = key === "indexed" || key === "indexed_not_in_sitemap" || key === "indexed_blocked_by_robots";
    const canonicalMismatch = Boolean(
        input.googleCanonical && input.userCanonical && input.googleCanonical !== input.userCanonical
    );

    let severity: InspectionSeverity;
    if (key === "indexed") {
        severity = canonicalMismatch ? "warning" : "ok";
    } else if (isIndexed) {
        severity = "info";
    } else if (EXPECTED_NOT_INDEXED.has(key)) {
        severity = "info";
    } else if ((input.clicks28d ?? 0) > 0) {
        // The page used to get clicks but is not indexed now — we are losing traffic
        severity = "critical";
    } else {
        severity = "warning";
    }

    return {key, severity, isIndexed, canonicalMismatch};
}

export type InspectionSummary = {
    total: number;
    indexed: number;
    notIndexed: number;
    critical: number;
    warnings: number;
};

export function summarizeInspections(explanations: InspectionExplanation[]): InspectionSummary {
    return explanations.reduce<InspectionSummary>((summary, explanation) => ({
        total: summary.total + 1,
        indexed: summary.indexed + (explanation.isIndexed ? 1 : 0),
        notIndexed: summary.notIndexed + (explanation.isIndexed ? 0 : 1),
        critical: summary.critical + (explanation.severity === "critical" ? 1 : 0),
        warnings: summary.warnings + (explanation.severity === "warning" ? 1 : 0),
    }), {total: 0, indexed: 0, notIndexed: 0, critical: 0, warnings: 0});
}
