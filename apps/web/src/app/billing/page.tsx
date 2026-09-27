import { SubscriptionPanel } from "../../components/subscription-panel.js";
import { createServerCaller } from "../../server/router.js";
import { CreditCheckout } from "../../components/credit-checkout.js";
export const dynamic = "force-dynamic";
export default async function BillingPage({searchParams}:{searchParams:Promise<{plan?:string;offer?:string}>}) {
  const caller = await createServerCaller();
  const [billing, subscription, query] = await Promise.all([caller.account.billing(),caller.subscription.current(),searchParams]);
  if(billing.conversionRequired)return <><h1>USD balance & usage</h1><p className="muted">Account: <code>{billing.accountId}</code></p><p role="status">Your balance will convert to USD automatically when outstanding usage finishes settling. Your existing balance is preserved.</p></>;
  return <><h1>USD balance & usage</h1><p className="muted">Account: <code>{billing.accountId}</code></p>
    <SubscriptionPanel data={subscription} selectedPlan={query.plan} offerId={query.offer}/>
    <p><strong>${billing.balance.availableUsd} available</strong> · ${billing.balance.reservedUsd} reserved</p>
    <p>Reservations cover work in progress. Unused funds return when usage is settled.</p>
    <CreditCheckout packs={billing.packs} />
    <h2>Settled usage</h2><ul>{billing.usage.map((usage) => <li key={usage.category}>{usage.category}: ${usage.amountUsd} USD</li>)}</ul>
    <h2>Purchases</h2><div className="table-scroll"><table><thead><tr><th>Date</th><th>USD</th><th>Refunded</th><th>Status</th></tr></thead><tbody>
      {billing.purchases.map((purchase) => <tr key={purchase.id}><td>{purchase.createdAt.toISOString().slice(0, 10)}</td><td>${purchase.balanceUsd}</td><td>${purchase.refundedUsd}</td><td>{purchase.status}</td></tr>)}
    </tbody></table></div>
    <h2>Recent model usage</h2><div className="table-scroll"><table><thead><tr><th>Model / purpose</th><th>Source</th><th>Input / output tokens</th><th>USD</th><th>Status</th></tr></thead><tbody>
      {billing.models.map((model) => <tr key={model.id}><td>{model.model}<br />{model.purpose}</td><td>{model.funding === "byo" ? "Your key" : "Tabductor"}</td><td>{model.inputTokens ?? "—"} / {model.outputTokens ?? "—"}</td><td>{model.chargedUsd === null ? "Pending" : `$${model.chargedUsd}`}</td><td>{model.status}</td></tr>)}
    </tbody></table></div>
  </>;
}
