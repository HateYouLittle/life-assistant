# 修复计划与进度文档

> 本文件是修复工作的唯一进度真相源。会话中断后，从本文件恢复：先读「进度日志」，
> 对照「问题清单」的 `状态` 列，再执行「验证命令」确认现状，最后继续未完成项。

- 创建时间：2026-08-13
- 基线：`git log -1 --oneline` = `194751a docs: document platform markdown rendering and renderTarget config`
- 基线验证：`npm run build` 通过；`npm test` 171/171 通过

## 修复纪律

1. 一个提交/批次只修一类问题；每批之后必须跑相关测试与 `npm run build`。
2. 不改测试以掩盖失败；若修复改变了既有语义（如 recurring 补发），必须同步更新
   测试并说明理由。
3. 文件分区（避免并行子代理互相覆盖）：
   - 本会话（主代理）：`src/core/notifier.ts`、`src/scheduler.ts`、`package.json`、
     `.gitignore`、`docs/`、`README.md`、测试新增（notifier/scheduler 相关）。
   - flash 代理 W：`src/modules/weather/*.ts`、`src/core/location.ts`、`src/core/http.ts`。
   - flash 代理 O：`src/modules/oilprice/*.ts`。
   - flash 代理 S：`src/modules/schedule/*.ts`（不含 `src/scheduler.ts`）。
   - 任何人不得改分区之外的文件；docs 由主代理统一更新。
4. 子代理模型：workflow 工具，`provider: deepseek-official`、`model: deepseek-v4-flash`。

## 问题清单（状态：todo / doing / done / skipped）

### P1（必须修）

| # | 问题 | 文件:行 | 负责 | 状态 |
|---|---|---|---|---|
| P1-01 | API Key 随错误消息进日志/MCP 回传 | core/http.ts:14; weather/provider.ts:136,171,238; weather/index.ts:178 | W | done |
| P1-02 | 和风业务错误码未检查，预警静默为空 | weather/provider.ts:193-235 | W | done |
| P1-03 | location.set 经纬度无范围校验、city 空串 | core/location.ts:18-23 | W | done |
| P1-04 | v7 location 坐标顺序 lat,lon 应为 lon,lat | weather/provider.ts:123,159 | W | done |
| P1-05 | fallback 终态：route 同名恢复无法重新投递 | core/notifier.ts:187-201,280-292 | 主 | done |
| P1-06 | notify(title,body) 二参形式内容错位 | core/notifier.ts:429-430,99-103 | 主 | done |
| P1-07 | schedule hydration 形状错误 → 永久 poison 行 | schedule/service.ts:38-44,347-354 | S | done |
| P1-08 | scheduler 乐观锁不检查 changes（陈旧通知） | scheduler.ts:168-176 | 主 | done |
| P1-09 | recurring 窗口内创建/更新静默跳过当天提醒 | schedule/service.ts:295-345 | S | done |
| P1-10 | 油价窗口表仅到 2026，跨年后静默失效 | oilprice/schedule.ts:14-20; index.ts:59 | O | done |
| P1-11 | 油价 state 无形状/版本校验，损坏即每日失败 | oilprice/watch.ts:95-104,26-36 | O | done |
| P1-12 | 城市→省份映射覆盖不足 | oilprice/provider.ts:42-55,134,189-194 | O | done |

### P2（本批选做）

