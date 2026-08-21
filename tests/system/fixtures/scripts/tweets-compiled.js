// The §11-shaped script a compiled run actually executes: unlike `tweets.js` (which S6a runs
// against a session a test already navigated), this one drives the whole run from a blank page,
// which is what the engine hands it.
//
// `__FX_URL__` is substituted with the fixture server's origin at insert time — the same token
// the checked-in replay transcripts use, and for the same reason: the port is chosen at
// `startFixtures()` time and cannot be baked into a file git tracks.
export default async function run(ctx) {
  await ctx.page.goto("__FX_URL__/fake-tweets");

  const guards = [
    ctx.guard.url(/fake-tweets/),
    ctx.guard.exists("article", { timeout: 8000 }),
    ctx.guard.noDialog(),
  ];
  if (!(await ctx.guard.all(guards))) {
    return ctx.deopt(
      "Timeline layout not recognized. Goal: extract each tweet as {text, url} and emit " +
        "tweet.detected for every new one.",
      { failed: await ctx.guard.failures() },
    );
  }

  const tweets = await ctx.page.evalExtract("article", {
    text: { selector: "[data-testid='tweetText']" },
    url: { selector: "a[href*='/status/']", attr: "href" },
  });

  for (const t of tweets) {
    await ctx.emitIfNew("tweet.detected", t, { dedupeKey: t.url });
  }
}
