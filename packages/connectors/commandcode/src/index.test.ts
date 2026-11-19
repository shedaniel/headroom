import { describe, expect, test } from "bun:test";

import type { Identity, MetricObservation } from "@headroom/core";

import {
  apiBase,
  creditsPath,
  subscriptionsPath,
  usageSummaryPath,
  whoamiPath,
} from "./endpoints.ts";
import creditsDrift from "./fixtures/credits-drift.json";
import creditsIdle from "./fixtures/credits-idle.json";
import credits from "./fixtures/credits.json";
import subscription from "./fixtures/subscription.json";
import summary from "./fixtures/summary.json";
import whoamiOrg from "./fixtures/whoami-org.json";
import whoamiUser from "./fixtures/whoami-user.json";
import { createCommandCodeConnector } from "./index.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes by path. Anything unlisted is a 404, so a call to an undocumented endpoint shows up as a failure. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: URL; headers: Headers }[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url.pathname];
    return Promise.resolve(route ? route() : new Response("not found", { status: 404 }));
  };
  return { fetch: impl, calls };
}

const healthy = (overrides: Record<string, () => Response> = {}) => ({
  [whoamiPath]: () => json(whoamiUser),
  [creditsPath]: () => json(credits),
  [subscriptionsPath]: () => json(subscription),
  [usageSummaryPath]: () => json(summary),
  ...overrides,
});

const credential = { secret: { apiKey: "user_synthetic_key" }, expiresAt: null };
const stored: Identity = {
  providerAccountId: "user:user-0001",
  workspaceId: null,
  label: "sample-user",
  assurance: "strong",
};

