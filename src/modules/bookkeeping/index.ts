import { z } from "zod";
import { config } from "../../config.js";
import { registerModule, ok, withTool, type AssistantModule } from "../../core/registry.js";
import { requireProfileContext } from "../../core/profile.js";
import "./notification.js"; // 注册 bookkeeping.* 渲染器（MCP/pull 路径也需要）
import {
  addEntry,
  addLedgerMember,
  createAccount,
  createSharedLedger,
  deleteAccount,
  deleteEntry,
  ensurePersonalLedger,
  getEntry,
  listAccounts,
  listEntries,
  listLedgers,
  removeLedgerMember,
  runMonthlyReports,
  summarizeLedger,
  updateAccount,
  updateEntry,
} from "./service.js";
import { accountTypeSchema, amountYuanSchema, entryTypeSchema, monthSchema } from "./types.js";

const bookkeepingModule: AssistantModule = {
  name: "bookkeeping",
  tools: [
    withTool(
      {
        name: "ledger_list",
        description:
          "列出当前 Hermes Profile 的个人账本与已加入的全部共享账本（含本人在其中的角色、成员数、账户数与余额概要，金额单位为分）。首次调用任何记账工具时会自动创建个人账本。",
      },
      {},
      (args, context) => ok({ ledgers: listLedgers(context ?? requireProfileContext()) }),
    ),
    withTool(
      {
        name: "ledger_create",
        description:
          "创建共享账本（如家庭、情侣共用），创建者自动成为 owner 并写入成员列表。随后可用 member_add 邀请其他 Profile 成员，用 account_create(ledgerId) 在账本下创建余额全员共享的公共账户。",
      },
      { name: z.string().min(1).max(100).describe("共享账本名称，如 家庭账本") },
      (args, context) => ok(createSharedLedger(context ?? requireProfileContext(), args.name)),
    ),
    withTool(
      {
        name: "member_add",
        description:
          "向共享账本添加成员（仅账本 owner）。profileId 是对方的 Hermes Profile ID（仅要求格式合法，对方无需提前存在）。添加后对方立即可见账本、共享账户余额并可记账。",
      },
      {
        ledgerId: z.string().describe("共享账本 ID（ledger_list 获取）"),
        profileId: z.string().describe("被邀请成员的 Profile ID"),
      },
      (args, context) => ok(addLedgerMember(context ?? requireProfileContext(), args.ledgerId, args.profileId)),
    ),
    withTool(
      {
        name: "member_remove",
        description:
          "从共享账本移除成员（仅账本 owner；不能移除 owner 本人）。被移除成员立即失去该账本及共享账户的可见与读写权限，但其历史流水保留。",
      },
      {
        ledgerId: z.string().describe("共享账本 ID"),
        profileId: z.string().describe("要移除的成员 Profile ID"),
      },
      (args, context) => {
        removeLedgerMember(context ?? requireProfileContext(), args.ledgerId, args.profileId);
        return ok({ removed: true, ledgerId: args.ledgerId, profileId: args.profileId });
      },
    ),
    withTool(
      {
        name: "account_create",
        description:
          "创建账户。不带 ledgerId：创建当前 Profile 的个人账户（仅本人可见）。带 ledgerId：在该共享账本下创建共享账户（仅账本 owner 可创建，余额由全部成员共享可见）。initialBalance（元，>0，最多两位小数）为初始余额，会自动补一条「期初余额」收入流水，其他共享账本成员会收到该期初流水的通知。type 可选：cash/bank/alipay/wechat/other。",
      },
      {
        name: z.string().min(1).max(100).describe("账户名称，如 微信钱包、家庭公共资金池"),
        type: accountTypeSchema.optional().describe("账户类型，缺省 other"),
        ledgerId: z.string().optional().describe("提供时创建该共享账本下的共享账户（需 owner）"),
        initialBalance: amountYuanSchema.optional().describe("初始余额（元，>0）"),
      },
      (args, context) => ok(createAccount(context ?? requireProfileContext(), args)),
    ),
    withTool(
      {
        name: "account_list",
        description:
          "列出可用账户及实时余额（余额由全部流水派生，单位为分）：缺省返回本人个人账户 + 所在共享账本的共享账户；传 ledgerId 只看该账本。含已归档账户（archived: true）。",
      },
      { ledgerId: z.string().optional().describe("只列出该账本的账户") },
      (args, context) => ok({ accounts: listAccounts(context ?? requireProfileContext(), args.ledgerId) }),
    ),
    withTool(
      {
        name: "account_update",
        description:
          "修改账户的名称/类型/归档状态。个人账户仅本人，共享账户仅账本 owner。归档（archived: true）用于不再使用但仍有历史流水的账户。",
      },
      {
        accountId: z.string().describe("账户 ID"),
        version: z.number().int().min(1).optional().describe("可选乐观锁版本；提供时必须为当前 version"),
        name: z.string().min(1).max(100).optional().describe("新名称"),
        type: accountTypeSchema.optional(),
        archived: z.boolean().optional().describe("true 归档，false 恢复"),
      },
      (args, context) => {
        const { accountId, ...changes } = args;
        return ok(updateAccount(context ?? requireProfileContext(), accountId, changes));
      },
    ),
    withTool(
      {
        name: "account_delete",
        description:
          "删除账户。仍被任何流水引用时会拒绝并提示改用 account_update(archived: true) 归档，以保留余额与历史；无流水的账户可直接删除。",
      },
      { accountId: z.string().describe("账户 ID") },
      (args, context) => {
        deleteAccount(context ?? requireProfileContext(), args.accountId);
        return ok({ deleted: true, id: args.accountId });
      },
    ),
    withTool(
      {
        name: "entry_add",
        description:
          "记一笔账。type=expense/income：category 必填（如 餐饮/交通/工资），accountId 可选（资金账户；缺省不计入具体账户）；type=transfer（账户间转账）：category 必须省略，accountId（转出）与 toAccountId（转入）必填且不能相同。amount 单位是元、>0、最多两位小数。occurredAt 缺省当前时间，可传 ISO 时间补记。流水归属：用共享账户（或转账涉及共享账户）时记入共享账本并通知其他成员，否则记入本人个人账本。",
      },
      {
        type: entryTypeSchema.describe("expense 支出 / income 收入 / transfer 转账"),
        amount: amountYuanSchema.describe("金额（元，>0，最多两位小数）"),
        category: z.string().min(1).max(50).optional().describe("分类；expense/income 必填，transfer 禁止"),
        accountId: z.string().optional().describe("支出/收入的账户；transfer 的转出账户"),
        toAccountId: z.string().optional().describe("仅 transfer：转入账户，必须 ≠ accountId"),
        occurredAt: z.string().optional().describe("ISO 时间（如 2026-08-10T08:00:00Z 或含时区），缺省现在"),
        note: z.string().max(500).optional().describe("备注"),
      },
      (args, context) => ok(addEntry(context ?? requireProfileContext(), args)),
    ),
    withTool(
      {
        name: "entry_list",
        description:
          "查询账本流水，按发生时间倒序分页（金额单位为分）。ledgerId 缺省查本人个人账本，传共享账本 ID 查该账本（需为成员）。可按类型、分类、时间范围过滤。",
      },
      {
        ledgerId: z.string().optional().describe("账本 ID，缺省个人账本"),
        type: entryTypeSchema.optional(),
        category: z.string().optional().describe("按分类精确匹配"),
        from: z.string().optional().describe("起始 ISO 时间（含）"),
        to: z.string().optional().describe("结束 ISO 时间（含）"),
        limit: z.number().int().min(1).max(500).optional().describe("返回条数，缺省 50"),
        offset: z.number().int().min(0).optional().describe("分页偏移，缺省 0"),
      },
      (args, context) => {
        const { ledgerId, ...options } = args;
        return ok({ entries: listEntries(context ?? requireProfileContext(), ledgerId, options) });
      },
    ),
    withTool(
      {
        name: "entry_get",
        description: "查看账本中一条流水的完整信息（需为该账本成员）。",
      },
      {
        ledgerId: z.string().describe("账本 ID"),
        entryId: z.string().describe("流水 ID"),
      },
      (args, context) => ok(getEntry(context ?? requireProfileContext(), args.ledgerId, args.entryId)),
    ),
    withTool(
      {
        name: "entry_update",
        description:
          "修改流水（记录人本人，或共享账本 owner 可修改任何人的；共享账本流水跨账本移出需 owner 权限）。version 是乐观锁：必须传该流水当前的 version；冲突时报错，请重新 entry_get 获取最新值再重试。类型（expense/income/transfer）不可变；amount 单位是元；transfer 的 toAccountId 可改，expense/income 不接受 toAccountId；category 传空字符串可清除分类，note 传空字符串清除备注。修改共享账本流水会通知其他成员（通知带账户/账本变更留痕）。",
      },
      {
        ledgerId: z.string().describe("账本 ID"),
        entryId: z.string().describe("流水 ID"),
        version: z.number().int().min(1).describe("乐观锁：流水当前 version"),
        amount: amountYuanSchema.optional().describe("新金额（元）"),
        category: z.string().max(50).optional().describe("新分类；传空字符串可清除分类"),
        accountId: z.string().optional().describe("改用其他账户"),
        toAccountId: z.string().optional().describe("仅 transfer：新转入账户"),
        occurredAt: z.string().optional().describe("新发生时间（ISO）"),
        note: z.string().max(500).optional().describe("新备注"),
      },
      (args, context) => {
        const { ledgerId, entryId, version, ...changes } = args;
        return ok(updateEntry(context ?? requireProfileContext(), ledgerId, entryId, { ...changes, version }));
      },
    ),
    withTool(
      {
        name: "entry_delete",
        description:
          "删除流水（权限同 entry_update：记录人本人，或共享账本 owner）。version 是乐观锁，必须传当前 version。删除共享账本流水会通知其他成员。",
      },
      {
        ledgerId: z.string().describe("账本 ID"),
        entryId: z.string().describe("流水 ID"),
        version: z.number().int().min(1).describe("乐观锁：流水当前 version"),
      },
      async (args, context) => {
        const deleted = await deleteEntry(context ?? requireProfileContext(), args.ledgerId, args.entryId, args.version);
        return ok({ deleted: true, entry: deleted });
      },
    ),
    withTool(
      {
        name: "summary",
        description:
          "账本月度汇总：收入/支出/结余、分类聚合与账户实时余额清单（金额已换算为元）。ledgerId 缺省本人个人账本；month 格式 yyyy-LL（按 LIFE_ASSISTANT_TIMEZONE 配置时区切自然月），缺省当月。",
      },
      {
        ledgerId: z.string().optional().describe("账本 ID，缺省个人账本"),
        month: monthSchema.optional().describe("汇总月份 yyyy-LL，缺省当月"),
      },
      (args, context) => {
        const view = summarizeLedger(context ?? requireProfileContext(), args.ledgerId, args.month);
        const yuan = (cents: number): number => Math.round(cents) / 100;
        return ok({
          ledgerId: view.ledgerId,
          ledgerName: view.ledgerName,
          month: view.month,
          income: yuan(view.incomeCents),
          expense: yuan(view.expenseCents),
          net: yuan(view.netCents),
          entryCount: view.entryCount,
          expenseByCategory: view.expenseByCategory.map((item) => ({ category: item.category, amount: yuan(item.amountCents) })),
          incomeByCategory: view.incomeByCategory.map((item) => ({ category: item.category, amount: yuan(item.amountCents) })),
          accounts: view.accounts.map((account) => ({
            id: account.id,
            name: account.name,
            type: account.type,
            kind: account.kind,
            archived: account.archived,
            balance: yuan(account.balanceCents),
          })),
        });
      },
    ),
  ],
  jobs: [
    {
      // 每月 1 号推送上月收支汇总（个人 + 各共享账本）；无数据的 Profile 静默跳过。
      name: "monthly_report",
      cron: config.cron.bookkeepingReport,
      timezone: config.timezone,
      handler: async () => {
        const published = await runMonthlyReports();
        if (published.length > 0) {
          console.log(`[bookkeeping] monthly report published to ${published.length} profile(s)`);
        }
      },
    },
  ],
};

registerModule(bookkeepingModule);
