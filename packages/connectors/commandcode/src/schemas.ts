import { z } from "zod";

/** `GET /alpha/whoami`. An organization key carries `org`; a personal key has `org: null`. */
export const whoamiSchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        email: z.string().optional(),
        userName: z.string().optional(),
        name: z.string().optional(),
      })
      .loose()
      .nullish(),
    org: z
      .object({ id: z.string().min(1), login: z.string().optional() })
      .loose()
      .nullish(),
  })
  .loose();
export type Whoami = z.infer<typeof whoamiSchema>;

/** A rolling limit. `resetAt` is epoch milliseconds, or 0 while the window has not started. */
const windowSchema = z
  .object({ used: z.number().min(0), cap: z.number().min(0), resetAt: z.number().min(0).nullish() })
  .loose();
export type LimitWindow = z.infer<typeof windowSchema>;

/**
 * `GET /alpha/billing/credits`. Each section is optional on its own so that one missing part leaves the
 * other metrics intact: the connector reports a missing figure as unknown, never zero.
 */
export const creditsSchema = z
  .object({
    credits: z
      .object({
        monthlyCredits: z.number().min(0).optional(),
        purchasedCredits: z.number().min(0).optional(),
        freeCredits: z.number().min(0).optional(),
      })
      .loose()
      .nullish(),
    windowLimits: z
      .object({ fiveHour: windowSchema.nullish(), weekly: windowSchema.nullish() })
      .loose()
      .nullish(),
  })
  .loose();
export type CreditsResponse = z.infer<typeof creditsSchema>;

/** `GET /alpha/billing/subscriptions`. `data` is null for an account with no subscription. */
export const subscriptionSchema = z
  .object({
    data: z
      .object({
        planId: z.string().nullish(),
        status: z.string().nullish(),
        currentPeriodStart: z.string().nullish(),
        currentPeriodEnd: z.string().nullish(),
      })
      .loose()
      .nullable(),
  })
  .loose();
export type SubscriptionResponse = z.infer<typeof subscriptionSchema>;

/** `GET /alpha/usage/summary`. The route may answer a total in `totalCost` and `totalCredits`. */
export const usageSummarySchema = z
  .object({
    totalCost: z.number().min(0),
    totalCount: z.number().min(0).optional(),
    /** What this period has used of the monthly pool alone, apart from purchased and free credits. */
    totalMonthlyCredits: z.number().min(0).optional(),
    periodStart: z.string().nullish(),
  })
  .loose();
export type UsageSummary = z.infer<typeof usageSummarySchema>;
