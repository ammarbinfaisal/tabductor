import { createWorkflowMcpServer } from "@tabductor/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createContext } from "../../../server/trpc.js";
import { createWorkflowControl } from "../../../server/workflow-mcp.js";
import { accountIdForMcpRequest } from "../../../server/auth-context.js";

async function handle(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createWorkflowMcpServer(createWorkflowControl({
    ...createContext(await accountIdForMcpRequest(request)),
  }));
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
