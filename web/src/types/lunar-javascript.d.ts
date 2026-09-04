declare module "lunar-javascript" {
  export interface Lunar {
    getYearInGanZhi(): string;
    getMonthInChinese(): string;
    getDayInChinese(): string;
    getYearShengXiao(): string;
    getPrevJieQi(): { getName(): string };
    getNextJieQi(): { getName(): string };
  }

  export interface Solar {
    getLunar(): Lunar;
    toYmd(): string;
  }

  export const Solar: {
    fromDate(date: Date): Solar;
    fromYmd(year: number, month: number, day: number): Solar;
  };
}
