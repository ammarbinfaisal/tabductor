"use client";
import { createStore } from "zustand/vanilla";
import { api, asApiError } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";
import { randomUUID } from "../lib/uuid.js";
const store = createStore<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));
export function CreditCheckout({ packs }: { packs: { priceId: string; creditUnits: number }[] }) {
  const { busy, error } = useStoreBridge(store);
  async function purchase(priceId: string) {
    if (store.getState().busy) return;
    store.setState({ busy: true, error: null });
    try {
      // Preserve the same intent across an interrupted checkout request.
      const storageKey = `credit-purchase:${priceId}`;
      const operationId = sessionStorage.getItem(storageKey) ?? randomUUID();
      sessionStorage.setItem(storageKey, operationId);
      const result = await api.account.createCreditPurchase.mutate({ operationId, priceId });
      if (!result.checkoutUrl) throw new Error("Checkout is still being prepared. Retry in a moment.");
      sessionStorage.removeItem(storageKey);
      window.location.assign(result.checkoutUrl);
    } catch (error) { store.setState({ busy: false, error: asApiError(error).message }); }
  }
  return <section><h2>Add credits</h2><p>Paddle shows the price, currency, and taxes before you confirm payment. Credits arrive after payment is verified.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="row">{packs.map((pack) => <button disabled={busy} key={pack.priceId} onClick={() => void purchase(pack.priceId)}>Buy {pack.creditUnits.toLocaleString()} credits</button>)}</div>
    {!packs.length ? <p className="muted">Checkout is not configured on this installation.</p> : null}
  </section>;
}
