"use client";
import type { FormEvent, ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";
import { randomUUID } from "../lib/uuid.js";
const expenseKeys=new Map<string,string>();
const expenseKey=(data:FormData)=>{const key=JSON.stringify([...data.entries()]);if(!expenseKeys.has(key))expenseKeys.set(key,randomUUID());return expenseKeys.get(key)!;};
const state=createStore<{busy:boolean;error:string|null}>(()=>({busy:false,error:null}));
async function act(work:()=>Promise<unknown>){if(state.getState().busy)return;state.setState({busy:true,error:null});try{await work();window.location.reload();}catch(error){state.setState({busy:false,error:asApiError(error).message});}}
const text=(data:FormData,key:string)=>String(data.get(key)??"").trim();
function Form({children,action}:{children:ReactNode;action:(data:FormData)=>Promise<unknown>}){const {busy}=useStoreBridge(state);return <form className="admin-form" onSubmit={(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const data=new FormData(event.currentTarget);void act(()=>action(data));}}><fieldset disabled={busy}>{children}</fieldset></form>;}
export function AdminFeedback(){const {error,busy}=useStoreBridge(state);return <div aria-live="polite">{error?<p className="banner banner--error" role="alert">{error}</p>:busy?<p className="muted">Saving…</p>:null}</div>;}
export function AdminRateForm(){return <Form action={data=>api.admin.saveRate.mutate({category:text(data,"category") as "browser"|"solver"|"model"|"proxy",provider:text(data,"provider"),item:text(data,"item"),chargeUsd:text(data,"charge"),costUsd:text(data,"cost")||null})}>
  <legend>Set a price or provider cost</legend>
  <label>Usage <select name="category"><option value="solver">CAPTCHA solve</option><option value="browser">Browser minute</option><option value="model">Model tokens</option><option value="proxy">IPRoyal GB</option></select></label>
  <label>Provider <input name="provider" list="billing-providers" placeholder="2captcha" maxLength={100}/></label>
  <datalist id="billing-providers"><option value="capsolver"/><option value="2captcha"/><option value="anti-captcha"/><option value="openai"/><option value="anthropic"/><option value="iproyal"/></datalist>
  <label>Task type or billing unit <input name="item" required maxLength={240} list="billing-items" placeholder="TurnstileTaskProxyless"/></label>
  <datalist id="billing-items"><option value="TurnstileTaskProxyless"/><option value="AntiTurnstileTaskProxyLess"/><option value="HCaptchaTaskProxyless"/><option value="*"/><option value="minute"/><option value="GB"/></datalist>
  <p className="muted">Use the provider’s native CAPTCHA type, or * for its default. Browser: blank provider, minute. Model: model-id:input, :cached, or :output per million tokens. IPRoyal: GB.</p>
  <label>Customer price (USD) <input name="charge" required inputMode="decimal" placeholder="0.10" defaultValue="0.10"/></label>
  <label>Your provider cost (USD, optional) <input name="cost" inputMode="decimal" placeholder="Leave blank if unknown"/></label>
  <p className="muted">For example, charge $0.10 for Turnstile or $0.50 for hCaptcha. New prices apply only to new work. Proxy entries track costs; enter 0 for customer price.</p><button>Save rate version</button>
</Form>;}
export function WelcomeForm({amount}:{amount:string}){return <Form action={data=>api.admin.welcome.mutate({amountUsd:text(data,"amount")})}><legend>New account welcome balance</legend><label>USD granted once <input name="amount" defaultValue={amount} required inputMode="decimal"/></label><p className="muted">Only accounts created after this setting is saved are eligible. Signing in again never repeats the grant.</p><button>Save welcome balance</button></Form>;}
export function CouponForm(){return <Form action={data=>api.admin.createCoupon.mutate({code:text(data,"code"),kind:text(data,"kind") as "balance"|"percent"|"flat",amount:text(data,"amount"),maxRedemptions:text(data,"limit")?Number(text(data,"limit")):null,expiresAt:text(data,"expires")?new Date(text(data,"expires")+"T23:59:59Z"):null})}>
  <legend>Create a coupon</legend><label>Code <input name="code" required minLength={3} maxLength={40}/></label>
  <label>Type <select name="kind"><option value="balance">USD wallet balance</option><option value="percent">Purchase discount (%)</option><option value="flat">Purchase discount (USD)</option></select></label>
  <label>Amount (USD or percent) <input name="amount" inputMode="decimal" required placeholder="5.00"/></label>
  <label>Maximum redemptions <input name="limit" type="number" min="1" step="1" placeholder="Unlimited"/></label>
  <label>Expires after (UTC) <input name="expires" type="date"/></label><button>Create coupon</button>
</Form>;}
export function CouponActions({coupon}:{coupon:RouterOutputs["admin"]["settings"]["coupons"][number]}){const {busy}=useStoreBridge(state);return <span className="row"><button disabled={busy} onClick={()=>void act(()=>api.admin.couponStatus.mutate({code:coupon.code,disabled:!coupon.disabled}))}>{coupon.disabled?"Enable":"Disable"}</button>{coupon.syncError?<button disabled={busy} onClick={()=>void act(()=>api.admin.retryCoupon.mutate({code:coupon.code}))}>Retry Paddle sync</button>:null}</span>;}
export function ExpenseForm(){return <Form action={data=>api.admin.expense.mutate({amountUsd:text(data,"amount"),description:text(data,"description"),date:new Date(text(data,"date")+"T00:00:00Z"),...(text(data,"account")?{accountId:text(data,"account")}:{}),operationId:expenseKey(data)})}>
  <legend>Record an operating expense</legend><label>Description <input name="description" required maxLength={200}/></label><label>USD amount <input name="amount" required inputMode="decimal"/></label><label>Date (UTC) <input name="date" type="date" required defaultValue={new Date().toISOString().slice(0,10)}/></label><label>Account ID (blank for shared overhead) <input name="account"/></label><button>Record expense</button>
</Form>;}
export function ProxyForm(){return <Form action={data=>api.admin.mapProxy.mutate({hash:text(data,"hash"),label:text(data,"label"),accountId:text(data,"account")||null})}><legend>Map an existing IPRoyal user</legend><label>Provider user hash <input name="hash" required/></label><label>Label <input name="label" required maxLength={120}/></label><label>Tabductor account ID <input name="account" placeholder="Blank = shared overhead"/></label><p className="muted">Use the residential user or sub-user’s report hash. Add each reporting source once. This only imports usage; browser proxy routing is unchanged.</p><button>Save mapping</button></Form>;}
export function ProxySync({configured}:{configured:boolean}){const {busy}=useStoreBridge(state);return <button disabled={busy||!configured} onClick={()=>void act(()=>api.admin.syncProxy.mutate())}>Refresh IPRoyal usage</button>;}

export function ReconcileChargeForm(){return <Form action={data=>api.admin.reconcileCharge.mutate({reservationId:text(data,"reservation"),amountUsd:text(data,"amount"),providerCostUsd:text(data,"cost")||null,reason:text(data,"reason")})}><legend>Resolve an outstanding charge</legend><p className="muted">Check the provider’s records first, then enter the confirmed charge. Stop the associated run before settling. Enter 0 if no customer charge is due.</p><label>Reservation ID <input name="reservation" required/></label><label>Confirmed customer USD charge <input name="amount" required inputMode="decimal"/></label><label>Actual provider USD cost <input name="cost" inputMode="decimal" placeholder="Blank = unknown"/></label><label>Reconciliation evidence <textarea name="reason" required minLength={10} maxLength={500}/></label><button>Settle charge</button></Form>;}
