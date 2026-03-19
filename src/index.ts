#!/usr/bin/env node
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { program } from "commander";

import { appConfig } from "@/config";
import { Context } from "@/context";
import { startDaemonRuntime } from "@/daemon/server";
import { guideResources } from "@/resources/guides";
import type { Resource } from "@/resources/resource";
import { createServerWithTools } from "@/server";
import * as session from "@/tools/session";
import type { Tool } from "@/tools/tool";

import packageJSON from "../package.json";

function setupExitWatchdog(server: Server) {
  process.stdin.on("close", async () => {
    setTimeout(() => process.exit(0), 15000);
    await server.close();
    process.exit(0);
  });
}

const baseTools: Tool[] = [
  session.listSessions,
  session.state,
  session.overview,
  session.actionables,
  session.snapshot,
  session.navigate,
  session.click,
  session.hover,
  session.type,
  session.selectOption,
  session.goBack,
  session.goForward,
  session.pressKey,
  session.wait,
  session.getConsoleLogs,
  session.runJs,
  session.screenshot,
  session.fetchImage,
  session.describeRef,
  session.findText,
];

function aliasTool(tool: Tool): Tool[] {
  if (!tool.schema.name.startsWith("browser_")) {
    return [tool];
  }

  return [
    tool,
    {
      ...tool,
      schema: {
        ...tool.schema,
        name: tool.schema.name.replace(/^browser_/, "tabductor_"),
        description: tool.schema.description.replaceAll("Browser MCP", "Tabductor"),
      },
    },
  ];
}

const tools: Tool[] = baseTools.flatMap(aliasTool);

const resources: Resource[] = [...guideResources];

async function createServer(): Promise<Server> {
  const context = await Context.createRemote();
  return createServerWithTools({
    name: appConfig.name,
    version: packageJSON.version,
    tools,
    resources,
    context,
  });
}

/**
 * Note: Tools must be defined *before* calling `createServer` because only declarations are hoisted, not the initializations
 */
program
  .version("Version " + packageJSON.version)
  .name(packageJSON.name)
  .action(async () => {
    const server = await createServer();
    setupExitWatchdog(server);

    const transport = new StdioServerTransport();
    await server.connect(transport);
  });

program.command("daemon").action(async () => {
  await startDaemonRuntime();
  await new Promise(() => undefined);
});

program.parse(process.argv);
