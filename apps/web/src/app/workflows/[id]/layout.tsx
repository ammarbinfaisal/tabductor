import Link from "next/link";
import type { ReactNode } from "react";

export default async function WorkflowLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <nav className="tabs">
        <Link href={`/workflows/${id}`}>graph</Link>
        <Link href={`/workflows/${id}/runs`}>runs</Link>
        <Link href={`/workflows/${id}/events`}>events</Link>
        <Link href={`/workflows/${id}/share`}>sharing</Link>
        <Link href="/workflows" className="muted">
          all workflows
        </Link>
      </nav>
      {children}
    </>
  );
}
