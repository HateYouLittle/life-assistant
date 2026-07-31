# Life Assistant — 架构设计文档

> 个人生活助理：Skill + MCP 服务，适配 Hermes Agent
> 初版能力：天气查询与主动预警、油价查询与调价预通知、快递动态追踪与通知

---

## 1. 设计目标与原则

| 目标 | 说明 |
|---|---|
| Skill + MCP 双形态 | MCP Server 提供工具与数据能力；Skill（SKILL.md）告诉 Agent 何时、如何使用这些工具 |
| 主动推送 | MCP 本身是请求/响应模型，主动预警由内置调度器 + 通知通道适配器实现，同时提供"拉取待办通知"工具兜底 |
| 可扩展 | 新功能 = 新增一个模块目录，实现统一 `AssistantModule` 接口即可，核心零改动 |
| 低成本数据源 | 优先免费/低费率、高 QPS 额度的 API，全部通过 Provider 抽象，可替换 |
| 可开源 | MIT 协议、README / 贡献指南 / 环境变量示例齐全，密钥一律走环境变量 |

## 2. 总体架构

```
┌─────────────────────────── Hermes Agent ───────────────────────────┐
│  Skill (SKILL.md)  ── 触发词/使用指引/主动通知消费说明              │
│        │                                                           │
│        ▼  stdio (MCP 协议)                                          │
│  ┌────────────────────── MCP Server ──────────────────────────┐    │
│  │  Tool Router (模块注册器 registry)                          │    │
│  │  ├─ weather.*     天气模块                                  │    │
│  │  ├─ oilprice.*    油价模块                                  │    │
│  │  ├─ express.*     快递模块                                  │    │
│  │  ├─ location.*    位置服务（内建）                          │    │
│  │  └─ notify.*      通知管理（内建）                          │    │
│  │                                                             │    │
│  │  Scheduler (node-cron)  ──► 轮询/定时检查 ──► Notifier      │    │
│  │  Notifier ──► [stdout | webhook | Bark | Server酱 | ...]    │    │
│  │  Store (JSON 文件 / 可换 SQLite)                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
              │                    │                    │
        Open-Meteo / 和风     发改委调价窗口        快递100 / 快递鸟
        （天气+预警）         + 油价 Provider       （物流轨迹）
```

### 进程形态

项目包含两个可独立运行的入口：

1. **`src/index.ts` — MCP Server（stdio）**：被 Hermes Agent 拉起，响应工具调用。
2. **`src/scheduler.ts` — 常驻调度进程**：运行所有模块注册的定时任务，产生主动通知。与 MCP Server 共享同一份 Store 与配置，可独立部署（systemd / pm2 / docker）。

> 单机场景下也可用 `npm run dev:all` 同进程运行，便于开发调试。

## 3. 核心框架设计

### 3.1 模块插件机制（扩展接口）

```ts
interface AssistantModule {
  name: string;                    // 模块名，作为工具名前缀
  tools?: ToolDef[];               // 暴露给 Agent 的 MCP 工具
  jobs?: JobDef[];                 // 注册给调度器的定时任务
}

interface ToolDef {
  name: string;                    // 如 "current" → 完整名 "weather.current"
  description: string;             // 给 LLM 看的工具说明（影响调用准确率，需认真写）
  schema: ZodRawShape;             // 参数 zod schema
  handler: (args) => Promise<ToolResult>;
}

interface JobDef {
  name: string;
  cron: string;                    // 标准 cron 表达式
  handler: (ctx: JobContext) => Promise<void>;
}
```

新增功能（如"空气质量""限行提醒""话费提醒"）只需：
1. 在 `src/modules/<feature>/index.ts` 实现 `AssistantModule`；
2. 在 `src/modules/index.ts` 的数组里加一行注册。

**核心文件零改动**，这是预留扩展接口的落点。

### 3.2 主动推送通道（Notifier）

MCP 无法由服务端主动反向调用客户端，因此采用"双通道"策略：

- **推（推荐）**：调度进程触发事件 → `Notifier` 扇出到已配置的通道：
  - `stdout`：本地打印（默认，零配置）；
  - `webhook`：POST 到任意 URL（可接 Hermes Agent 的回调、飞书/企微机器人）；
  - `bark`：iOS 推送；`serverchan`：微信推送（Server酱）。
- **拉（兜底）**：所有通知同时写入 Store 的 `pending_notifications` 队列，暴露 `notify.pull` 工具。Skill 指引 Agent 在每次会话开始时调用一次，取走未读通知 —— 即使推送通道全部失效，用户下次对话也能收到预警。

通知去重：每条通知带 `dedupe_key`（如 `weather:alert:北京:2026-07-31:暴雨红色`），Store 记录已发 key，避免重复轰炸。

### 3.3 存储（Store）

默认 JSON 文件（`DATA_DIR/store.json`），`Store` 类只依赖 `get/set/del` 三个原子操作，后续可平替 SQLite / Redis 而不动业务代码。存储内容：位置信息、快递订阅列表与最近状态、通知去重 key、待读通知队列。

### 3.4 位置服务（Location）

