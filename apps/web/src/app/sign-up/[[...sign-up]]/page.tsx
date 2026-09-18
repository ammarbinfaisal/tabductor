import { SignUp } from "@clerk/nextjs";
export default function SignUpPage() {
  return <div className="auth-panel"><SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/workflows" /></div>;
}
