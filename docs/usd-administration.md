# USD billing and administration

All new customer charges and wallet balances are USD. Money is stored as integer millionths of one dollar, so `$0.10` is exactly `100000` internally. Decimal API inputs are strings with up to six decimal places; no floating-point currency multiplication is used for rate calculations. Existing `credit_*` database and internal function names refer to the monetary ledger and reservations, not a customer-facing points system.

## Deployment

1. Back up the database. Stop application processes during the migration and code rollout. Apply migrations with the normal migration job (`pnpm exec tsx packages/db/src/migrate.ts`), then deploy engine, fleet, and web together. Migrations 0055–0058 add the administration tables, deletion guard, USD markers, immutable legacy ledger history, and model token limits.
2. Set `ADMIN_ACCOUNT_IDS` to comma-separated internal account IDs (available on the signed-in Billing page) or Clerk user IDs. A Clerk ID may be written as `user_…` or `clerk:user_…`. Local development uses `acct_local`. The allowlist is enforced on every admin RPC as well as navigation; `/admin` grants no privileges by itself.
3. Set browser, CAPTCHA, and model prices in **Admin → Pricing & costs** before enabling paid work. A missing price refuses new paid usage. Set actual provider costs separately; an empty cost means unknown, not zero.
4. Configure Paddle and optional summary/proxy credentials below. `.env.example`, Compose, and Helm expose the settings. Helm can use `environment` or the existing external configuration secret. `fleet.usdPerMinute` replaces `fleet.unitsPerMinute`.

`MODEL_USD_RATES_JSON`, `SOLVER_USD_RATES_JSON`, `PADDLE_USD_PACKS_JSON`, and `BROWSER_USD_PER_MINUTE` replace the old integer-credit environment settings. Old settings are not silently treated as dollar amounts. Browser/model/CAPTCHA environment prices are optional fallbacks; saved admin rates take precedence.

## Existing balances

Existing accounts with ledger, reservation, or purchase history are marked `legacy_credit`. Their old ledger entries remain unchanged. Wallets convert automatically on engine startup, during background maintenance, or when their balance is accessed. Existing holds settle in their original denomination before their wallet converts.

The agreed conversion is **1 old credit = $1.00 USD**, built in as the default. `LEGACY_CREDIT_USD` is an optional override. No Admin action is required. Accounts with outstanding reservations convert automatically after those reservations settle. Conversion runs under the account lock, snapshots old amounts to the audit log, converts historical monetary operation fields, and appends one USD opening balance. Repeating conversion does nothing. Purchases and refund linkage are retained. There is no automatic balance reset.

The welcome balance defaults to `$0`. Changing it in Admin applies to subsequently created accounts. A unique ledger key prevents repeated sign-ins from granting it again.

## Prices and costs

| Usage | Provider | Item | Customer price unit |
| --- | --- | --- | --- |
| Browser | Empty | `minute` | USD per started minute |
| Cloudflare / Turnstile | `2captcha` | `TurnstileTaskProxyless` | USD per successful solve, e.g. `0.10` |
| hCaptcha | `2captcha` | `HCaptchaTaskProxyless` | USD per successful solve, e.g. `0.50` |
| Provider fallback | CAPTCHA provider | `*` | USD per solve for types without an exact rate |
| Platform model | `openai` or `anthropic` | `model-id:input`, `model-id:cached`, `model-id:output` | USD per million tokens; set the model input/output token limits on the `:input` rate |
| IPRoyal | `iproyal` | `GB` | Cost per decimal GB; customer price `0` |

Use the exact native task type for each CAPTCHA provider. Native type rates override that provider's `*` default. CAPTCHA keys remain server-side. Failed, confirmed solves release their holds; ambiguous submissions are never blindly resubmitted. The engine polls known purchased CAPTCHA tasks even after run cancellation.

Browser time starts when the browser becomes ready and ends when it closes, including human-control waits. Queued/startup time is not billed. Holds reserve the configured maximum duration; unused money returns on settlement. Rates and costs are pinned when work is admitted, so later edits do not reprice it.

BYO model credentials incur no platform model charge. Browser and CAPTCHA charges still apply. A user's wallet never funds the action-description model.

## Action descriptions