| # | 问题 | 文件:行 | 负责 | 状态 |
|---|---|---|---|---|
| P2-01 | engines >=22.5 与 node:sqlite flag 事实不符 | package.json:8; README.md:42,203 | 主 | done |
| P2-02 | 密钥备份文件未忽略 | .gitignore | 主 | done |
| P2-03 | npm audit 8 漏洞（fast-uri/hono/uuid） | package-lock | 主 | done |
| P2-04 | weather: days 未 .int() | weather/index.ts:210-213 | W | done |
| P2-05 | weather: inferred 分支无 try/catch | weather/index.ts:134-140 | W | done |
| P2-06 | weather: daily brief identity 不含城市 | weather/index.ts:101 | W | done |
| P2-07 | weather: precip NaN / "0mm" 噪音 | weather/provider.ts:167 | W | done |
| P2-08 | httpJson timer 未在 finally 清理 | core/http.ts:10-15 | W | done |
| P2-09 | byWeekday 非法字符串静默丢弃 | schedule/index.ts:24; service.ts:243-246 | S | done |
| P2-10 | 重复 reminder id 静默折叠 | schedule/service.ts:116-120 | S | done |
| P2-11 | until 格式/count 与 until 互斥未校验 | schedule/index.ts:26-27; service.ts:248 | S | done |
| P2-12 | update 对 recurrence 浅合并丢字段 | schedule/service.ts:480-500 | S | done |
| P2-13 | schedule 默认时区硬编码 Asia/Shanghai | schedule/service.ts:23,168 | S | done |
| P2-14 | title/note 无长度上限 | schedule/index.ts:33-34 | S | done |
| P2-15 | oilprice: code "200" 字符串被拒 | oilprice/provider.ts:146 | O | done |
| P2-16 | oilprice: 精确到分校验过严（±1 分容差） | oilprice/provider.ts:111-113 | O | done |
| P2-17 | oilprice: hoursUntil 浮点长尾 | oilprice/schedule.ts:38 | O | done |
| P2-18 | oilprice: TianAPI 异常全量吞掉诊断丢失 | oilprice/provider.ts:136-172 | O | done |
| P2-19 | oilprice: nextWindowDate 未用于交叉校验 | oilprice/provider.ts:163 | O | done |
| P2-20 | tick 无重叠保护 | scheduler.ts:279-287 | 主 | done |
| P2-21 | 第二 scheduler 未获租约静默 exit(0) | scheduler.ts:225,296-304 | 主 | done |
| P2-22 | legacyId 依赖运算符优先级可读性差 | core/notifier.ts:151-153 | 主 | done |

### 明确不改（本批跳过，理由）

- 油价「全 0 调整窗口零通知」「漏窗口补发」：产品语义决策，先不动。
- schedule completeSchedule occurrenceKey 校验、农历 2100 上限、day=30 年份跳过：行为设计取舍。
- 投递表 retention 清理 job、X-Request-ID 匿名化、secret 熵校验增强：后续版本。
- notifier 每 tick 全表扫描 UPDATE 的索引优化：个人助理规模可接受，后续版本。

## 二次审查（对抗性复审）

修复 commit `b274d08` 之后，用 3 个全新 flash 审查代理对全部 diff 做了对抗性复审（只读），
发现并修复：

