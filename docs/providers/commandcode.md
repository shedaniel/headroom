# Command Code

Reviewed: 2026-11-19. This record covers a Command Code account's credits, its 5-hour and weekly limits, its plan and billing period, and its usage for that period. It does not treat a plan price as a balance.

## Scope and recommendation

Primary route: direct HTTP from Headroom's TypeScript service to `https://api.commandcode.ai`, per [ADR 0001](../decisions/0001-direct-provider-clients.md), with the account's **Command Code API key** (next step `api_key`, a key that starts with `user_`). A Connect card links to `commandcode.ai`, accepts the pasted key and validates it on the server. No CLI or local helper is involved.

Command Code documents no quota endpoint. Every route below is under `/alpha/` and used by community tooling, so the interface label is `private` for every metric. The routes follow the `pi-commandcode-provider` quota module [S1].

The key must come from an account that can use the provider API. The Go plan does not include API access [S1]; a key that cannot read the billing routes yields `permission_denied` for that metric, never zero.

An organization key carries an organization. The billing and usage routes take it as `orgId`, and the connection is identified by the organization rather than the user.

## Evidence status

| Claim | Evidence level | Basis |
| --- | --- | --- |
| `GET /alpha/whoami` returns `user` and `org`, where `org` is null for a personal key | prior observation | Owner-authorised live call on 2026-11-19; values not retained |
| `GET /alpha/billing/credits` returns `credits.monthlyCredits`, `purchasedCredits`, `freeCredits` and `windowLimits.fiveHour` and `.weekly` with `used`, `cap` and `resetAt` | prior observation | Same call; confirmed against [S1] |
| `resetAt` is epoch milliseconds, and 0 while the 5-hour window has not started | prior observation | Same call |
| `GET /alpha/billing/subscriptions` returns `data.planId`, `status`, `currentPeriodStart` and `currentPeriodEnd` | prior observation | Same call; confirmed against [S1] |
| `GET /alpha/usage/summary` returns `totalCost` and `periodStart`, and takes `since` | prior observation | Same call; confirmed against [S1] |
| Every route takes `Authorization: Bearer <key>` and an optional `orgId` query parameter | source-inspected | [S1] |
| The monthly pool's size is `totalMonthlyCredits + monthlyCredits` | unvalidated | Observed on one account where the sum came to a round figure; no source states it, and a mid-period top-up of the pool would break it |
| The window `used` and `cap` share a unit, so `used / cap` is the fraction of the limit | unvalidated | No documentation states the unit; the ratio is the only use |
| One credit equals one US dollar | unvalidated | Not documented, so credits are never shown as money |
| `totalCost` is in the same unit as the credits | unvalidated | The summary also reports `totalCredits` with the same value |
| The routes stay stable | unvalidated | `/alpha/` routes are undocumented and may change |
| An organization key reads the organization's billing | unvalidated | Needs an organization account |
| A key without provider API access answers 403 | unvalidated | Needs a Go plan key |

## Metrics

| Dashboard field | Upstream availability | Source and interpretation | Notes and limit |
| --- | --- | --- | --- |
| Session (5 hours) | Yes | `windowLimits.fiveHour`: `used / cap` as a percentage, `resetAt` as the reset | `private`. Key `five_hour`, scope `window:18000s`. Left out when `cap` is 0. |
| Weekly | Yes | `windowLimits.weekly`: `used / cap`, `resetAt` | `private`. Key `weekly`, scope `window:604800s`. The primary meter. |
| Monthly | Derived | `usage/summary.totalMonthlyCredits` as used, `credits.monthlyCredits` as left: used / (used + left) | `private`. Key `monthly`, scope `billing_cycle`, resets at the period end. The API never states the pool's size, so this is an inference. Left out when the summary omits `totalMonthlyCredits`. |
| Credits left | Yes | `credits.monthlyCredits + purchasedCredits + freeCredits` | `private`. Key `credits.balance`, unit `credits`. Unknown, not a smaller sum, when any pool is missing. |
| Used this period | Yes | `usage/summary.totalCost`, for the billing period | `private`. Key `usage.period`, kind `spend`, unit `credits`. |
| Renewal | Yes | `subscriptions.data.currentPeriodEnd` | `private`. Key `billing.renews_at`. Absent when there is no subscription. |
| Plan | Yes | `subscriptions.data.planId`, shown as its tier (`individual-goat` is "Goat", `individual-go` is "Go") | The connection label is `<account> (<Tier>)`. An audience prefix such as `individual` or `team` is dropped; an unknown prefix stays in the name. The account is the email for a personal key (the username when there is none) and the organization name for an organization key. |
| Monthly allowance (absolute) | `unknown` | The API never states the pool's size | Only the derived Monthly percentage above is shown. Do not label the balance as an allowance. |
| Banked resets | `unknown` | No contract | Not an action target. |
| Sandbox minutes | Returned | `sandboxMinutes` in the credits response | Not collected. |

