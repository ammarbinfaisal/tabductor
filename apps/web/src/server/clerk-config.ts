/** Runtime lookup keeps one image usable with separate local and AWS Clerk instances. */
export function clerkPublishableKey(): string | undefined {
  const name = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY";
  return process.env[name];
}
export function clerkConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY && clerkPublishableKey());
}
