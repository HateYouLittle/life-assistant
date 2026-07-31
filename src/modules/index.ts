/**
 * 模块清单 —— 扩展点：
 * 新增功能模块 = 在 modules/ 下新建目录实现 AssistantModule，
 * 然后在这里 import 一行（模块内部自注册）。核心代码零改动。
 */
import "../core/location.js";   // 内建：位置服务
import "./weather/index.js";
import "./oilprice/index.js";
import "./express/index.js";

// import "./airquality/index.js";   // v0.3 示例：空气质量
// import "./reminder/index.js";     // v0.3 示例：纪念日提醒

export { getModules } from "../core/registry.js";
