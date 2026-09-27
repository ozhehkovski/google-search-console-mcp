/**
 * Search Console properties come in two kinds: URL-prefix ("https://example.com/")
 * and domain ("sc-domain:example.com").
 */

export function isDomainProperty(siteUrl: string): boolean {
  return siteUrl.startsWith("sc-domain:");
}

/** Human-friendly name: "example.com" for both property kinds (path kept for URL-prefix sub-folders). */
export function displayName(siteUrl: string): string {
  if (isDomainProperty(siteUrl)) return siteUrl.slice("sc-domain:".length);
  try {
    const url = new URL(siteUrl);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.hostname}${path}`;
  } catch {
    return siteUrl;
  }
}

/** Normalized form used to match what a user types ("www.Example.com", "https://example.com") to a property. */
export function normalizeSiteRef(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutScheme = trimmed.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "");
  return withoutScheme.replace(/^www\./, "").replace(/\/$/, "");
}
