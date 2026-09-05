import { getEngineStatus } from "@tabductor/engine";
import { procedure, router } from "../trpc.js";

/**
 * What the engine process registered at boot (U3a) — the `(kind, mode)` pairs a run can be
 * dispatched to — plus whether it is still heartbeating. The editor's mode selector and
 * `/status` read this rather than guessing from the web process's own environment: the
 * two processes share only Postgres and may be configured differently.
 */
export const engineRouter = router({
  status: procedure.query(({ ctx }) => getEngineStatus(ctx.db)),
});
