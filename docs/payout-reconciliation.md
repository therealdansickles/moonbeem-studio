# Payout reconciliation — `needs_reconciliation` withdrawals (FIX A)

A creator withdrawal (`src/app/api/me/payouts/withdraw/route.ts`) moves money in
two steps that are **not** in one transaction:

1. `stripe.transfers.create(...)` — money leaves the platform balance, then
2. stamping `creator_earnings.withdrawn_at` on the settled rows.

If step 1 succeeds but step 2 fails, the route parks the withdrawal in
**`needs_reconciliation`** (instead of `completed`): the money has moved, but the
earnings are still `withdrawn_at IS NULL`. The re-entry guard blocks that creator
from withdrawing again — which would re-sum and re-pay the same earnings (the
double-pay this status prevents) — so each stuck row must be cleared **by hand**
using the steps below. This is the operational recovery path until **FIX B** (a
structural `creator_earnings.withdrawal_id` link + an automatic reconciler) ships.

## 1. Find the stuck withdrawal(s)

```sql
select id, creator_id, amount_cents, status, stripe_transfer_id,
       created_at, completed_at
from public.withdrawals
where status = 'needs_reconciliation'
order by created_at desc;
```

Note the `id` (withdrawal id) and `stripe_transfer_id`.

## 2. Identify the earnings that failed to stamp

**Preferred** — read the route's server log for the matching line; it lists the
exact ids:

```
[payouts] RECONCILE-REQUIRED withdrawal=<id> transfer=<tr_id> stamp failed
  AFTER successful transfer (money moved, earnings NOT stamped): <err>;
  unstamped earnings_ids=[<uuid>,<uuid>,...]
```

**Fallback** if the log is unavailable — the creator's still-unstamped earnings
as of the withdrawal. Sanity-check that the sum equals the withdrawal's
`amount_cents` before acting:

```sql
select id, earnings_cents, created_at
from public.creator_earnings
where creator_id = '<creator_id>'
  and withdrawn_at is null
  and created_at <= '<withdrawal.created_at>'
order by created_at;
-- sum(earnings_cents) here should equal the withdrawal's amount_cents.
```

## 3. Verify in Stripe that the transfer actually settled (READ-ONLY)

Confirm the transfer exists and matches before stamping anything. Use the
appropriate key (TEST or LIVE); **do not create anything**.

```
stripe transfers retrieve <stripe_transfer_id>
```

Confirm `amount` == the withdrawal's `amount_cents` and `destination` == the
creator's connected account (`creator_payout_accounts.stripe_connect_account_id`).

## 4. Reconcile (only after step 3 confirms the money moved)

```sql
-- 4a. Stamp the earnings the transfer paid (ids from step 2):
update public.creator_earnings
set withdrawn_at = now()
where id in ('<uuid>', '<uuid>', ...)
  and withdrawn_at is null;

-- 4b. Close out the withdrawal:
update public.withdrawals
set status = 'completed', completed_at = now()
where id = '<withdrawal_id>'
  and status = 'needs_reconciliation';
```

After 4b the re-entry guard no longer blocks the creator, and their available
balance drops by the reconciled amount on the next read.

## 5. Notes

- If step 3 shows the transfer did **not** move money, do the opposite: leave the
  earnings unstamped and set the withdrawal to `failed` so the creator can retry:
  ```sql
  update public.withdrawals
  set status = 'failed', completed_at = now()
  where id = '<withdrawal_id>' and status = 'needs_reconciliation';
  ```
- **FIX B (durable follow-up, not this change):** add
  `creator_earnings.withdrawal_id uuid` (FK → `withdrawals`), claim it atomically
  at selection time, exclude claimed rows in both selection and the balance
  reads (`/api/me/payouts/status`, `/me`), and add an admin reconcile UI / auto
  reconciler — which removes the manual steps above.
