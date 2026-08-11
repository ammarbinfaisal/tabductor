import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { TRPCError } from "@trpc/server";
import { shareCaller } from "../../../server/share-caller.js";

export const dynamic = "force-dynamic";

/**
 * The shell every shared page sits in (U0.5).
 *
 * It resolves the share once so an unknown, malformed or revoked token 404s here rather
 * than separately on each tab — and all three produce the same page, because a distinct
 * "revoked" screen would confirm a workflow existed.
 *
 * `noindex` and `no-referrer` are set for `/s/*` in `middleware.ts`. The token is in the
 * path, so without the second any outbound click would carry it away in `Referer`.
 */
export default async function ShareLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const api = await shareCaller();
  const shared = await api.public.graph({ token }).catch((err: unknown) => {
    if (err instanceof TRPCError) notFound();
    throw err;
  });

  const at = (path: string): string => `/s/${encodeURIComponent(token)}${path}`;
  return (
    <>
      <nav className="tabbar">
        <Link href={at("")}>Overview</Link>
        <Link href={at("/runs")}>Runs</Link>
        <Link href={at("/events")}>Events</Link>
        <span className="section-label" style={{ marginLeft: "auto", alignSelf: "center" }}>
          {shared.name} · shared, read-only
        </span>
      </nav>
      {children}
    </>
  );
}
