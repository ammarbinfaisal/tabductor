import { z } from "zod";

/**
 * The HTTP client half of the S5h boundary, deliberately shaped like
 * `packages/assets/src/render-client.ts`: plain `fetch`, an injectable `fetchImpl`, a zod
 * response schema, and an `unavailable` branch for a peer that is down or answered something
 * this client does not recognise.
 *
 * Everything crossing this boundary is already resolved. `python-executor.ts` reads every
 * declared input out of the asset store before calling, so this ships bytes the caller already
 * owns — never a path, never a credential. And everything coming back is *untrusted input*:
 * `apps/pyrunner` is a network peer, so the executor re-validates every output path against
 * `normalizeAssetPath` and the task's write grants before a single byte reaches the store.
 */

export type PyrunJob = {
  /** The task's program, verbatim from `tasks.code_source`. */
  code: string;
  /** The trigger packet, written to `in/trigger.json`. */
  trigger: unknown;
  /** Declared inputs the host resolved from the asset store, keyed by the bare filename the
   * program was told to open — never a path, the same contract `render.ts` uses for images. */
  assets: { filename: string; bytes: Buffer }[];
  /** Seconds; becomes `SOURCE_DATE_EPOCH` so a rerun of one trigger is byte-stable. */
  sourceDateEpoch: number;
  wallClockMs?: number;
};

export type PyrunOutcome =
  | {
      ok: true;
      durationMs: number;
      files: { path: string; bytes: Buffer }[];
      emitsJsonl: string;
      stdout: string;
      stderr: string;
      skipped: { nonRegular: number };
    }
  /** The program exited non-zero. A defect in the code, which an author (or S8's model) can
   * correct — so the executor treats it as retryable. */
  | { ok: false; kind: "program_error"; exitCode: number; stderr: string; durationMs: number }
  /** The wall clock fired. A job that ran out of time will run out again, so this is permanent. */
  | { ok: false; kind: "killed"; reason: "wall_clock"; durationMs: number }
  /** An output cap was breached. A breach is an outcome, never a truncation (§5.4). */
  | { ok: false; kind: "output_cap"; limit: string; durationMs: number }
  /** pyrunner is unreachable or spoke a shape we do not know — infrastructure, not a program
   * defect, so retryable. */
  | { ok: false; kind: "unavailable"; log: string };

export type PyrunClient = { run: (job: PyrunJob) => Promise<PyrunOutcome> };

// A plain `z.union`, not `discriminatedUnion`: three branches share `ok: false` and `kind` is
// the real second-level discriminator — the same reason `render-client.ts` gives.
const RESPONSE_SCHEMA = z.union([
  z.object({
    ok: z.literal(true),
    durationMs: z.number(),
    files: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
    emitsJsonl: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    skipped: z.object({ nonRegular: z.number() }),
    truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("program_error"),
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("killed"),
    reason: z.literal("wall_clock"),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("output_cap"),
    limit: z.string(),
    durationMs: z.number(),
  }),
]);

export type PyrunClientOptions = {
  /** `apps/pyrunner`'s base URL, e.g. `http://pyrunner:4200`. */
  url: string;
  fetchImpl?: typeof fetch;
};

export function createPyrunClient(opts: PyrunClientOptions): PyrunClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.url.replace(/\/$/, "");

  return {
    async run(job) {
      let res: Response;
      try {
        res = await doFetch(`${base}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: job.code,
            trigger: job.trigger ?? null,
            assets: job.assets.map((a) => ({
              filename: a.filename,
              contentBase64: a.bytes.toString("base64"),
            })),
            sourceDateEpoch: job.sourceDateEpoch,
            ...(job.wallClockMs === undefined ? {} : { wallClockMs: job.wallClockMs }),
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
        return { ok: false, kind: "unavailable", log: `malformed pyrunner response: ${parsed.error.message}` };
      }

      if (parsed.data.ok) {
        const { files, ...rest } = parsed.data;
        return {
          ...rest,
          ok: true,
          files: files.map((f) => ({ path: f.path, bytes: Buffer.from(f.contentBase64, "base64") })),
        };
      }
      return parsed.data;
    },
  };
}
