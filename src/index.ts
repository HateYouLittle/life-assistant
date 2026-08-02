/** MCP Server entry point. It never starts cron jobs. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getModules } from "./modules/index.js";
import "./core/notify-module.js";
import { fail } from "./core/registry.js";
import { requireProfileContext } from "./core/profile.js";

async function main(): Promise<void> {
  const profile = requireProfileContext();
  const server = new McpServer({ name: "life-assistant", version: "0.2.0" });
  let toolCount = 0;
  for (const module of getModules()) {
    for (const tool of module.tools ?? []) {
      server.registerTool(`${module.name}.${tool.name}`, { description: tool.description, inputSchema: tool.schema }, async (args) => {
        try {
          return await tool.handler(args as Record<string, unknown>, profile);
        } catch (error) {
          return fail((error as Error).message);
        }
      });
      toolCount += 1;
    }
  }
  await server.connect(new StdioServerTransport());
  console.error(`[life-assistant] MCP server ready, profile=${profile.id}, ${toolCount} tools registered.`);
}

void main();
