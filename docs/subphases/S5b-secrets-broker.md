# S5 secrets broker

Implemented. The browser agent can ask the host to fill a named secret into a visible,
same-origin text/password/email field. The broker resolves the run owner, checks grants and
origin constraints, decrypts only for the single low-level insertion, zeros plaintext buffers,
and records metadata without the value. It never returns plaintext to an agent.

Decision tasks have no secret tool. The workflow-level MCP server is a control-plane API and
does not inject secrets into workflow execution.
