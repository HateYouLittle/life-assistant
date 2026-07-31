# 贡献指南

感谢你的兴趣！本项目刻意保持小而清晰，欢迎以下方向的贡献：

## 高价值贡献点

- **新功能模块**：空气质量、限行提醒、话费/纪念日提醒等（见下文"新增模块"）
- **新数据源 Provider**：为 weather / oilprice / express 实现更多 Provider（同接口替换）
- **新通知通道**：钉钉、飞书、企业微信、邮件、Telegram（在 `src/core/notifier.ts` 数组中加一项）
- **年度调价窗口表校准**：每年初按发改委公告更新 `src/modules/oilprice/schedule.ts`

## 开发流程

1. Fork 并克隆， `npm install`
2. 从 `main` 切功能分支：`feat/xxx` 或 `fix/xxx`
3. 开发调试：`npm run dev`（MCP Server）、`npm run dev:scheduler`（调度进程）
4. 提交前确保 `npm run build` 通过（TypeScript strict 模式，零 error）
5. 提 PR，说明动机、方案、测试方式

## Commit 规范

`type(scope): message`，如：

- `feat(weather): add air quality provider`
- `fix(express): dedupe notification on retry`
- `docs: update README quickstart`

## 新增模块约定

- 目录：`src/modules/<name>/index.ts`（+ 可选 `provider.ts` 隔离外部 API）
- 实现 `AssistantModule` 接口并自注册（`registerModule`）
- 工具 `description` 写给 LLM 看：说清适用场景、参数含义、失败行为
- 所有外部 HTTP 调用走 `core/http.ts`（统一超时重试）；所有密钥走环境变量 + `config.ts`
- 定时任务必须做失败容错（单轮失败不影响下轮）与通知去重（`dedupeKey`）

## 行为准则

尊重、务实、对事不对人。维护者保留合并与否的决定权。
