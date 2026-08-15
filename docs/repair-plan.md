# 修复计划与进度文档（当前状态）

> 本文件是修复工作的唯一进度真相源。会话中断后，从本文件恢复：先读「当前状态」，
> 再执行「验证命令」确认现状，最后继续未完成项。
> 完整修复历史（问题清单/历轮审查表/进度日志）已归档：docs/history/repair-history.md。

## 当前状态（2026-08-15）

- **修复链（既有模块）已收官**：七轮修复 + 六轮独立审查全部闭环，零待办。终审结论（第六轮
  Codex CLI，2026-08-14）：可以无保留收官。历史见 docs/history/repair-history.md。
- **holiday/workday 功能已交付并收官**（2026-08-15）：中国大陆法定节假日/工作日模块
  （4 个 MCP 工具 + 日程 workday/holiday 频率 + schema v4 + 每日刷新 job）。
  实现经 **6 批修复（T1-T4 / H1-H5 / K1-K3 / M1-M3 / N1-N3 / N4，共 19 个编号缺陷 + 1 个 P3 顺手项）+ 7 轮
  Codex 独立复审** 闭环，最终轮（2026-08-15）结论：**可以无保留验收**，零 P0/P1/P2。
  核心保证「无数据年份绝不按普通周历猜测」在所有查询与 schedule 路径生效。
- **基线**：`npm test` 333/333 全绿（222 既有 + 111 holiday 相关新增），`npm run build`
  零错误，diff-check 干净。
- **HEAD**：`d942c3a`（feat: 新增中国大陆法定节假日/工作日模块（holiday）——功能、测试、docs 已一并提交；提交前基线 333/333 全绿、build 零错误；2026-08-15 全量复审后另见 docs/final-review-and-fix-plan.md，修复工作在 `fix/final-review-20260815` 分支进行）。
- **交付文档**：`docs/holiday-workday-implementation-review.md`（设计、数据源、校验策略、
  六批修复记录、最终复审清单、部署注意）。

### 已知暂缓项（非缺陷，记录不改）

- 油价「全 0 调整窗口零通知」「漏窗口补发」：产品语义决策，先不动。
- schedule completeSchedule occurrenceKey 校验、农历 2100 上限、day=30 年份跳过：行为设计取舍。
- 投递表 retention 清理 job、X-Request-ID 匿名化、secret 熵校验增强：后续版本。
- notifier 每 tick 全表扫描 UPDATE 的索引优化：个人助理规模可接受，后续版本。
- npm audit 残留 2 个 moderate（node-cron→uuid 8.3.2，v3/v5/v6 buffer 路径实际不可利用）：修复需 node-cron 4 大版本，暂缓。
- 接受并记录（不改）：redactUrl 对非 URL 输入原样返回；catch-up 滞后无上限是有意语义；stale-snapshot 跳过日志刷屏（并发持续时）。
- holiday 遗留 P3（不阻塞验收，建议后续版本/专项）：
  - papers 域名白名单（官方发布证明 URL 协议/域名校验）：建议与数据安全专项合并；
  - ingestHolidayYear 入口自校验（生产链已有 parseDataset 校验，内部导出可补强）：低成本，可顺手；
  - 刷新统计日志（ensure/refresh 的 fetched/skipped 明细）：记入后续版本；
  - timezone 兜底（workday/holiday 强制 Asia/Shanghai 是设计决定）：与整体时区策略统一评审；
  - v4 迁移专项测试补强（新表与 CHECK 断言）：后续补；
  - schedule 测试时钟注入（FIXED_TEST_YEAR=2026 已消除 now().year，create/update/reconcile
    仍用真实系统时钟）：后续注入 now/clock 抽象，跨年时同步推进常量。

## 修复纪律

1. 一个提交/批次只修一类问题；每批之后必须跑相关测试与 `npm run build`。
2. 不改测试以掩盖失败；若修复改变了既有语义（如 recurring 补发），必须同步更新
   测试并说明理由。
3. 文件分区（避免并行子代理互相覆盖）：
   - 主代理：`src/core/notifier.ts`、`src/scheduler.ts`、`package.json`、
     `.gitignore`、`docs/`、`README.md`、测试新增（notifier/scheduler 相关）。
   - 子代理（DeepSeek Harness / flash 代理）：weather/oilprice/schedule 分区。
   - 任何人不得改分区之外的文件；docs 由主代理统一更新。
4. 子代理模型：workflow 工具，`provider: deepseek-official`、`model: deepseek-v4-flash`；
   Codex CLI（独立审查）用于对抗性复审。

## 验证命令

```bash
npm run build                        # 必须零错误
npm test                             # 全量，必须全绿（当前 333/333）
node --import tsx/esm --test tests/notification-publisher.test.ts tests/scheduler-notification-contract.test.ts
node --import tsx/esm --test tests/weather-provider.test.ts tests/weather-notification.test.ts tests/location.test.ts
node --import tsx/esm --test tests/oilprice-*.test.ts
node --import tsx/esm --test tests/schedule-*.test.ts tests/profile-schedule.test.ts
node --import tsx/esm --test tests/holiday-*.test.ts
```

## 历史指针

- 修复链完整历史（问题清单、二次~五次审查表、进度日志）：`docs/history/repair-history.md`
- 既有模块审查报告存档：`~/artifacts/documents/life-assistant/codex-adversarial-review-20260814.md`
- holiday 七轮审查报告存档（2026-08-15）：
  `~/artifacts/documents/life-assistant/codex-holiday-review-20260815.md`（第一轮）、
  `codex-holiday-review-r2~r7-20260815.md`（第二~七轮）
- DSH 任务书存档：`~/artifacts/documents/life-assistant/dsh-fix-prompt-*.md`
  （既有批次 p3/p5/p6/n1n4 + holiday 批次 holiday-r1~r6）
