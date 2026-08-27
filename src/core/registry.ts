import { z, type ZodRawShape } from "zod";
import type { ProfileContext } from "./profile.js";

export interface ToolResult {
  [x: string]: unknown; // 兼容 MCP SDK CallToolResult
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  /** 短名，注册后完整名为 `${module.name}.${tool.name}` */
  name: string;
  /** 给 LLM 的工具说明，直接影响调用准确率，务必写清适用场景与参数含义 */
  description: string;
  schema: ZodRawShape;
  handler: (args: Record<string, unknown>, context?: ProfileContext) => Promise<ToolResult>;
}

export interface JobContext {
  notify: (title: string, body: string, dedupeKey?: string) => Promise<void>;
  notifyGlobal?: (source: string, title: string, body: string, dedupeKey?: string) => Promise<void>;
}

export interface JobDef {
  name: string;
  cron: string;
  timezone?: string;
  handler: (ctx: JobContext) => Promise<void>;
}

/**
 * 工具定义的统一构造器：schema 只声明一次，注册与参数解析共用同一形状；
 * args 归一化为对象后交给业务函数，异常统一转 isError 结果。
 */
export function withTool<S extends ZodRawShape>(
  def: { name: string; description: string },
  schema: S,
  run: (args: z.output<z.ZodObject<S>>, context?: ProfileContext) => Promise<ToolResult> | ToolResult,
): ToolDef {
  const parser = z.object(schema);
  return {
    name: def.name,
    description: def.description,
    schema,
    handler: async (args, context) => {
      try {
        return await run(parser.parse(args ?? {}), context);
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  };
}

/**
 * 模块扩展接口：新增功能只需实现此接口并在 src/modules/index.ts 注册，
 * 核心代码零改动。
 */
export interface AssistantModule {
  name: string;
  tools?: ToolDef[];
  jobs?: JobDef[];
  /** 可选：scheduler 取得租约后启动时执行一次（如引导抓取全局数据）；异常由 scheduler 隔离记录。 */
  onStart?: () => Promise<void>;
}

const modules: AssistantModule[] = [];

export function registerModule(m: AssistantModule): void {
  if (modules.some((x) => x.name === m.name)) {
    throw new Error(`duplicate module: ${m.name}`);
  }
  modules.push(m);
}

export function getModules(): AssistantModule[] {
  return modules;
}

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}
