import { z, type ZodType } from "zod";

import {
  type BeginConnectOptions,
  type Capability,
  type ClassifiedError,
  type CollectResult,
  type ConnectProgress,
  type Connector,
  ConnectorError,
  type DisconnectResult,
  type FetchLike,
  type Identity,
  type MetricObservation,
  type RefreshResult,
  type StoredCredential,
  type SubmitInput,
  classified,
  classifyUnknown,
  parseDate,
  throwForStatus,
  timeoutFetch,
} from "@headroom/core";

import {
  apiHeaders,
  creditsPath,
  keyPageUrl,
  subscriptionsPath,
  usageSummaryPath,
  whoamiPath,
  withQuery,
} from "./endpoints.ts";
import {
  creditsSchema,
  subscriptionSchema,
  usageSummarySchema,
  whoamiSchema,
  type CreditsResponse,
  type LimitWindow,
  type SubscriptionResponse,
  type UsageSummary,
  type Whoami,
} from "./schemas.ts";

export const commandcodeConnectorVersion = "0.1.1";

export interface CommandCodeConnectorOptions {
  readonly fetch?: FetchLike;
}

const credentialSchema = z.object({ apiKey: z.string().min(1) });

const fiveHourSeconds = 18_000;
const weeklySeconds = 604_800;

export function createCommandCodeConnector(options: CommandCodeConnectorOptions = {}): Connector {
  const http: FetchLike = options.fetch ?? timeoutFetch();

  /** One authenticated GET. Failures carry the status only, never the body. */
  async function get<T>(apiKey: string, url: string, schema: ZodType<T>, what: string): Promise<T> {
    const response = await http(url, { method: "GET", headers: apiHeaders(apiKey) });
    throwForStatus(response, what);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success)
      throw new ConnectorError("invalid_response", `${what} response shape changed`);
    return parsed.data;
  }

  return {
    provider: "commandcode",
    version: commandcodeConnectorVersion,
    interface: "private",
    supportedMethods: ["api_key"],

    beginConnect(begin: BeginConnectOptions): Promise<ConnectProgress> {
      return Promise.resolve({
        status: "next_step",
        nextStep: {
          kind: "api_key",
          keyPageUrl,
          fields: [{ name: "apiKey", label: "Command Code API key", secret: true }],
        },
        privateState: { attemptId: begin.attemptId },
      });
    },

    submitInput(_privateState: unknown, input: SubmitInput): Promise<ConnectProgress> {
      const apiKey = input.kind === "api_key" ? input.values["apiKey"]?.trim() : undefined;
      if (!apiKey) {
        return Promise.resolve({
          status: "error",
          error: classified("invalid_response", "expected a Command Code API key"),
        });
      }
      return Promise.resolve({
        status: "credentials",
        credential: { secret: { apiKey }, expiresAt: null },
      });
    },

    pollConnect(): Promise<ConnectProgress> {
      return Promise.resolve({
        status: "error",
        error: classified("internal_error", "api key flows do not poll"),
      });
    },

    cancelConnect(): Promise<void> {
      return Promise.resolve();
    },

    /** `whoami` both validates the key and names its owner: the organization when it has one. */
    async identity(credential: StoredCredential): Promise<Identity> {
      const { apiKey } = credentialSchema.parse(credential.secret);
      const who = await get(apiKey, withQuery(whoamiPath, {}), whoamiSchema, "whoami");
      const owner = ownerOf(who);
      if (owner === null)
        throw new ConnectorError("invalid_response", "whoami response named no account");
      return {
        providerAccountId: owner.accountId,
        workspaceId: null,
        label: owner.login,
        assurance: "strong",
      };
    },

    capabilities(): Promise<readonly Capability[]> {
      const seen = { interface: "private" as const, evidenceLevel: "source_inspected" as const };
      return Promise.resolve([
        { metricOrAction: "five_hour", availability: "available", ...seen },
        { metricOrAction: "weekly", availability: "available", ...seen },
        {
          metricOrAction: "monthly",
          availability: "available",
          ...seen,
          evidenceLevel: "unvalidated" as const,
        },
        { metricOrAction: "credits.balance", availability: "available", ...seen },
        { metricOrAction: "usage.period", availability: "available", ...seen },
        { metricOrAction: "billing.renews_at", availability: "available", ...seen },
      ]);
    },

    async collect(credential: StoredCredential): Promise<CollectResult> {
      const { apiKey } = credentialSchema.parse(credential.secret);
      // Needed first: it names the organization the other routes take as a query parameter.
      const who = await get(apiKey, withQuery(whoamiPath, {}), whoamiSchema, "whoami");
      const owner = ownerOf(who);
      if (owner === null)
        throw new ConnectorError("invalid_response", "whoami response named no account");

      const failures: ClassifiedError[] = [];
      const read = async <T>(run: () => Promise<T>): Promise<Section<T>> => {
        try {
          return { ok: true, value: await run() };
        } catch (error) {
          const failure = classifyUnknown(error);
          // A rejected key is the whole connection's problem; every other failure is one section's.
          if (failure.category === "authentication_required") throw error;
          failures.push(failure);
          return { ok: false, failure };
        }
      };

      const org = owner.orgId ?? undefined;
      const [credits, subscription] = await Promise.all([
        read(() => get(apiKey, withQuery(creditsPath, { orgId: org }), creditsSchema, "credits")),
        read(() =>
          get(
            apiKey,
            withQuery(subscriptionsPath, { orgId: org }),
            subscriptionSchema,
            "subscription",
          ),
        ),
      ]);
      const periodStart = subscription.ok
        ? (subscription.value.data?.currentPeriodStart ?? undefined)
        : undefined;
      const summary = await read(() =>
        get(
          apiKey,
          withQuery(usageSummaryPath, { orgId: org, since: periodStart }),
          usageSummarySchema,
          "usage summary",
        ),
      );

      const metrics = [
        ...creditMetrics(credits),
        ...monthlyMetrics(credits, summary, subscription),
        ...subscriptionMetrics(subscription),
        ...summaryMetrics(summary, subscription),
      ];
      const plan = subscription.ok ? planName(subscription.value) : null;
      return {
        observedAt: Date.now(),
        metrics,
        failures,
        label: plan === null ? owner.login : `${owner.login} (${plan})`,
      };
    },

    refresh(): Promise<RefreshResult> {
      return Promise.resolve({ status: "not_refreshable" });
    },

    disconnect(): Promise<DisconnectResult> {
      // Keys are revoked on Command Code's side; Headroom only forgets its copy.
      return Promise.resolve("local_only");
    },

    classify(error: unknown): ClassifiedError {
      return classifyUnknown(error);
    },
  };
}

