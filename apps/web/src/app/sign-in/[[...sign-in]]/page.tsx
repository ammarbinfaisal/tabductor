import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
export default async function AuthPage({searchParams}:{searchParams:Promise<{plan?:string;offer?:string}>}) {
  const query=await searchParams;
  const plan=query.plan&&/^[a-zA-Z0-9_-]{1,100}$/.test(query.plan)?query.plan:undefined;
  const suffix=plan?`?plan=${encodeURIComponent(plan)}${query.offer?`&offer=${encodeURIComponent(query.offer)}`:""}`:"";
  const destination=plan&&!plan.startsWith("free")?`/billing${suffix}`:"/workflows";
  return <main id="main-content" className="auth-page"><section><Link href="/pricing">tabductor · Pricing</Link><h1>Your workflows, ready to run.</h1><p>Turn everyday browser tasks into workflows you can run, inspect, and trust.</p>{plan?<p>Selected plan: {plan.startsWith("free")?"Free":"Continue to billing after signing in"}</p>:null}</section><div className="auth-panel"><SignIn routing="path" path="/sign-in" signUpUrl={`/sign-up${suffix}`} forceRedirectUrl={destination} /></div></main>;
}