首次运行策略（两级）：

1. **自动探测（建议方案）**：调用 `ip-api.com`（免费、无需 Key、45 次/分钟）基于出口 IP 反推城市与经纬度，作为**建议值**返回；
2. **用户确认**：`location.get` 在没有任何已确认位置时，返回 `{ status: "need_confirm", suggestion }`，由 Agent 向用户复述并请其确认；用户确认后调用 `location.set` 落盘。

> 为什么不做"全自动"：IP 定位在移动网络/VPN 下误差可达城市级，天气和油价都对城市敏感，首次让 Agent 用自然语言确认一次是准确率与体验的最佳平衡。后续可扩展：Hermes 客户端若支持浏览器 Geolocation 或手机 GPS 回传，可在 `location.set` 里直接传精确经纬度，优先级高于 IP 结果。

## 4. 数据源选型

| 能力 | 首选 | 备选 | 理由 |
|---|---|---|---|
| 实时天气/预报 | **Open-Meteo**（免费、无 Key、非商用 1 万次/天） | 和风天气免费版（1000 次/天）、高德天气 | 零成本零门槛起步，Provider 抽象可热替换 |
| 天气预警 | **和风天气预警 API**（免费版支持） | 中央气象台页面解析 | 国内官方预警口径全；无 Key 时降级为 Open-Meteo 阈值推断（暴雨/高温/大风经验阈值） |
| 油价查询 | Provider 抽象 + **聚合数据油价 API**（低成本，约 0.01 元/次量级） | 公开油价页解析（兜底，需注意合规与稳定性） | 国内无官方免费 API，故做双实现 |
| 调价窗口 | **本地算法推算**：发改委"10 个工作日一调"机制 + 内置年度窗口表，调整日前一天 18:00 发布公告 | — | 完全免费且最可靠，预通知在窗口前 24h/1h 各推一次 |
| 快递轨迹 | **快递100 实时查询 API**（免费额度，需 customer+key） | 快递鸟免费版 | 轮询 + 状态 diff 即可实现"变更通知"，不依赖付费订阅推送接口 |

所有外部调用收敛在各模块的 `provider.ts`，替换数据源 = 实现同一接口 + 改一行配置。

## 5. 工具清单（MCP Tools v0.1）

| 工具 | 说明 |
|---|---|
| `location.get` / `location.set` / `location.detect` | 位置查询/确认/自动探测 |
| `weather.current` | 实时天气（温度、体感、风力、湿度） |
| `weather.forecast` | 未来 N 天预报 |
| `weather.alerts` | 当前生效的气象预警 |
| `oilprice.current` | 当地 92#/95#/0# 油价 |
| `oilprice.next_adjustment` | 下次调价窗口、预计方向与倒计时 |
| `express.track` | 订阅一个单号的动态追踪 |
| `express.list` / `express.untrack` | 查看/取消追踪列表 |
| `express.query` | 立即查询某单号最新轨迹 |
| `notify.pull` | 拉取未读主动通知 |

## 6. 目录结构

```
life-assistant/
├── README.md                 # 项目门面：功能、快速开始、配置、Roadmap
├── CONTRIBUTING.md           # 贡献指南（分支、Commit、如何新增模块）
├── LICENSE                   # MIT
├── package.json / tsconfig.json / .env.example
├── skill/
│   └── SKILL.md              # Hermes Agent 技能定义（触发词 + 工具使用指引）
├── docs/
│   └── architecture.md       # 本文档
└── src/
    ├── index.ts              # MCP Server 入口（stdio）
    ├── scheduler.ts          # 常驻调度进程入口
    ├── config.ts             # 环境变量与全局配置
    ├── core/
    │   ├── registry.ts       # 模块注册器
    │   ├── store.ts          # JSON 存储
    │   ├── notifier.ts       # 通知通道适配器
    │   ├── location.ts       # 位置服务（IP 探测 + 确认流）
    │   └── http.ts           # fetch 封装（超时/重试）
    └── modules/
        ├── index.ts          # 模块清单（扩展点）
        ├── weather/          # index.ts + provider.ts
        ├── oilprice/         # index.ts + schedule.ts + provider.ts
        └── express/          # index.ts + provider.ts
```

## 7. 主动通知时序

```
scheduler (cron)
  │ 每 30min: weather.alerts_check ──► 有新预警? ──是──► Notifier.fanout("⛈ 暴雨红色预警…")
  │ 每天 09:00: oilprice.watch ──► 距调价窗口<24h? ──是──► Notifier.fanout("⛽ 明晚24时油价或上调…")
  │ 每 30min: express.poll ──► 轨迹状态 diff? ──是──► Notifier.fanout("📦 顺丰xxx 已签收")
  │
  └──► 所有通知同时入 notify.pull 队列（Agent 会话开始时拉取兜底）
```

## 8. Roadmap（预留扩展方向）

- v0.2：SQLite 存储、通知通道插件化市场（钉钉/飞书/邮件）
- v0.3：新模块示例 —— 空气质量、车辆限行、纪念日提醒
- v0.4：多用户/多位置支持、Web 配置面板
