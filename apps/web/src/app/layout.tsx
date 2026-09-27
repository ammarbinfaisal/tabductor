import type { ReactNode } from "react";
import { AppSidebar } from "../components/app-sidebar.js";
import { accountIdForWebRequest } from "../server/auth-context.js";
import { isAdminAccount } from "../server/admin.js";
import { db } from "../server/db.js";
import { ClerkProvider, UserButton } from "@clerk/nextjs";
import "./globals.css";
import "./sidebar.css";
import { clerkConfigured, clerkPublishableKey } from "../server/clerk-config.js";
import { ThemeSwitcher } from "../components/theme-switcher.js";
export const dynamic = "force-dynamic";

export const metadata = { title: { default: "Tabductor · Browser automation", template: "%s · Tabductor" }, description: "Build workflows, watch your browser automation live, and review every run." };

/** Stylesheet fonts retain system fallbacks and keep offline builds possible. */
const FONTS =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

const THEME_INIT = `(function(){var t='system';try{t=localStorage.getItem('tabductor.theme')||t}catch(e){}document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})()`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  let accountId: string | undefined;
  try { accountId = await accountIdForWebRequest(); } catch { /* Public routes need no account. */ }
  const showAdmin = accountId ? await isAdminAccount(db(), accountId) : false;
  const body = (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <AppSidebar
        showEndpoints={process.env.TABDUCTOR_DEPLOYMENT_MODE !== "hosted"}
        showAdmin={showAdmin}
        theme={<ThemeSwitcher />}
        account={clerkConfigured() ? <UserButton /> : null}
      >
        {children}
      </AppSidebar>
    </>
  );
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>
        {clerkConfigured() ? <ClerkProvider publishableKey={clerkPublishableKey()} signInUrl="/sign-in" signUpUrl="/sign-up">{body}</ClerkProvider> : body}
      </body>
    </html>
  );
}
