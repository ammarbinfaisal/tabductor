import type { Page, PerceiveOptions, Perception } from "@tabductor/browser";

/**
 * The perception builder the S4a spec names — but the extraction itself lives inside
 * `packages/browser`'s playwright driver (`Page.perceive`), not here: the mandated deviation
 * note explains why (`docs/subphases/S4a-llm-perception.md`), and the short version is that
 * one in-page `evaluate` call belongs next to the driver that owns the page, not one layer
 * up. This is the seam the agent package's own callers (S4b) reach through, so they never
 * have to know that split happened.
 */
export function buildPerception(page: Page, opts?: PerceiveOptions): Promise<Perception> {
  return page.perceive(opts);
}

export type { AnchoredElement, Anchor, LocatorStrategy, PerceiveOptions, Perception } from "@tabductor/browser";
