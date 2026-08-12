import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "@tabductor/core";
import { z } from "zod";
import type { Llm, LlmRequest } from "./llm.js";

/**
 * `record`/`replay` as pure functions around the `Llm` interface — no SDK involvement, no
 * network. A transcript line captures the **full** request/response JSON (spec: fixture
 * files, not traces, so the content rules that bind `llm.ts`'s trace payload don't apply
 * here) — except a tool's zod parameter schema, which is a runtime object with no JSON form;
 * only its name and description travel, which is everything the replay's shape check needs.
 */

const transcriptMessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });

const transcriptToolSchema = z.object({ name: z.string(), description: z.string() });

const transcriptRequestSchema = z.object({
  system: z.string(),
  messages: z.array(transcriptMessageSchema),
  tools: z.array(transcriptToolSchema),
});

const transcriptResponseSchema = z.object({
  text: z.string().optional(),
  toolCalls: z.array(
    z.object({ id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }),
  ),
  usage: z.object({ in: z.number(), out: z.number() }),
});

const transcriptEntrySchema = z.object({
  request: transcriptRequestSchema,
  response: transcriptResponseSchema,
});

type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

function toTranscriptRequest(req: LlmRequest): TranscriptEntry["request"] {
  return {
    system: req.system,
    messages: req.messages,
    tools: req.tools.map((t) => ({ name: t.name, description: t.description })),
  };
}

/** Delegates to `inner` (the live transport), appending each request/response pair to
 * `fixturePath` as one JSONL line — nothing here is buffered, so a crash mid-run still leaves
 * every completion up to that point on disk. */
export function recordLlm(inner: Llm, fixturePath: string): Llm {
  return {
    async complete(req) {
      const res = await inner.complete(req);
      mkdirSync(dirname(fixturePath), { recursive: true });
      const entry: TranscriptEntry = { request: toTranscriptRequest(req), response: res };
      appendFileSync(fixturePath, `${JSON.stringify(entry)}\n`);
      return res;
    },
  };
}

function loadTranscript(fixturePath: string): TranscriptEntry[] {
  const raw = readFileSync(fixturePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new AppError(
        "llm_transcript_invalid",
        `${fixturePath} line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { details: { fixturePath, line: i + 1 } },
      );
    }
    const result = transcriptEntrySchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError(
        "llm_transcript_invalid",
        `${fixturePath} line ${i + 1} does not match the transcript schema: ${result.error.message}`,
        { details: { fixturePath, line: i + 1, issues: result.error.issues } },
      );
    }
    return result.data;
  });
}

/**
 * Serves recorded responses in order, and refuses to serve one that does not fit the request
 * asking for it: a drifted replay must fail loudly (a wrong tool-call sequence executed
 * against a fixture site is a worse outcome than a thrown error), never silently hand back
 * whatever line happens to be next.
 */
export function replayLlm(fixturePath: string): Llm {
  const entries = loadTranscript(fixturePath);
  let index = 0;

  return {
    async complete(req) {
      if (index >= entries.length) {
        throw new AppError(
          "llm_replay_exhausted",
          `${fixturePath} has ${entries.length} recorded turn(s); call ${index + 1} has none left`,
          { details: { fixturePath, index, length: entries.length } },
        );
      }
      const entry = entries[index]!;
      const recordedTools = entry.request.tools.map((t) => t.name).sort();
      const requestedTools = req.tools.map((t) => t.name).sort();
      if (JSON.stringify(recordedTools) !== JSON.stringify(requestedTools)) {
        throw new AppError(
          "llm_replay_diverged",
          `${fixturePath} turn ${index}: recorded tool set [${recordedTools.join(", ")}] does not match the requested tool set [${requestedTools.join(", ")}]`,
          { details: { fixturePath, index, recordedTools, requestedTools } },
        );
      }
      if (entry.request.messages.length !== req.messages.length) {
        throw new AppError(
          "llm_replay_diverged",
          `${fixturePath} turn ${index}: recorded ${entry.request.messages.length} message(s), request has ${req.messages.length}`,
          {
            details: {
              fixturePath,
              index,
              recordedCount: entry.request.messages.length,
              requestCount: req.messages.length,
            },
          },
        );
      }
      index++;
      return entry.response;
    },
  };
}