| 级别 | 问题 | 修复 |
|---|---|---|
| P0 | sanitizeRecurrence 丢弃 leapMonthPolicy，农历闰月日程读取侧按普通月算日期 | 保留 JSON 中的合法策略 + 以 `leap_month_policy` 列值为权威覆盖；回归测试 |
| P1 | ±1 分容差只在 provider 放宽，watch.ts:117 仍严格比对 → 官方结果静默丢弃 | watch 消费端同口径放宽；端到端发布测试 + 2 分拒绝测试 |
| P1 | 数字型 code 绕过和风业务错误码检查（fetchAlerts 静默为空） | 三处改为 `String(r.code) !== "200"` 统一比较 |
| P1 | legacy 行同时含 count+until 时任何 update 被互斥校验误伤 | hydration 侧保留 count 丢弃 until；回归测试 |
| P1 | 格式合法但日历非法的 until（2099-02-30）仍打挂读取路径 | sanitize 用 luxon 校验日历合法性，非法丢弃；回归测试 |
| P2 | daily-brief 键加城市后升级当天与旧键重复推送 | runDailyWeatherBrief 传 legacy 键走既有改键复用机制；回归测试 |
| P2 | fallback 重新入队重置 request_generation=1，可能与漂移前 a1 请求号撞号 | 改为 `request_generation + 1` |
| P2 | hoursUntil 四舍五入使 `hoursUntil < 40` 阈值漂移（39.96→40 漏发 advance） | 逻辑用精确值，仅工具展示层取整 |
| P2 | isValidOilPriceState 拒绝缺 schemaVersion 的完整旧 state → 升级后吞掉在途窗口结果 | schemaVersion 允许缺失（其余字段严格校验）；迁移测试 |
| P2 | 旧库脏位置数据（空 city/越界坐标）继续毒化天气/油价链路 | currentLocation 读取侧 safeParse 校验 + env 坐标校验 |
| P2 | resolveLocation / qweatherGeo 的兜底坐标未校验（与 location.detect 不对称） | 两处补有限性/范围校验，qweatherGeo 拒绝垃圾坐标入缓存 |
| P2 | hydration 后重复 reminder id 静默折叠 | sanitizeReminders 重复 id 回退为位置 id；回归测试 |
| P2 | nearestWindowDeviationDays 遇表内非法条目得 NaN 禁用告警 | 循环内 Number.isFinite 防御 |
| P2 | 测试缺口（边界坐标/NaN、迁移场景） | location 边界接受测试、oilprice 迁移测试 |

接受并记录（不改）：redactUrl 对非 URL 输入原样返回（当前无调用方）；catch-up 滞后无上限
（targetAt 仍在未来即补发是有意语义）；stale-snapshot 跳过日志可能刷屏（并发持续时）。

## 验证命令

```bash
npm run build                        # 必须零错误
npm test                             # 全量，必须全绿（当前 171/171）
node --import tsx/esm --test tests/notification-publisher.test.ts tests/scheduler-notification-contract.test.ts
node --import tsx/esm --test tests/weather-provider.test.ts tests/weather-notification.test.ts tests/location.test.ts
node --import tsx/esm --test tests/oilprice-*.test.ts
node --import tsx/esm --test tests/schedule-*.test.ts tests/profile-schedule.test.ts
```

## 进度日志（新条目加在最上面）

- 2026-08-13 二次对抗性复审（3 路 flash 代理）完成：发现 1 P0 + 3 P1 + 若干 P2（见
  「二次审查」表），全部修复并补回归测试（含 lunar 闰月 hydration、legacy count+until
  更新、日历非法 until、重复 reminder id、daily-brief legacy 改键、±1 分端到端发布、
  无 schemaVersion 迁移、坐标边界/NaN 等 9 个新用例）。最终验证：npm run build 零错误、
  npm test 204/204 全绿。已提交 commit `dba9d96`。
- 2026-08-13 全部 P1（12 项）与 P2-01..P2-22 完成：主代理修复 notifier/scheduler/package/gitignore；
  三路 flash 子代理（workflow，deepseek-v4-flash）修复 weather/oilprice/schedule 分区；
  主代理集成审查修正两处：O8 窗口交叉校验改为"最近窗口日±1 天"（消除每日误告警）、
  sanitizeRecurrence 对 until/byWeekday/byMonthDay/count 补类型强制。npm audit fix 收敛
  fast-uri(3.1.5)+hono(4.13.2)；残留 2 个 moderate 为 node-cron→uuid 8.3.2（v3/v5/v6 buffer
  路径，node-cron 实际只用 v4，不可利用；修复需 node-cron 4 大版本，暂缓）。全部验证：
  npm run build 零错误、npm test 196/196 全绿（基线 171 + 新增 25）。文档同步：
  README Node >= 22.13、architecture.md 投递恢复/简报键/补发语义。
  已提交本地 commit `b274d08`。
- 2026-08-13 计划定稿：P1×12 + P2×22 选做清单、文件分区、验证命令。开始主代理分区修复（notifier/scheduler/package/gitignore）。
