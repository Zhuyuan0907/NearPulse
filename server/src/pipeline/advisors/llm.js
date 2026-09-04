/**
 * ============================================================================
 * LLM advisor（敘事摘要）—— stub 實作
 * ============================================================================
 * 架構重點：v0.1 的「避難建議」完全由確定性模板產生（見 llmNarrate 內的
 * ADVICE_TEMPLATES），不需要任何 AI 就能生成完整態勢卡——
 * 這正是「AI 掛掉時卡片仍顯示原始數據」降級路徑的實作。
 *
 * llmNarrate() 是未來升級點：接 GPT-4o-mini 產出時間線敘事，
 * 失敗時 fallback 回模板文字。
 */

import { config } from '../../config.js';

/** 確定性避難建議模板：依 (type, status) 查表，零 AI、零延遲、零成本 */
const ADVICE_TEMPLATES = {
  fire: {
    active: '遠離月台，依站務人員指示往反方向出口疏散，勿使用電梯。',
    candidate: '未經確認：附近有人回報火警。若您在現場，請協助確認。',
  },
  medical: {
    active: '讓出通道，通知站務人員；受過急救訓練者請前往協助。',
    candidate: '未經確認：附近有人回報需要急救。若您在現場，請協助確認。',
  },
  crush: {
    active: '靠邊扶穩、避免推擠，留意孩童與長者。',
    candidate: '未經確認：附近有人回報推擠狀況。若您在現場，請協助確認。',
  },
  other: {
    active: '留意現場狀況，依站務廣播指示行動。',
    candidate: '未經確認：附近有人回報異常狀況。若您在現場，請協助確認。',
  },
};

/**
 * 取得某事件的避難建議文字（確定性，同步，永不失敗）。
 */
export function getAdvice(type, status) {
  const byType = ADVICE_TEMPLATES[type] ?? ADVICE_TEMPLATES.other;
  if (status === 'active') return byType.active;
  return byType.candidate;
}

/**
 * LLM 敘事（stub）：未來接 GPT-4o-mini 產出「事件時間線摘要」。
 * v0.1 回傳結構化時間線的字串形式，呼叫端把它放進事件的 timeline 欄位。
 *
 * @param {object} event - 完整事件（含 reports / confirmations）
 * @returns {Promise<{summary: string, pending: boolean}>}
 */
export async function llmNarrate(event) {
  // TODO: 接 GPT-4o-mini——把 reports + confirmations 餵給 LLM，
  //   產出 1-2 句時間線敘事；失敗時 fallback：直接回傳結構化字串。
  const firstReport = event.reports[0];
  const summary =
    `${event.stationName}（${event.stationId}）於 ` +
    `${new Date(firstReport?.receivedAt ?? event.createdAt).toLocaleTimeString('zh-TW')} ` +
    `收到首筆【${config.eventTypes[event.type]?.label ?? event.type}】回報` +
    `，目前已累積 ${event.reports.length} 筆回報、` +
    `${event.confirmations.length} 筆確認回覆。`;

  return { summary, pending: true };
}
