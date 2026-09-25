"use client";
import { createStore } from "zustand/vanilla";
import { api, asApiError } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";
import { randomUUID } from "../lib/uuid.js";
const store = createStore<{ busy: boolean; error: string | null }>(() => ({ busy: false, error: null }));
export function CreditCheckout({ packs }: { packs: { priceId: string; balanceUsd: string }[] }) {
  const { busy, error } = useStoreBridge(store);
  async function purchase(priceId: string) {
    if (store.getState().busy) return;
    store.setState({ busy: true, error: null });
    try {
      // Preserve the same intent across an interrupted checkout request.
      const storageKey = `wallet-purchase:${priceId}`;
      const operationId = sessionStorage.getItem(storageKey) ?? randomUUID();
      sessionStorage.setItem(storageKey, operationId);
      const result = await api.account.createWalletPurchase.mutate({ operationId, priceId });
      if (!result.checkoutUrl) throw new Error("Checkout is still being prepared. Retry in a moment.");
      sessionStorage.removeItem(storageKey);
      window.location.assign(result.checkoutUrl);
    } catch (error) { store.setState({ busy: false, error: asApiError(error).message }); }
  }
  return <section><h2>Add USD balance</h2><p>Paddle shows the price, currency, and taxes before you confirm payment. Your balance is added after payment is verified.</p>
    {error ? <p role="alert">{error}</p> : null}
    <div className="row">{packs.map((pack) => <button disabled={busy} key={pack.priceId} onClick={() => void purchase(pack.priceId)}>Add ${pack.balanceUsd} USD</button>)}</div>
    <p className="muted">Purchase discount codes can be entered at Paddle checkout.</p>
    <form className="row" onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);store.setState({busy:true,error:null});void api.account.redeemCoupon.mutate({code:String(data.get("code"))}).then(()=>window.location.reload()).catch(error=>store.setState({busy:false,error:asApiError(error).message}));}}>
      <label>Balance coupon <input name="code" required minLength={3} maxLength={40} placeholder="WELCOME" /></label><button disabled={busy}>Redeem USD coupon</button>
    </form>
    {!packs.length ? <p className="muted">Checkout is not configured on this installation.</p> : null}
  </section>;
}
