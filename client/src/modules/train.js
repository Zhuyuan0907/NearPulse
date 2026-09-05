/**
 * ============================================================================
 * train.js —— 到站倒數（client 端計算）
 * ============================================================================
 * server 的態勢卡只給**絕對到站時刻** `arriveAt`，不給剩餘秒數。
 * 原因見 server 的 trainService：剩餘秒數每秒都不同，寫進卡片會讓每次
 * 輪詢的 ETag 都不一樣，弱網下最寶貴的 304 就全沒了。
 *
 * 代價是倒數要在這裡算——但這反而更好：畫面能每秒更新，而不是跟著
 * 12 秒的輪詢週期一跳一跳。
 *
 * 【刻意的粗略】
 * 秒數來自 TDX 的官方站間行車時間，但那是**平均值**：誤點、月台擁擠、
 * 緊急停車都不在資料裡。所以顯示一律取整到 10 秒或半分鐘——
 * 講「還有 47 秒」會給出資料支撐不了的精確感。
 */

const clock = () => Date.now();

/**
 * @param {number} arriveAt - 預計到站時刻（ms epoch）
 * @returns {{etaSec: number, arrived: boolean, text: string, action: string}}
 */
export function etaOf(arriveAt, now = clock()) {
  const etaSec = Math.round((arriveAt - now) / 1000);
  const arrived = etaSec <= 0;

  return {
    etaSec: Math.max(0, etaSec),
    arrived,
    text: arrived
      ? '應已進站'
      : etaSec <= 15
        ? '即將進站'
        : etaSec < 60
          ? `約 ${Math.round(etaSec / 10) * 10} 秒後進站`
          : `約 ${Math.round(etaSec / 30) * 0.5} 分鐘後進站`,
    /**
     * 月台上的人現在該做的事。一句話，動詞在最前面——
     * 恐慌中的人只接收到前幾個字。
     */
    action: arrived
      ? '退離車門，讓車上的人先出，不要上車。'
      : '退離月台門前，空出車門動線，不要上車。',
  };
}
