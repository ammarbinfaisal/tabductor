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
      <nav className="tabbar">
        <Link href={`/workflows/${id}`}>Editor</Link>
        <Link href={`/workflows/${id}/runs`}>Runs</Link>
        <Link href={`/workflows/${id}/events`}>Events</Link>
        <Link href={`/workflows/${id}/share`}>Share</Link>
      </nav>
      {children}
    </>
  );
}
