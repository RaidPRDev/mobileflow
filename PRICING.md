# MobileFlow Pricing & Plan Changes

## Plans

| Plan | Price / month |
|---|---|
| Bohío | Free |
| Yucayeque | $15 |
| Cacique | $25 |

## Billing cycle

- **All dates and times are UTC.** Cycle boundaries, scheduled plan changes, renewals, and any "end of cycle" job all fire at **00:00 UTC**.
- **Each subscription is anchored to the moment of purchase.** When a Bohío user upgrades to a paid plan, the cycle starts at the time of purchase and runs for one month. The renewal date is the same day of the following month at 00:00 UTC.
- **Proration on mid-cycle upgrades between paid tiers.** When a Yucayeque user upgrades to Cacique mid-cycle, we charge the prorated difference for the days remaining in the current cycle. The renewal date does not move.
- **Proration day count uses the actual number of days in the current billing cycle**, so divisors are 28, 29, 30, or 31 depending on the month the cycle spans.

## Plan change rules

Upgrades take effect immediately and are prorated against the current cycle. Downgrades take effect at the end of the current cycle with no refund. The renewal date does not move when a user upgrades mid-cycle.

| From → To | When it takes effect | Money moves |
|---|---|---|
| Bohío → Yucayeque / Cacique | Immediate | Charge full price; new cycle starts at the moment of purchase |
| Yucayeque → Cacique | Immediate | Prorated difference; renewal date unchanged |
| Cacique → Yucayeque | End of current cycle | No charge, no refund |
| Any paid → Bohío (cancel) | End of current cycle | No refund |

### Why this asymmetry

- **Upgrades are immediate** because the user wants the feature now and we want the revenue now.
- **Downgrades are deferred** because the user has already paid for the higher tier through cycle end — they keep what they paid for, and we avoid refund logic and ping-pong abuse (upgrade for a day, downgrade for a refund).
- **The renewal anchor doesn't move on upgrade.** If upgrading reset the cycle to "today + 30 days," users would lose days they had already paid for. A stable anchor is what makes proration fair.

## Worked examples

### Initial upgrade: Bohío → Cacique

User on Bohío upgrades to Cacique on **May 23, 2026 at 14:00 UTC**.

- Charge today: full **$25.00**.
- Cacique features unlock immediately.
- Cycle: **May 23, 2026 14:00 UTC – June 23, 2026 14:00 UTC**. Renewal at $25.00 then and on the 23rd of every month thereafter at 14:00 UTC.

### Upgrade: Yucayeque → Cacique mid-cycle

User is on Yucayeque ($15) for **May 23 – June 23**. They upgrade to Cacique on **June 5**.

- Days remaining in cycle: 18 of 31.
- Unused Yucayeque credit: $15 × 18/31 ≈ **$8.71**.
- Prorated Cacique cost for those 18 days: $25 × 18/31 ≈ **$14.52**.
- **Charge today: $14.52 − $8.71 ≈ $5.81.**
- Cacique features unlock immediately.
- Next renewal: **June 23 at 14:00 UTC**, full $25 (renewal date and time unchanged from the original anchor).

### Downgrade: Cacique → Yucayeque mid-cycle

User is on Cacique ($25) for **May 23 – June 23**. They downgrade to Yucayeque on **June 5**.

- No charge, no refund today.
- Cacique features remain until **June 23 at 14:00 UTC**.
- On June 23 at 14:00 UTC, the plan switches to Yucayeque and the $15 charge runs.

## UI copy

All dates shown to users are rendered in **UTC** to match the billing system. (Localized display is a future consideration; for now, the modal copy should make UTC explicit so there's no ambiguity around midnight rollovers.)

### Upgrade confirmation modal — Yucayeque → Cacique

> **Upgrade to Cacique**
>
> You'll be charged a prorated **$5.81** today for the remaining 18 days of your current billing period.
>
> Cacique features unlock immediately. Your next full charge of **$25.00** will be on **June 23, 2026 (UTC)**.
>
> [Cancel] [Confirm upgrade]

### Upgrade confirmation modal — Bohío → paid plan

> **Upgrade to Cacique**
>
> You'll be charged **$25.00** today. Your next renewal will be on **June 23, 2026 (UTC)**.
>
> [Cancel] [Confirm upgrade]

### Downgrade confirmation modal — Cacique → Yucayeque

> **Switch to Yucayeque**
>
> You'll keep Cacique features until **June 23, 2026 (UTC)**. After that, your plan will change to Yucayeque and you'll be charged **$15.00** per month.
>
> No refund is issued for the remainder of your current billing period.
>
> [Keep Cacique] [Switch to Yucayeque on June 23]

### Cancel-to-Bohío confirmation modal

> **Cancel your subscription**
>
> You'll keep your current plan until **June 23, 2026 (UTC)**. After that, your account moves to Bohío (free) and you won't be charged again.
>
> No refund is issued for the remainder of your current billing period.
>
> [Keep my plan] [Cancel on June 23]

### Pending-change banner (shown after a downgrade or cancel is scheduled)

> Your plan will change to **Yucayeque** on **June 23, 2026 (UTC)**. [Undo]

Clicking **Undo** cancels the scheduled change with no money movement.

## Edge cases

1. **Reversing a scheduled downgrade.** If the user has a pending downgrade and changes their mind before it executes, cancel the scheduled change. No money moves.
2. **Changing a pending change.** If the user has a pending change (e.g. Cacique → Yucayeque scheduled for June 23) and submits a new request, cancel the pending change first, then apply the new request under the rules above.
3. **Failed payment on prorated upgrade.** If the prorated charge fails, do not unlock the higher tier. Leave the user on their current plan and surface a retry.
4. **Annual plans.** Not in scope yet. The same rules apply in principle, but prorated upgrade swings get large ($100+). Revisit the math and UI copy when annual is introduced.