const byKey = (metrics: readonly MetricObservation[], key: string) =>
  metrics.find((metric) => metric.providerMetricKey === key);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("Command Code connector", () => {
  test("connect is a single api_key step that becomes a non-refreshable credential", async () => {
    const connector = createCommandCodeConnector({ fetch: fakeFetch({}).fetch });
    expect(connector.provider).toBe("commandcode");
    expect(connector.interface).toBe("private");
    const begun = await connector.beginConnect({ attemptId: "a", method: "api_key", expiresAt: 1 });
    expect(begun).toMatchObject({ status: "next_step", nextStep: { kind: "api_key" } });
    const done = await connector.submitInput(
      {},
      { kind: "api_key", values: { apiKey: " user_x " } },
    );
    expect(done).toEqual({
      status: "credentials",
      credential: { secret: { apiKey: "user_x" }, expiresAt: null },
    });
    expect(await connector.submitInput({}, { kind: "api_key", values: {} })).toMatchObject({
      status: "error",
    });
    expect(await connector.refresh(credential)).toEqual({ status: "not_refreshable" });
    expect(await connector.disconnect(credential)).toBe("local_only");
  });

  test("identity names a personal key by its user and sends the key as a bearer token only", async () => {
    const http = fakeFetch(healthy());
    const id = await createCommandCodeConnector({ fetch: http.fetch }).identity(credential);
    expect(id).toEqual(stored);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url.href).toBe(`${apiBase}${whoamiPath}`);
    expect(http.calls[0]?.headers.get("authorization")).toBe("Bearer user_synthetic_key");
    expect(http.calls[0]?.url.href).not.toContain("user_synthetic_key");
  });

  test("identity names an organization key by its organization", async () => {
    const http = fakeFetch(healthy({ [whoamiPath]: () => json(whoamiOrg) }));
    const id = await createCommandCodeConnector({ fetch: http.fetch }).identity(credential);
    expect(id).toMatchObject({ providerAccountId: "org:org-0001", label: "sample-org" });
  });

  test("a rejected key is authentication_required, and a changed whoami shape is invalid_response", async () => {
    const rejected = createCommandCodeConnector({
      fetch: fakeFetch(healthy({ [whoamiPath]: () => json({}, 401) })).fetch,
    });
    expect(await rejection(rejected.identity(credential))).toMatchObject({
      category: "authentication_required",
    });
    const drifted = createCommandCodeConnector({
      fetch: fakeFetch(healthy({ [whoamiPath]: () => json({ user: null, org: null }) })).fetch,
    });
    expect(await rejection(drifted.identity(credential))).toMatchObject({
      category: "invalid_response",
    });
  });

  test("collect turns the limits, credits, spend and renewal into metrics", async () => {
    const http = fakeFetch(healthy());
    const connector = createCommandCodeConnector({ fetch: http.fetch });
    const result = await connector.collect(credential, stored);
    expect(result.failures).toEqual([]);
    expect(result.label).toBe("sample-user (Individual Sample)");

    expect(byKey(result.metrics, "five_hour")).toMatchObject({
      kind: "quota_percentage",
      scope: "window:18000s",
      valueText: "25",
      unit: "percent",
      resetsAt: 1_790_000_000_000,
      availability: "available",
      interface: "private",
    });
    expect(byKey(result.metrics, "weekly")).toMatchObject({
      scope: "window:604800s",
      valueText: "50",
      resetsAt: 1_790_500_000_000,
    });
    // 12.5 monthly + 3 purchased + 0.5 free.
    expect(byKey(result.metrics, "credits.balance")).toMatchObject({
      kind: "credits",
      valueText: "16",
      unit: "credits",
      availability: "available",
    });
    expect(byKey(result.metrics, "usage.period")).toMatchObject({
      kind: "spend",
      valueText: "41.25",
      windowStart: Date.parse("2026-10-01T00:00:00.000Z"),
      windowEnd: Date.parse("2026-11-01T00:00:00.000Z"),
    });
    expect(byKey(result.metrics, "billing.renews_at")).toMatchObject({
      kind: "reset_timestamp",
      resetsAt: Date.parse("2026-11-01T00:00:00.000Z"),
    });

    // Only the four documented routes, each a GET, and a personal key sends no organization.
    expect(http.calls.map((call) => call.url.pathname).toSorted()).toEqual(
      [whoamiPath, creditsPath, subscriptionsPath, usageSummaryPath].toSorted(),
    );
    expect(http.calls.some((call) => call.url.searchParams.has("orgId"))).toBe(false);
    // The usage total is asked for the same period the subscription reports.
    const summaryCall = http.calls.find((call) => call.url.pathname === usageSummaryPath);
    expect(summaryCall?.url.searchParams.get("since")).toBe("2026-10-01T00:00:00.000Z");
  });

  test("an organization key passes its organization to every billing route", async () => {
    const http = fakeFetch(healthy({ [whoamiPath]: () => json(whoamiOrg) }));
    await createCommandCodeConnector({ fetch: http.fetch }).collect(credential, stored);
    const billing = http.calls.filter((call) => call.url.pathname !== whoamiPath);
    expect(billing).toHaveLength(3);
    for (const call of billing) expect(call.url.searchParams.get("orgId")).toBe("org-0001");
  });

  test("a window that has not started has no reset time, and an idle account still has a balance of zero", async () => {
    const http = fakeFetch(healthy({ [creditsPath]: () => json(creditsIdle) }));
    const result = await createCommandCodeConnector({ fetch: http.fetch }).collect(
      credential,
      stored,
    );
    expect(byKey(result.metrics, "five_hour")).toMatchObject({ valueText: "0", resetsAt: null });
    expect(byKey(result.metrics, "weekly")).toMatchObject({ valueText: "0", resetsAt: null });
    expect(byKey(result.metrics, "credits.balance")).toMatchObject({
      valueText: "0",
      availability: "available",
    });
  });

  test("a window with no cap is left out, and a credit pool the route omits makes the balance unknown, not a smaller sum", async () => {
    const body = {
      credits: { monthlyCredits: 5 },
      windowLimits: { fiveHour: { used: 0, cap: 0, resetAt: 0 } },
    };
    const http = fakeFetch(healthy({ [creditsPath]: () => json(body) }));
    const result = await createCommandCodeConnector({ fetch: http.fetch }).collect(
      credential,
      stored,
    );
    expect(byKey(result.metrics, "five_hour")).toBeUndefined();
    expect(byKey(result.metrics, "weekly")).toBeUndefined();
    expect(byKey(result.metrics, "credits.balance")).toMatchObject({
      valueText: null,
      availability: "unknown",
    });
  });

  test("schema drift in credits is invalid_response for those metrics only", async () => {
    const http = fakeFetch(healthy({ [creditsPath]: () => json(creditsDrift) }));
    const result = await createCommandCodeConnector({ fetch: http.fetch }).collect(
      credential,
      stored,
    );
    expect(result.failures).toMatchObject([{ category: "invalid_response", class: "capability" }]);
    for (const key of ["five_hour", "weekly", "credits.balance"]) {
      expect(byKey(result.metrics, key)).toMatchObject({
        valueText: null,
        availability: "unknown",
      });
    }
    // Everything else keeps its value.
    expect(byKey(result.metrics, "usage.period")).toMatchObject({ valueText: "41.25" });
    expect(byKey(result.metrics, "billing.renews_at")).toMatchObject({ availability: "available" });
  });

  test("a rate limit on one route is transient for that route and leaves the rest alone", async () => {
    const http = fakeFetch(
      healthy({ [usageSummaryPath]: () => new Response("slow down", { status: 429 }) }),
    );
    const result = await createCommandCodeConnector({ fetch: http.fetch }).collect(
      credential,
      stored,
    );
    expect(result.failures).toMatchObject([{ category: "rate_limited", class: "transient" }]);
    expect(byKey(result.metrics, "usage.period")).toMatchObject({
      valueText: null,
      availability: "temporarily_unavailable",
    });
    expect(byKey(result.metrics, "weekly")).toMatchObject({ valueText: "50" });
  });

  test("a route the key may not read is not_authorized, never zero", async () => {
    const http = fakeFetch(healthy({ [creditsPath]: () => json({}, 403) }));
    const result = await createCommandCodeConnector({ fetch: http.fetch }).collect(
      credential,
      stored,
    );
    expect(result.failures).toMatchObject([{ category: "permission_denied" }]);
    expect(byKey(result.metrics, "weekly")).toMatchObject({
      valueText: null,
      availability: "not_authorized",
    });
  });

  test("a key rejected part-way through collection fails the whole collection", async () => {
    const http = fakeFetch(healthy({ [subscriptionsPath]: () => json({}, 401) }));
    const error = await rejection(
      createCommandCodeConnector({ fetch: http.fetch }).collect(credential, stored),
    );
    expect(error).toMatchObject({ category: "authentication_required" });
  });

  test("an account with no subscription has no renewal and no plan in its label", async () => {
    const http = fakeFetch(
      healthy({ [subscriptionsPath]: () => json({ success: true, data: null }) }),
    );
    const result = await createCommandCodeConnector({ fetch: http.fetch }).collect(
      credential,
      stored,
    );
    expect(result.failures).toEqual([]);
    expect(byKey(result.metrics, "billing.renews_at")).toBeUndefined();
    expect(result.label).toBe("sample-user");
    // Without a period start the usage total is the route's own period, with no `since`.
    expect(byKey(result.metrics, "usage.period")).toMatchObject({ valueText: "41.25" });
  });

  test("a failure never carries the response body or the key", async () => {
    const http = fakeFetch(
      healthy({
        [creditsPath]: () => new Response("secret body user_synthetic_key", { status: 500 }),
      }),
    );
    const result = await createCommandCodeConnector({ fetch: http.fetch }).collect(
      credential,
      stored,
    );
    expect(result.failures).toMatchObject([{ category: "provider_unavailable" }]);
    expect(JSON.stringify(result)).not.toContain("user_synthetic_key");
    expect(JSON.stringify(result)).not.toContain("secret body");
  });
});
