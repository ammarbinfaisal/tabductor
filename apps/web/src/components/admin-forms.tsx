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
const optionalAmount=(data:FormData,key:string)=>text(data,key)||null;
export function BrowserRateForm(){return <Form action={data=>api.admin.saveRate.mutate({category:"browser",provider:"",item:"minute",chargeUsd:text(data,"charge"),costUsd:optionalAmount(data,"cost")})}>
  <legend>Update browser pricing</legend><label>Billing quantity <select name="unit" defaultValue="minute"><option value="minute">1 started browser minute</option></select></label>
  <label>Customer price (USD per minute) <input name="charge" required inputMode="decimal" placeholder="0.05"/></label>
  <label>Infrastructure cost (USD per minute, optional) <input name="cost" inputMode="decimal" placeholder="Unknown"/></label><button>Save browser rate</button>
</Form>}

export function ModelRateForm(){return <Form action={data=>api.admin.saveModelRates.mutate({provider:text(data,"provider") as "openai"|"anthropic",model:text(data,"model"),
  inputUsd:text(data,"inputCharge"),cachedInputUsd:text(data,"cachedCharge"),outputUsd:text(data,"outputCharge"),inputCostUsd:optionalAmount(data,"inputCost"),cachedInputCostUsd:optionalAmount(data,"cachedCost"),outputCostUsd:optionalAmount(data,"outputCost"),
  maxInputTokens:Number(text(data,"maxInputTokens")),maxOutputTokens:Number(text(data,"maxOutputTokens"))})}>
  <legend>Add or update a model</legend><div className="admin-rate-fields"><label>Provider <select name="provider" defaultValue="openai"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label>
  <label>Model ID <input name="model" required maxLength={220} placeholder="gpt-5.4"/></label><label>Billing quantity <select name="unit" defaultValue="million_tokens"><option value="million_tokens">1 million tokens</option></select></label>
  <h3>Customer prices</h3><label>Input (USD) <input name="inputCharge" required inputMode="decimal" placeholder="1.00"/></label><label>Cached input (USD) <input name="cachedCharge" required inputMode="decimal" placeholder="0.10"/></label><label>Output (USD) <input name="outputCharge" required inputMode="decimal" placeholder="4.00"/></label>
  <h3>Provider costs</h3><label>Input (USD, optional) <input name="inputCost" inputMode="decimal" placeholder="Unknown"/></label><label>Cached input (USD, optional) <input name="cachedCost" inputMode="decimal" placeholder="Unknown"/></label><label>Output (USD, optional) <input name="outputCost" inputMode="decimal" placeholder="Unknown"/></label>
  <h3>Model limits</h3><label>Maximum input tokens <input name="maxInputTokens" type="number" min="1024" max="2000000" step="1" required defaultValue="1000000"/></label><label>Maximum output tokens <input name="maxOutputTokens" type="number" min="1" max="2000000" step="1" required defaultValue="1000000"/></label></div>
  <p className="muted">Limits describe provider capabilities. Confirm the model’s output ceiling and combined context constraint before saving.</p><button>Save all model rates</button>
</Form>}
export function ProxyRateForm(){return <Form action={data=>api.admin.saveRate.mutate({category:"proxy",provider:"iproyal",item:"GB",chargeUsd:"0",costUsd:text(data,"cost")})}>
  <legend>Update IPRoyal cost</legend><label>Provider <select name="provider" defaultValue="iproyal"><option value="iproyal">IPRoyal Residential</option></select></label>
  <label>Usage unit <select name="unit" defaultValue="GB"><option value="GB">1 GB (decimal)</option></select></label><label>Provider cost (USD per GB) <input name="cost" required inputMode="decimal" placeholder="2.00"/></label>
  <p className="muted">Proxy usage is tracked as an operating cost and is not charged directly to the customer.</p><button>Save IPRoyal cost</button>
</Form>}
export function CaptchaRateForm(){return <Form action={data=>api.admin.saveRate.mutate({category:"solver",provider:text(data,"provider"),item:text(data,"task"),chargeUsd:text(data,"charge"),costUsd:optionalAmount(data,"cost")})}>
  <legend>Update CAPTCHA pricing</legend><label>Provider <select name="provider" defaultValue="2captcha"><option value="capsolver">Capsolver</option><option value="2captcha">2Captcha</option><option value="anti-captcha">Anti-Captcha</option></select></label>
  <label>Native task type <select name="task" defaultValue="TurnstileTaskProxyless"><option value="*">Default for other task types (*)</option><option value="TurnstileTaskProxyless">TurnstileTaskProxyless</option><option value="AntiTurnstileTaskProxyLess">AntiTurnstileTaskProxyLess</option><option value="HCaptchaTaskProxyless">HCaptchaTaskProxyless</option><option value="RecaptchaV2TaskProxyless">RecaptchaV2TaskProxyless</option><option value="ReCaptchaV2TaskProxyLess">ReCaptchaV2TaskProxyLess</option><option value="AntiGateTask">AntiGateTask</option></select></label>
  <label>Billing quantity <select name="unit" defaultValue="solve"><option value="solve">1 successful solve</option></select></label><label>Customer price (USD per solve) <input name="charge" required inputMode="decimal" placeholder="0.10"/></label>
  <label>Provider cost (USD per solve, optional) <input name="cost" inputMode="decimal" placeholder="Unknown"/></label><button>Save CAPTCHA rate</button>
</Form>}
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
