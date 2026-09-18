import type { ReactNode } from "react";
import Link from "next/link";
import { ClerkProvider, UserButton } from "@clerk/nextjs";
import "./globals.css";
import { clerkConfigured, clerkPublishableKey } from "../server/clerk-config.js";
export const dynamic = "force-dynamic";

export const metadata = { title: "tabductor", description: "Agentic browsing control plane" };

/**
 * Ruled Ink's three type roles (DESIGN.md) arrive as <link> stylesheets rather than
 * next/font: a build with no network still builds, and the CSS stacks degrade to
 * Georgia/system mono until the fonts land.
 */
const FONTS =
  "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,500;0,6..72,600;1,6..72,500&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap";

export default function RootLayout({ children }: { children: ReactNode }) {
  const body = (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          tabductor
        </Link>
        <nav>
          <Link href="/workflows">workflows</Link>
          {process.env.TABDUCTOR_DEPLOYMENT_MODE !== "hosted" && <Link href="/endpoints">endpoints</Link>}
          <Link href="/status">status</Link>
          <Link href="/settings/models">models</Link>
          <Link href="/billing">billing</Link>
          <Link href="/sessions">sessions</Link>
          <Link href="/profiles">profiles</Link>
          {clerkConfigured() && <UserButton />}
        </nav>
      </header>
      <main>{children}</main>
    </>
  );
  return (
    <html lang="en">
      <head>
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