type Section<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ClassifiedError };

/** The account a key belongs to: its organization when it has one, else its user. */
function ownerOf(who: Whoami): { accountId: string; orgId: string | null; login: string } | null {
  if (who.org) {
    return {
      accountId: `org:${who.org.id}`,
      orgId: who.org.id,
      login: who.org.login ?? who.user?.userName ?? who.user?.name ?? "Command Code",
    };
  }
  if (who.user) {
    return {
      accountId: `user:${who.user.id}`,
      orgId: null,
      // The email tells accounts apart best; the username and name are the fallbacks.
      login: nonEmpty(who.user.email) ?? who.user.userName ?? who.user.name ?? "Command Code",
    };
  }
  return null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** Why a section is missing. A refused key never gets here; an outage is temporary; a changed shape is unknown. */
function absence(failure: ClassifiedError): MetricObservation["availability"] {
  if (failure.category === "permission_denied") return "not_authorized";
  if (failure.class === "transient") return "temporarily_unavailable";
  return "unknown";
}

function unknownMetric(
  failure: ClassifiedError,
  fields: Pick<MetricObservation, "providerMetricKey" | "kind" | "scope" | "unit">,
): MetricObservation {
  return { ...fields, valueText: null, availability: absence(failure), interface: "private" };
}

/** Four decimals: enough for a meter, and free of float noise such as 99.81481058400001. */
function percentOf(used: number, cap: number): string {
  return String(Math.round((used / cap) * 1_000_000) / 10_000);
}

/** The window's `resetAt` is epoch milliseconds, or 0 while the window has not started. */
function resetOf(value: number | null | undefined): number | null {
  if (value === undefined || value === null || value <= 0) return null;
  // Seconds, should the route ever switch: no epoch in milliseconds is below 1e12 after 2001.
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

function windowMetric(
  key: string,
  seconds: number,
  limit: LimitWindow | null | undefined,
): MetricObservation | null {
  // Absent: the window does not apply to this plan. A cap of zero is the same, never a percentage.
  if (limit === undefined || limit === null || limit.cap === 0) return null;
  return {
    providerMetricKey: key,
    kind: "quota_percentage",
    scope: `window:${seconds}s`,
    valueText: percentOf(limit.used, limit.cap),
    unit: "percent",
    resetsAt: resetOf(limit.resetAt),
    availability: "available",
    interface: "private",
  };
}

function creditMetrics(section: Section<CreditsResponse>): MetricObservation[] {
  if (!section.ok) {
    return [
      unknownMetric(section.failure, {
        providerMetricKey: "five_hour",
        kind: "quota_percentage",
        scope: `window:${fiveHourSeconds}s`,
        unit: "percent",
      }),
      unknownMetric(section.failure, {
        providerMetricKey: "weekly",
        kind: "quota_percentage",
        scope: `window:${weeklySeconds}s`,
        unit: "percent",
      }),
      unknownMetric(section.failure, {
        providerMetricKey: "credits.balance",
        kind: "credits",
        scope: "account",
        unit: "credits",
      }),
    ];
  }
  const { credits, windowLimits } = section.value;
  const metrics: MetricObservation[] = [];
  for (const metric of [
    windowMetric("five_hour", fiveHourSeconds, windowLimits?.fiveHour),
    windowMetric("weekly", weeklySeconds, windowLimits?.weekly),
  ]) {
    if (metric !== null) metrics.push(metric);
  }
  const parts = [credits?.monthlyCredits, credits?.purchasedCredits, credits?.freeCredits];
  // The balance is the sum of three pools. A pool the route left out would make the sum a guess.
  const known = parts.every((part): part is number => part !== undefined);
  metrics.push({
    providerMetricKey: "credits.balance",
    kind: "credits",
    scope: "account",
    valueText: known ? String(parts.reduce((sum, part) => sum + part, 0)) : null,
    unit: "credits",
    availability: known ? "available" : "unknown",
    interface: "private",
  });
  return metrics;
}

/**
 * The monthly pool as a percentage. The API reports what is left of the pool and what the period has used of it,
 * never the pool's size, so the size is their sum. That is an inference, not a documented figure.
 */
function monthlyMetrics(
  credits: Section<CreditsResponse>,
  summary: Section<UsageSummary>,
  subscription: Section<SubscriptionResponse>,
): MetricObservation[] {
  const base = {
    providerMetricKey: "monthly",
    kind: "quota_percentage",
    scope: "billing_cycle",
    unit: "percent",
    interface: "private",
  } as const;
  const failure = !credits.ok ? credits.failure : !summary.ok ? summary.failure : null;
  if (failure !== null) {
    return [{ ...base, valueText: null, availability: absence(failure) }];
  }
  if (!credits.ok || !summary.ok) return [];
  const left = credits.value.credits?.monthlyCredits;
  const used = summary.value.totalMonthlyCredits;
  // A route that leaves either figure out has no monthly pool to show; a pool of nothing has no percentage.
  if (left === undefined || used === undefined || used + left <= 0) return [];
  const period = subscription.ok ? subscription.value.data : null;
  return [
    {
      ...base,
      valueText: percentOf(used, used + left),
      windowStart: parseDate(period?.currentPeriodStart),
      windowEnd: parseDate(period?.currentPeriodEnd),
      resetsAt: parseDate(period?.currentPeriodEnd),
      availability: "available",
    },
  ];
}

function subscriptionMetrics(section: Section<SubscriptionResponse>): MetricObservation[] {
  if (!section.ok) {
    return [
      unknownMetric(section.failure, {
        providerMetricKey: "billing.renews_at",
        kind: "reset_timestamp",
        scope: "billing_cycle",
        unit: "timestamp",
      }),
    ];
  }
  const end = parseDate(section.value.data?.currentPeriodEnd);
  // No subscription, or none with an end date: there is no renewal to show.
  if (end === null) return [];
  return [
    {
      providerMetricKey: "billing.renews_at",
      kind: "reset_timestamp",
      scope: "billing_cycle",
      valueText: null,
      unit: "timestamp",
      windowEnd: end,
      resetsAt: end,
      availability: "available",
      interface: "private",
    },
  ];
}

function summaryMetrics(
  section: Section<UsageSummary>,
  subscription: Section<SubscriptionResponse>,
): MetricObservation[] {
  if (!section.ok) {
    return [
      unknownMetric(section.failure, {
        providerMetricKey: "usage.period",
        kind: "spend",
        scope: "billing_cycle",
        unit: "credits",
      }),
    ];
  }
  const period = subscription.ok ? subscription.value.data : null;
  return [
    {
      providerMetricKey: "usage.period",
      kind: "spend",
      scope: "billing_cycle",
      valueText: String(section.value.totalCost),
      unit: "credits",
      windowStart: parseDate(section.value.periodStart ?? period?.currentPeriodStart),
      windowEnd: parseDate(period?.currentPeriodEnd),
      availability: "available",
      interface: "private",
    },
  ];
}

/** Who a plan is for. The ids read `<audience>-<tier>`, and the tier is what an owner wants to see. */
const audiences = new Set(["individual", "personal", "team", "teams", "org", "organization"]);

/**
 * `individual-goat` reads as "Goat". An id with no audience prefix is the tier itself, and a prefix this list does
 * not know stays in the name rather than being guessed away. An unnamed plan is no plan.
 */
function planName(subscription: SubscriptionResponse): string | null {
  const id = subscription.data?.planId;
  if (id === undefined || id === null) return null;
  const words = id.split(/[-_\s]+/).filter((word) => word !== "");
  if (words.length === 0) return null;
  const first = words[0]?.toLowerCase() ?? "";
  const tier = words.length > 1 && audiences.has(first) ? words.slice(1) : words;
  return tier.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
