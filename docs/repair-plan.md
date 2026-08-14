# 修复计划与进度文档（当前状态）

> 本文件是修复工作的唯一进度真相源。会话中断后，从本文件恢复：先读「当前状态」，
> 再执行「验证命令」确认现状，最后继续未完成项。
> 完整修复历史（问题清单/历轮审查表/进度日志）已归档：docs/history/repair-history.md。

## 当前状态（2026-08-14）

- **修复链已收官**：七轮修复 + 六轮独立审查全部闭环，零 P0/P1/P2/P3 待办。
- **基线**：`npm test` 222/222 全绿，`npm run build` 零错误，diff-check 干净。
- **HEAD**：`fedd467`（已推送远端 origin/main）。
- **终审结论**（第六轮 Codex CLI，2026-08-14）：可以无保留收官。

### 已知暂缓项（非缺陷，记录不改）

- 油价「全 0 调整窗口零通知」「漏窗口补发」：产品语义决策，先不动。
- schedule completeSchedule occurrenceKey 校验、农历 2100 上限、day=30 年份跳过：行为设计取舍。
- 投递表 retention 清理 job、X-Request-ID 匿名化、secret 熵校验增强：后续版本。
- notifier 每 tick 全表扫描 UPDATE 的索引优化：个人助理规模可接受，后续版本。
- npm audit 残留 2 个 moderate（node-cron→uuid 8.3.2，v3/v5/v6 buffer 路径实际不可利用）：修复需 node-cron 4 大版本，暂缓。
- 接受并记录（不改）：redactUrl 对非 URL 输入原样返回；catch-up 滞后无上限是有意语义；stale-snapshot 跳过日志刷屏（并发持续时）。

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
npm test                             # 全量，必须全绿（当前 222/222）
node --import tsx/esm --test tests/notification-publisher.test.ts tests/scheduler-notification-contract.test.ts
node --import tsx/esm --test tests/weather-provider.test.ts tests/weather-notification.test.ts tests/location.test.ts
node --import tsx/esm --test tests/oilprice-*.test.ts
node --import tsx/esm --test tests/schedule-*.test.ts tests/profile-schedule.test.ts
```

## 历史指针

- 修复链完整历史（问题清单、二次~五次审查表、进度日志）：`docs/history/repair-history.md`
- 审查报告存档：`~/artifacts/documents/life-assistant/codex-adversarial-review-20260814.md`
- DSH 任务书存档：`~/artifacts/documents/life-assistant/dsh-fix-prompt-*.md`
