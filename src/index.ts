/** MCP Server entry point. It never starts cron jobs. */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getModules } from "./modules/index.js";
import "./core/notify-module.js";
import { fail } from "./core/registry.js";
import { requireProfileContext } from "./core/profile.js";

// L21：版本号单一来源 = package.json（dist/index.js 的 ../package.json 即仓库根目录）。
// 不用 import attributes：rootDir=src 会报 TS6059。
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

async function main(): Promise<void> {
  const profile = requireProfileContext();
  const server = new McpServer({ name: "life-assistant", version: pkg.version });
  let toolCount = 0;
  for (const module of getModules()) {
    for (const tool of module.tools ?? []) {
      server.registerTool(`${module.name}.${tool.name}`, { description: tool.description, inputSchema: tool.schema }, async (args) => {
        try {
          return await tool.handler(args as Record<string, unknown>, profile);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      });
      toolCount += 1;
    }
  }
  await server.connect(new StdioServerTransport());
  console.error(`[life-assistant] MCP server ready, profile=${profile.id}, ${toolCount} tools registered.`);
}

void main();
