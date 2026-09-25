import { AdminNavigation } from "../components/admin-navigation.js";
import type { ReactNode } from "react";
import Link from "next/link";
import { ClerkProvider, UserButton } from "@clerk/nextjs";
import "./globals.css";
import { clerkConfigured, clerkPublishableKey } from "../server/clerk-config.js";
import { ThemeSwitcher } from "../components/theme-switcher.js";
export const dynamic = "force-dynamic";

export const metadata = { title: { default: "Tabductor · Browser automation", template: "%s · Tabductor" }, description: "Build workflows, watch your browser automation live, and review every run." };

/** Stylesheet fonts retain system fallbacks and keep offline builds possible. */
const FONTS =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

const THEME_INIT = `(function(){var t='system';try{t=localStorage.getItem('tabductor.theme')||t}catch(e){}document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="topbar">
        <Link href="/" className="brand">
          <svg className="brand-mark" viewBox="0 0 28 28" width="28" height="28" fill="none" aria-hidden="true"><path d="M4 6h20M14 6v17M6 12h5M17 17h5" stroke="currentColor" strokeWidth="2.5" /><circle cx="6" cy="20" r="2" fill="currentColor" /></svg>
          tabductor
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/workflows">Workflows</Link>
          <Link href="/sessions">Sessions</Link>
          <Link href="/profiles">Profiles</Link>
          {process.env.TABDUCTOR_DEPLOYMENT_MODE !== "hosted" && <Link href="/endpoints">Endpoints</Link>}
          <Link href="/status">Status</Link>
          <Link href="/settings/models">Models</Link>
          <Link href="/billing">Billing</Link>
          <AdminNavigation />
        </nav>
        <div className="topbar-tools"><ThemeSwitcher />{clerkConfigured() && <UserButton />}</div>
      </header>
      <main id="main-content">{children}</main>
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
