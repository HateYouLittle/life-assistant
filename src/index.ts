/**
 * MCP Server 入口（stdio）：被 Hermes Agent 拉起，暴露所有模块工具。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getModules } from "./modules/index.js";
import { notifyModule } from "./scheduler.js";
import { fail } from "./core/registry.js";

async function main(): Promise<void> {
  // 确保 notify 模块已注册（直接运行 index.ts 而不经 scheduler 时）
  if (!getModules().some((m) => m.name === "notify")) {
    void notifyModule;
  }

  const server = new McpServer({
    name: "life-assistant",
    version: "0.1.0",
  });

  let toolCount = 0;
  for (const m of getModules()) {
    for (const t of m.tools ?? []) {
      const fullName = `${m.name}.${t.name}`;
      server.registerTool(
        fullName,
        { description: t.description, inputSchema: t.schema },
        async (args) => {
          try {
            return await t.handler(args as Record<string, unknown>);
          } catch (e) {
            return fail((e as Error).message);
          }
        },
      );
      toolCount++;
    }
  }

  await server.connect(new StdioServerTransport());
  console.error(`[life-assistant] MCP server ready, ${toolCount} tools registered.`);
}

void main();
