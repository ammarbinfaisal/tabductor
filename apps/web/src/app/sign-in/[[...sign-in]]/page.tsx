import { SignIn } from "@clerk/nextjs";
export default function SignInPage() {
  return <div className="auth-panel"><SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/workflows" /></div>;
}
