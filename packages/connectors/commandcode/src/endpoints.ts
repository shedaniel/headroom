/**
 * Every URL and header the Command Code connector uses. Sources: docs/providers/commandcode.md and
 * pi-commandcode-provider's `quota.ts` (source-inspected). All four routes are private `/alpha/` routes.
 */
export const apiBase = "https://api.commandcode.ai";

/** Where a person finds their key. Command Code documents no key-creation URL, so this is the site. */
export const keyPageUrl = "https://commandcode.ai";

/** The key's owner: a user, and an organization when the key belongs to one. */
export const whoamiPath = "/alpha/whoami";
/** Remaining credits, and the 5-hour and weekly window limits. */
export const creditsPath = "/alpha/billing/credits";
/** The plan, its status and its billing period. */
export const subscriptionsPath = "/alpha/billing/subscriptions";
/** Spend and request totals for the billing period. */
export const usageSummaryPath = "/alpha/usage/summary";

export function apiHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: "application/json",
    "user-agent": "Headroom",
  };
}

/** `orgId` and `since` are sent only when known; an absent value is not an empty string. */
export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return `${apiBase}${path}${query === "" ? "" : `?${query}`}`;
}
