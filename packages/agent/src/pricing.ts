/**
 * The price table `llm_cost_usd_total` is computed from — the one place in the codebase a
 * dollar amount per token is written down (spec: "price table per model in config, one
 * place"). List prices, USD per 1M tokens, as of this subphase; update here on a pricing
 * change, never at a call site. An unlisted model still gets an amount (`DEFAULT_PRICE`)
 * rather than a `NaN` in a cost metric — better an honestly-approximate number than a silently
 * broken series.
 */
export type ModelPrice = { inputPerMTok: number; outputPerMTok: number };

/** Anthropic list pricing (Claude Sonnet 5, this adapter's Anthropic default) and OpenAI list
 * pricing (gpt-5.2, this adapter's OpenAI default — see `llm-live.ts` `DEFAULT_MODEL`). */
const MODEL_PRICING: Record<string, ModelPrice> = {
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "gpt-5.2": { inputPerMTok: 1.25, outputPerMTok: 10 },
};

/** A model this table has never heard of still needs a number — priced at the more expensive
 * of the two known models rather than zero, so a missing entry under-reports cost as "cheap"
 * never as "free". */
const DEFAULT_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

export function priceOf(model: string): ModelPrice {
  return MODEL_PRICING[model] ?? DEFAULT_PRICE;
}

/** `usage.in`/`usage.out` are token counts, this returns dollars. */
export function costUsd(model: string, usage: { in: number; out: number }): number {
  const price = priceOf(model);
  return (usage.in / 1_000_000) * price.inputPerMTok + (usage.out / 1_000_000) * price.outputPerMTok;
}