Set the platform `OPENAI_API_KEY`. `ACTION_SUMMARY_MODEL` defaults to `gpt-5.4-nano`; any override must support OpenAI Responses. Python tool calls enqueue persisted summaries when action tracing is enabled. The UI displays the description and outcome, with redacted code in expandable details. Missing configuration or a failed summarization call shows a deterministic fallback. A claimed request is not automatically sent twice after a crash. Costs appear as platform summary overhead, including unknown-cost failures. The default model has a built-in cost baseline; configure model provider costs when overriding it.

## Paddle and coupons

Set `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENVIRONMENT`, and the approved `PADDLE_CHECKOUT_URL`. Configure USD prices and wallet grants, for example:

```json
[{"priceId":"pri_example","balanceUsd":"10.00"}]
```

Place this JSON in `PADDLE_USD_PACKS_JSON`. Each purchase pins its wallet grant; changing pack configuration later does not change an already-created purchase. Webhooks remain signature-verified and idempotent. A fully discounted purchase can add its configured wallet value with zero payment revenue.

Admin can create once-per-account balance coupons, percent purchase discounts, or fixed USD purchase discounts with expiration and overall redemption limits. Balance coupons are atomic ledger adjustments and never payment revenue. Paddle discounts are restricted to configured pack prices. Paddle codes allow 3–32 letters/numbers; balance codes also accept hyphens/underscores up to 40 characters. Failed Paddle synchronization is visible and retryable. Disable a discount through Admin to archive it in Paddle as well.

## Analytics and reconciliation

The dashboard shows settled USD spend, outstanding reservations, prepaid purchases, known operating costs, model tokens, configured BYO credentials and accounts that actually used BYO during the selected dates. Account and spending lists are paginated. Reports use UTC dates. Browser/CAPTCHA quantities and proxy bytes come from retained financial records, so deleting a workflow does not erase its costs.

USD net sales subtract known transaction taxes, fees, and refunds. Non-USD receipts remain separate. Profit is marked incomplete when historical fees or provider costs are missing, refund fee/tax corrections are unavailable, or category/provider filters exclude costs. This is an operational estimate, not recognized accounting revenue. Coupon grants and wallet holds are not sales or usage revenue.

**Admin → Providers** lists old unsettled model/CAPTCHA reservations. After checking provider records and stopping associated runs, an administrator can record a confirmed charge, provider cost, and reconciliation evidence. This action is audited and cannot charge more than the original hold. For legacy holds, enter their confirmed USD equivalent using the default $1 per old credit (or the configured override), which must map to a whole number of old credits. Workflow deletion waits for these charges and browser shutdown before erasing operational data.

## IPRoyal Residential

Set `IPROYAL_API_TOKEN`. In **Admin → Providers**, map existing residential user/sub-user report hashes to an account, or leave the account blank for shared overhead. Do not enter passwords. Add each reporting source once and avoid overlapping aggregate sources. This feature imports usage only; it does not provision sub-users or change browser proxy routing.

The engine imports daily UTC byte reports hourly, initially for 30 days and then re-imports the last 7 days for corrections. Rows are keyed by source hash and day. Re-imports update usage while retaining the rate and account captured on first import. Configure USD/GB cost before the first import. Missing costs and sync errors remain visible. “Refresh IPRoyal usage” requests an immediate refresh with a short concurrency cooldown.

## Workflow deletion and sessions

Workflow list/settings have a permanent-delete action. It disables schedules, revokes shares, rejects new runs/versions, cancels work and stops browsers. After settlement, it removes workflow definitions, run history, associated sessions, workflow store schema, and unshared referenced blobs. Financial ledger, payment history, provider costs, and an audited receipt archive remain. Shared account browser profiles and shared content-addressed blobs are retained. Deletion status and errors are visible; jobs resume after an engine restart.

Sessions use 25-row timestamp/ID cursor pagination, with Previous/Next links encoded in the URL. Counts are account-wide, independent of the current page.

## Provider references

- [Paddle discount API](https://developer.paddle.com/api-reference/discounts/list-discounts/)
- [IPRoyal Residential report API](https://docs.iproyal.com/proxies/residential/api/reports)
- [OpenAI GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)
