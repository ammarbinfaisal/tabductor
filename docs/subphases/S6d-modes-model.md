# S6 mode model

Real authored tasks use `ai`. Browser tasks may become `compiled` only through the engine's
post-execution promotion path. `stub` remains supported solely for deterministic tests and is
not shown in authoring UI or produced by the graph compiler.

Decision tasks stay `ai`; they are not eligible for browser-script compilation. Python is not a
mode or a tool, and no Python runner exists.
