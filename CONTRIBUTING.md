# 贡献指南

Life Assistant 的核心边界是模块产生日程或公共事件，SQLite 持久化 Profile notification/outbox，Hermes Gateway 负责具体消息平台。贡献应保持这个分层。

## 高价值方向

- 新生活信息模块，例如限行或话费提醒。
- weather / oilprice / airquality 的新 Provider，以及年度油价调价窗口校准。
- automation 白名单 action 扩展（在 `src/modules/automation/actions.ts` 注册，必须复用模块 Provider、无 LLM）与条件组合能力（多条件 AND/OR）。
- 日程、outbox、Profile 隔离、静默时段和 snooze 的可靠性改进。

快递模块已封存，不作为当前 Provider 扩展方向。

## 开发流程

采用 TDD：先写能表达预期行为或复现问题的测试，再实现最小改动，最后补齐边界用例。提交 PR 前运行：

```bash
npm test
npm run build
git diff --check
```

推荐流程：

1. `npm install` 安装依赖。
2. 从 `main` 创建 `feat/<name>` 或 `fix/<name>` 分支。
3. 使用 `npm run dev` 调试 MCP，使用 `npm run dev:scheduler` 调试独立 scheduler。
4. 保持改动聚焦，并检查没有提交 `.env`、SQLite/WAL、secret 或个人标识。
5. PR 说明动机、作用域、公共/私有数据语义和验证方式。

## 模块与 Provider

- 模块放在 `src/modules/<name>/index.ts`，实现并注册 `AssistantModule`，再由 `src/modules/index.ts` 导入。
- 工具 `description` 是给 Agent 的契约，需要明确场景、参数、作用域和失败行为。
- 外部 API 放在模块 `provider.ts`，通用 HTTP 行为复用 `core/http.ts`；不要在 handler 或 scheduler 中散落请求逻辑。
- API key、token 和 Webhook secret 只来自环境变量。不得写入源码、测试 fixture、日志、文档示例或 Git。
- Provider 必须有显式超时、有限重试和可理解的降级/错误信息；日志不得包含 URL query 中的 secret 或完整敏感响应。

## 通知与 Profile 规则

- 模块不得直绑 QQ、微信、Bark、Server酱或其他平台 SDK/HTTP API。
- 公共模块 job 使用 `ctx.notify`，由 Profile fan-out、outbox 和 Hermes Webhook 处理投递。
- 私有事件必须有明确 Profile 所有者并使用 Profile 发布路径；日程表、occurrence、notification、read 和 delivery 不得跨 Profile。
- 不要在核心 notifier 中增加第三方平台分支。平台账号和 `--deliver` 目标由 Hermes Webhook/Gateway 管理。
- `notify.pull` 是主动投递失败或 route 未配置时的恢复路径，不是第二条并行发送通道。

## 新 job 要求

每个 job 必须：

- 声明适合业务的 cron 和 IANA timezone，不能依赖模糊的服务器本地时间假设；
- 使用跨重启稳定的 `dedupeKey`，通常包含业务事件身份和目标本地日期/occurrence；
- 对单轮 Provider 失败容错，不让异常阻断 scheduler 的后续轮次；
- 明确事件是公共还是 Profile 私有，并覆盖相应隔离测试；
- 通过 `ctx.notify` 或明确的 Profile 发布接口进入持久 outbox。

静态或重复个人提醒应优先使用现有 `schedule`，无需增加模块 job。白名单数据源上的条件触发提醒应使用现有 `automation`，无需增加模块 job。白名单之外数据源的实时固定任务适合 code-defined job；把数据源加进 automation 白名单前，先确认它适合按 10 分钟级扫描的确定性执行语义。

## Commit 规范

格式为 `type(scope): message`，例如：

- `feat(weather): add air quality provider`
- `fix(schedule): preserve profile ownership on update`
- `docs: update Hermes webhook setup`

## 行为准则

尊重、务实、对事不对人。维护者保留合并与否的决定权。
