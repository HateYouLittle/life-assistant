/**
 * 模块清单 —— 扩展点：
 * 新增功能模块 = 在 modules/ 下新建目录实现 AssistantModule，
 * 然后在这里 import 一行（模块内部自注册）。核心代码零改动。
 */
import "./location/index.js";   // 内建：位置服务（含 resolveLocation 公共能力）
import "./weather/index.js";
import "./airquality/index.js"; // 空气质量：和风国标 AQI 优先，Open-Meteo 美标兜底
import "./oilprice/index.js";
import "./schedule/index.js";
import "./holiday/index.js";   // 中国大陆法定节假日/工作日：共享历法数据 + 自动抓取
import "./automation/index.js"; // 动态自动任务：白名单 action + 条件 DSL，scheduler 无 LLM 执行
import "./bookkeeping/index.js"; // 记账：个人/共享账本、账户/流水/转账、月度账单；共享账本是首个跨 Profile 可写资源
import "./assistant/index.js";  // 备份迁移：Profile 数据快照导出/导入
// import "./express/index.js";  // 2026-08-01 封存：用户弃用快递追踪（电商自推送），省 TianAPI 额度；恢复时取消注释

// import "./reminder/index.js";  // v0.3 示例：纪念日提醒

export { getModules } from "../core/registry.js";
