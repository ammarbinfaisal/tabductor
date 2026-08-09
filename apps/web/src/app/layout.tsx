import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = { title: "tabductor", description: "Agentic browsing control plane" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            tabductor
          </Link>
          <nav>
            <Link href="/status">status</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
