/**
 * lunar-javascript 的最小类型面：只声明 src 实际用到的成员
 * （schedule/service.ts 的农历换算路径），避免全 any 绕过类型检查；
 * 其余 API 用到时再按真实返回形状补充声明。
 */
declare module "lunar-javascript" {
  export interface LunarSolar {
    /** 公历日期，格式 yyyy-MM-dd */
    toYmd(): string;
  }

  export interface LunarInstance {
    getSolar(): LunarSolar;
  }

  export interface LunarYearInstance {
    /** 返回该农历年的闰月月份（1-12）；无闰月时返回 0 */
    getLeapMonth(): number;
  }

  export const Lunar: {
    /** month 传负数表示闰月（如 -6 = 闰六月），与库的运行时约定一致 */
    fromYmd(year: number, month: number, day: number): LunarInstance;
  };
  export const LunarYear: {
    fromYear(year: number): LunarYearInstance;
  };
}
