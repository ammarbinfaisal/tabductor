import { redirect } from "next/navigation";

export default async function EventsPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const [{ id }, { event }] = await Promise.all([params, searchParams]);
  redirect(`/workflows/${encodeURIComponent(id)}${event ? `?event=${encodeURIComponent(event)}` : ""}`);
}
