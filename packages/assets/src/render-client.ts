import { z } from "zod";

/**
 * The HTTP client half of the S5e renderer boundary. `apps/renderer` is the out-of-process,
 * containerised worker (`docs/subphases/S5e-latex-renderer.md` deliverable 1); this module is
 * how `render.ts`'s `assets.render` tool — running inside whatever process hosts the asset
 * node's tool loop, i.e. "the host" the renderer spec keeps referring to — reaches it. Plain
 * `fetch` (global since Node 18): the style constraint is explicit that the client "shells out
 * or calls a thin HTTP surface... whichever the container mechanism settles on", and an HTTP
 * hop needs no new dependency, unlike shelling `docker` out of this package (which would also
 * put a docker-CLI dependency on every process that merely wants to call `assets.render`,
 * including this package's own unit tests).
 *
 * What crosses this boundary is already resolved: `render.ts` reads `srcPath` and every
 * declared image out of the asset store *before* calling `render`, so this client only ever
 * ships bytes the caller already owns — never a path, never a credential, matching the "the
 * `.tex` never names a host path" rule the whole subphase is built around.
 */

export type RenderJob = {
  /** The `.tex` source, verbatim — this package's problem to have already read out of the
   * asset store; the renderer worker never touches Postgres or `BlobStore`. */
  texSource: string;
  /** Images the host resolved from the asset store, keyed by the bare filename the LLM was
   * told (via the tool's input contract) to `\includegraphics` by — never a path. */
  files: { filename: string; bytes: Buffer }[];
  /** `deck` compiles the identical way `pdf` does (both are tectonic → PDF); the only
   * difference this client cares about is the label it never invents on its own — that is
   * `render.ts`'s job, once bytes come back. */
  format: "pdf" | "deck";
};

export type RenderOutcome =
  | { ok: true; pdf: Buffer }
  /** Non-zero tectonic exit: `log` is the TeX log verbatim, the thing deliverable 3 requires
   * come back as a tool error rather than a run failure. */
  | { ok: false; kind: "compile_error"; log: string }
  /** The sandbox itself intervened — wall clock or memory — before tectonic finished on its
   * own. Distinct from `compile_error` because a kill is a resource-cap breach, not a
   * document defect the model can fix by editing `.tex`. */
  | { ok: false; kind: "killed"; reason: "wall_clock" | "memory"; log: string }
  /** The renderer process itself is unreachable, or returned a shape this client does not
   * recognise — an infrastructure failure, not a document one. */
  | { ok: false; kind: "unavailable"; log: string };

export type RenderClient = { render: (job: RenderJob) => Promise<RenderOutcome> };

// Not `z.discriminatedUnion("ok", ...)`: two of these three branches share `ok: false`, and
// zod's discriminated union requires the discriminator's literal to be unique *per branch* —
// `kind` is the real second-level discriminator, but zod only supports a single top-level
// key. A plain `z.union` tries each branch in turn, which is all three shapes here need.
const RESPONSE_SCHEMA = z.union([
  z.object({ ok: z.literal(true), pdfBase64: z.string() }),
  z.object({ ok: z.literal(false), kind: z.literal("compile_error"), log: z.string() }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("killed"),
    reason: z.enum(["wall_clock", "memory"]),
    log: z.string(),
  }),
]);

export type RenderClientOptions = {
  /** `apps/renderer`'s base URL, e.g. `http://localhost:4100`. */
  url: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

export function createRenderClient(opts: RenderClientOptions): RenderClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/$/, "");

  return {
    async render(job) {
      let res: Response;
      try {
        res = await doFetch(`${base}/render`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            format: job.format,
            texSource: job.texSource,
            files: job.files.map((f) => ({ filename: f.filename, contentBase64: f.bytes.toString("base64") })),
          }),
        });
      } catch (err) {
        return { ok: false, kind: "unavailable", log: err instanceof Error ? err.message : String(err) };
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        return { ok: false, kind: "unavailable", log: err instanceof Error ? err.message : String(err) };
      }

      const parsed = RESPONSE_SCHEMA.safeParse(json);
      if (!parsed.success) {
        return { ok: false, kind: "unavailable", log: `malformed renderer response: ${parsed.error.message}` };
      }

      if (parsed.data.ok) {
        return { ok: true, pdf: Buffer.from(parsed.data.pdfBase64, "base64") };
      }
      return parsed.data;
    },
  };
}
