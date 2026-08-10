/**
 * Next's one boot hook, called once per server process before any request is handled — which
 * makes it this app's composition root for telemetry (§17.2 rule 1).
 *
 * The import sits **inside** the runtime guard rather than at the top of the file. Next
 * substitutes `process.env.NEXT_RUNTIME` per bundle at build time, so a dynamic import in
 * the dead branch is dropped instead of followed — which is what keeps the OTel SDK, whose
 * module graph reaches `net` and `zlib`, out of any bundle that cannot resolve them.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { telemetry } = await import("./server/telemetry.js");
    await telemetry();
  }
}
