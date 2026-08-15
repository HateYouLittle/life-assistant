/**
 * 模块清单 —— 扩展点：
 * 新增功能模块 = 在 modules/ 下新建目录实现 AssistantModule，
 * 然后在这里 import 一行（模块内部自注册）。核心代码零改动。
 */
import "../core/location.js";   // 内建：位置服务
import "./weather/index.js";
import "./oilprice/index.js";
import "./schedule/index.js";
import "./holiday/index.js";   // 中国大陆法定节假日/工作日：共享历法数据 + 自动抓取
// import "./express/index.js";  // 2026-08-01 封存：用户弃用快递追踪（电商自推送），省 TianAPI 额度；恢复时取消注释

// import "./airquality/index.js";   // v0.3 示例：空气质量
// import "./reminder/index.js";     // v0.3 示例：纪念日提醒

export { getModules } from "../core/registry.js";