## Connect workflow

1. Create an attempt with next step `api_key`: a field for the key and a link to `commandcode.ai`. The attempt moves to `awaiting_input`.
2. The user pastes the key once. The server encrypts it immediately and the attempt moves to `validating`.
3. Call `whoami`. A 401 is `authentication_required`. A response naming neither a user nor an organization is `invalid_response`.
4. Save the identity: `org:<id>` for an organization key, otherwise `user:<id>`. Assurance is `strong`, because the identity comes from the provider's own endpoint.
5. The attempt becomes `succeeded` and the connection `ready`.
6. Each refresh job loads the encrypted key, calls `whoami`, then credits and subscription together, then the usage summary for the subscription's period. It writes a snapshot and exits. A 401 on any route is definitive and sets `reconnect_required` with `token_rejected`. Any other failure is that route's alone, and the other metrics keep their values.

## APIs and tools

| Interface | Method and endpoint | Label | Use in Headroom |
| --- | --- | --- | --- |
| Whoami | `GET /alpha/whoami` | `private` | Key validation and the account identity |
| Credits | `GET /alpha/billing/credits[?orgId]` | `private` | Credit pools and both window limits |
| Subscription | `GET /alpha/billing/subscriptions[?orgId]` | `private` | Plan, status and billing period |
| Usage summary | `GET /alpha/usage/summary[?orgId&since]` | `private` | Usage for the billing period |

All four are GET requests with a bearer key. The connector sends nothing else, never a model request, and never logs a body.

### Refresh and reconnect

The key is `not_refreshable`. Reconnect asks for a new key. Disconnect deletes the stored key (`local_only`); the owner revokes it at Command Code.

## Available packages and limits

| Tool | Value | Limit |
| --- | --- | --- |
| `pi-commandcode-provider` `quota.ts` [S1] | Reference for the four routes, MIT-licensed | Source only; Headroom ports the reads and does not import the package |
| Command Code CLI | Stores the key in `~/.commandcode/auth.json` | Not used; the key is pasted |
| Provider API [S2] | Documents model access, not quota | Gives no quota contract |

## Prior observations

A live read of the four routes on 2026-11-19, made with the owner's key at the owner's request, returned the shapes above for a personal key on an individual plan, with the weekly window close to its cap. Values, names and ids are not retained, and the fixtures are synthetic. The run is not a recorded validation.

## Cannot promise

- The `/alpha/` routes stay stable. A changed shape is `invalid_response` for the metrics that read it.
- A credit equals a dollar, or `totalCost` is money.
- Organization keys, or keys without provider API access, read the same routes.
- A 5-hour or weekly limit exists for every plan. A window with no cap is left out.
- Key revocation from Headroom.

## Implementation and validation checklist

- [x] Key-based connect, `whoami` identity and a non-refreshable credential.
- [x] The four routes behind one endpoints file, validated with Zod, passing `orgId` for organization keys.
- [x] Synthetic fixtures for a personal key, an organization key, an idle account and schema drift.
- [x] A missing figure is unknown, never zero; each route fails on its own.
- [ ] Record a live check in the evidence register and move the shapes to `validated`.
- [ ] Check an organization key and a key without provider API access.
- [ ] Confirm what unit the window `used` and `cap` and the credit pools use, before showing a unit.
- [ ] Add rate-limit backoff observations from a real 429.
- [ ] Do not implement purchases, plan changes or reset actions.

## Sources

- [S1] `patlux/pi-commandcode-provider`, [`src/quota.ts`](https://github.com/patlux/pi-commandcode-provider/blob/main/src/quota.ts) and README, reviewed 2026-11-19.
- [S2] Command Code, [Provider API](https://commandcode.ai/docs/provider), as referenced by [S1], reviewed 2026-11-19.
