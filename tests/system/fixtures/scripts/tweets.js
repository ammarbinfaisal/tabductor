// A hand-written stand-in for what S6b's compiler will emit — §11's template shape, using the
// real `ExtractSpec` object form rather than the doc's `'sel@attr'` shorthand.
export default async function run(ctx) {
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

  const seen = (await ctx.state.get("seen")) || 0;
  for (const t of tweets) {
    await ctx.emitIfNew("tweet.detected", t, { dedupeKey: t.url });
  }
  await ctx.state.set("seen", seen + tweets.length);
}
