import { createServerCaller } from "../../server/router.js";
import { CreditCheckout } from "../../components/credit-checkout.js";
export const dynamic = "force-dynamic";
export default async function BillingPage() {
  const caller = await createServerCaller();
  const billing = await caller.account.billing();
  return <><h1>Credits & usage</h1>
    <p><strong>{billing.balance.availableUnits.toLocaleString()} available</strong> · {billing.balance.reservedUnits.toLocaleString()} reserved</p>
    <p>Reservations cover work in progress. Unused credits return when usage is settled.</p>
    <CreditCheckout packs={billing.packs} />
    <h2>Settled usage</h2><ul>{billing.usage.map((usage) => <li key={usage.category}>{usage.category}: {usage.units.toLocaleString()} credits</li>)}</ul>
    <h2>Purchases</h2><div className="table-scroll"><table><thead><tr><th>Date</th><th>Credits</th><th>Refunded</th><th>Status</th></tr></thead><tbody>
      {billing.purchases.map((purchase) => <tr key={purchase.id}><td>{purchase.createdAt.toISOString().slice(0, 10)}</td><td>{purchase.creditUnits.toLocaleString()}</td><td>{purchase.refundedUnits.toLocaleString()}</td><td>{purchase.status}</td></tr>)}
    </tbody></table></div>
    <h2>Recent model usage</h2><div className="table-scroll"><table><thead><tr><th>Model / purpose</th><th>Source</th><th>Input / output tokens</th><th>Credits</th><th>Status</th></tr></thead><tbody>
      {billing.models.map((model) => <tr key={model.id}><td>{model.model}<br />{model.purpose}</td><td>{model.funding === "byo" ? "Your key" : "Tabductor"}</td><td>{model.inputTokens ?? "—"} / {model.outputTokens ?? "—"}</td><td>{model.chargedUnits ?? "Pending"}</td><td>{model.status}</td></tr>)}
    </tbody></table></div>
  </>;
}
