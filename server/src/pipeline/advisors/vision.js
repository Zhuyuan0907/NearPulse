/**
 * ============================================================================
 * Vision advisor —— 地下視覺錨點辨識（兩段式）
 * ============================================================================
 * 【地下沒有 GPS，但有站名牌和出口編號牌——那就是地下的地標系統】
 *
 * 兩個階段，各自只做一件模型真的做得到的事：
 *
 *   locate(整張圖)  → 哪一格（A1~C3）看得到站名或出口編號的牌子
 *                     這是純視覺問題：「牌子在畫面的哪個位置」
 *
 *   read(裁切的那格) → 讀出牌子上的字
 *                     這是純 OCR 問題，而且因為裁切過，字夠大所以讀得準
 *
 * **模型不猜座標。** 「這根柱子在場域平面的哪一格」是它不可能知道的事
 * （它沒有平面圖）。位置由 venueService 拿讀到的字去查表得出——確定性、可稽核。
 * 這讓「AI 不在生命安全資訊的關鍵路徑上」這條原則在視覺定位上依然成立。
 *
 * 供應商可插拔（PROVIDERS + config.vision.provider）：
 *   'openai'   → GPT-4o-mini Vision（detail: low）
 *   'gmi'      → GMI Cloud 閘道（實測 MiniMax-M3，2.8 秒，可互動式）
 *   'opencode' → opencode zen 免費層（實測 34.5 秒，只能 deferred）
 *   'none'     → 不呼叫外部服務，回 pending
 *   日後接地端 OCR：加一個 entry 即可，呼叫端完全不動。
 *
 * 顧問層鐵則：失敗、逾時、未設定、供應商不存在——**一律回同一個降級形狀**，
 * 呼叫端無從分辨，因此 AI 永遠不可能擋住回報。
 */

import { config } from '../../config.js';

const CELL_RE = /^[ABC][123]$/;
const ANOMALY_KEYS = ['smoke', 'crowd', 'flood', 'fire', 'injury', 'obstacle'];

/** 統一的降級結果——所有失敗路徑都回這個形狀 */
function degraded(extra = {}) {
  return { pending: true, roiCell: null, texts: [], anomalies: [], ...extra };
}

const PROMPTS = {
  /**
   * 階段一：找出「哪一格有可辨識地點的牌子」。
   * 這裡問的是畫面位置（上/中/下、左/中/右），不是場域位置——
   * 舊版 prompt 把兩者混在一句話裡（「推測照片在 3x3 分區中的位置」），
   * 導致回傳值被下游當成樓層座標使用。
   */
  locate:
    '你在看一張地下場域（捷運站、地下街）的照片。' +
    '把畫面切成 3x3 九宮格：列 A=上、B=中、C=下；行 1=左、2=中、3=右。' +
    '找出「最能辨識這裡是哪裡」的那一格——通常是站名牌、出口編號牌、' +
    '逃生方向燈箱或明顯店家招牌所在的位置。' +
    '以嚴格 JSON 回應（不要其他文字）：' +
    '{"roiCell":"A1"~"C3"或null,"anomalies":["smoke"|"crowd"|"flood"|"fire"|"injury"|"obstacle"]}。' +
    '畫面中沒有任何可辨識地點的文字或標示時，roiCell 填 null。' +
    'anomalies 只列你有把握的現場異常。',

  /**
   * 階段二：只讀字。不問位置、不做推論。
   */
  /**
   * ⚠️ label 不是裝飾，它決定了那串字**能不能當成出口代碼**。
   *
   * 月台上到處都是數字：車門上的「車廂3 / Car 3」、月台看板的「2月台」、
   * 月台門的三位數編號。使用者實測拍忠孝敦化月台，車廂編號 3 被當成
   * 「3 號出口」——那會把人指到站內完全不同的位置。
   *
   * 所以 label 明確列出 `車廂|月台` 這兩個**不是出口**的類別，
   * 並且要求數字連同前後文一起回（「車廂3」而不是「3」）。
   * 解析端另有一道防線：裸數字只有在被標成出口時才採用（見 resolveAnchors）。
   */
  read:
    '這是一張地下場域照片。只做一件事：讀出畫面中的文字。' +
    '以嚴格 JSON 回應（不要其他文字）：' +
    '{"texts":[{"label":"站名|出口|車廂|月台|燈箱|招牌","value":"讀到的字"}],' +
    '"anomalies":["smoke"|"crowd"|"flood"|"fire"|"injury"|"obstacle"]}。' +
    '重要：車廂編號（「車廂3」「Car 3」）與月台編號（「2月台」）**不是出口**，' +
    'label 必須標成「車廂」或「月台」，不可標成「出口」。' +
    '出口編號請保留原樣（「M3」「Y13」「出口 3」不要改寫），' +
    '數字請連同前後文一起回（回「車廂3」而不是「3」）。' +
    '看不清楚就不要猜，寧可回空陣列。',
};

function normalizeTexts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t.value === 'string' && t.value.trim())
    .slice(0, 6)
    .map((t) => ({
      label: String(t.label ?? '文字').slice(0, 8),
      value: String(t.value).trim().slice(0, 40),
    }));
}

function normalizeAnomalies(raw) {
  return Array.isArray(raw) ? raw.filter((a) => ANOMALY_KEYS.includes(a)) : [];
}

/**
 * 從回應文字裡挖出第一個 JSON 物件。
 * 免費層的 reasoning model 不一定遵守 response_format，常常在 JSON 前後
 * 夾雜說明文字——嚴格 JSON.parse 會整個失敗，但內容其實是可用的。
 */
function looseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { /* 繼續嘗試 */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { return {}; }
}

const PROVIDERS = {
  none: null,

  /**
   * opencode zen 的免費層。
   *
   * 實測（2026-09）：`big-pickle` 與 `mimo-v2.5-free` 支援影像且真的讀得出
   * 中文站名，但延遲約 34 秒、且免費層速率限制很緊。因此只能配 deferred 模式，
   * 互動式會讓使用者盯著轉圈半分鐘。
   *
   * 認證用 x-api-key（不是 Bearer——這點與多數 OpenAI 相容閘道不同）。
   */
  async opencode({ base64, mimeType, stage, signal }) {
    const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.OPENCODE_API_KEY ?? '',
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: config.vision.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPTS[stage] },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          },
        ],
        // reasoning model 會先花掉大量 token 思考；給太少的話 content 會是空的
        max_tokens: 3000,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`opencode ${res.status}`);
    const data = await res.json();
    return looseJson(data.choices?.[0]?.message?.content);
  },

  /**
   * GMI Cloud（OpenAI 相容閘道）。
   *
   * 實測（2026-09，MiniMaxAI/MiniMax-M3）：整張 1024×768 的站廳照
   * **2.8 秒**回覆，中文站名、出口編號、路口名稱全部讀對。
   * 這個延遲足以走 interactive——使用者拍完照當場就拿得到錨點候選，
   * 不需要像 opencode（34.5 秒）那樣退到 deferred。
   *
   * 認證是標準 Bearer。刻意**不送 response_format**：
   * 這類閘道對 json_object 的支援不一致，強制送反而可能整個請求被拒；
   * 而 looseJson() 本來就能從散文裡撈出 JSON 區塊，容錯成本比較低。
   */
  async gmi({ base64, mimeType, stage, signal }) {
    const res = await fetch('https://api.gmi-serving.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GMI_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: config.vision.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPTS[stage] },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                  detail: config.vision.detail,
                },
              },
            ],
          },
        ],
        max_tokens: 600,
        temperature: 0,
      }),
    });
    if (!res.ok) throw new Error(`gmi ${res.status}`);
    const data = await res.json();
    return looseJson(data.choices?.[0]?.message?.content);
  },

  async openai({ base64, mimeType, stage, signal }) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        model: config.vision.model,
        messages: [
          { role: 'system', content: PROMPTS[stage] },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                  detail: config.vision.detail,
                },
              },
            ],
          },
        ],
        max_tokens: 300,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) throw new Error(`vision api ${res.status}`);
    const data = await res.json();
    return JSON.parse(data.choices[0]?.message?.content ?? '{}');
  },
};

/** 目前生效的供應商——缺對應金鑰時自動失效，落回 none（降級形狀一致） */
function resolveProvider() {
  const name = config.vision.provider;
  if (name === 'openai' && !process.env.OPENAI_API_KEY) return null;
  if (name === 'opencode' && !process.env.OPENCODE_API_KEY) return null;
  if (name === 'gmi' && !process.env.GMI_API_KEY) return null;
  return PROVIDERS[name] ?? null;
}

export function isVisionEnabled() {
  return resolveProvider() !== null;
}

/**
 * 互動還是延後？由供應商的實測延遲決定。
 * 延後模式下，回報端不等辨識結果，錨點由批次端稍後補上。
 */
export function visionMode() {
  if (!isVisionEnabled()) return 'off';
  if (config.vision.mode) return config.vision.mode;
  return config.vision.provider === 'opencode' ? 'deferred' : 'interactive';
}

/**
 * 執行一個階段的視覺分析。
 * @param {object} input
 * @param {string} input.base64
 * @param {string} [input.mimeType]
 * @param {'locate'|'read'} [input.stage] - 預設 'locate'
 * @returns {Promise<{pending, roiCell, texts, anomalies}>}
 */
export async function analyzePhoto({
  base64, mimeType = 'image/webp', stage = 'locate', deferred = false,
} = {}) {
  const provider = resolveProvider();
  if (!provider || !base64 || !PROMPTS[stage]) {
    return degraded({ receivedBytes: base64?.length ?? 0 });
  }

  const controller = new AbortController();
  // 延後模式沒有人在等，逾時可以放寬（免費層的 reasoning model 要 30 秒以上）
  const budget = deferred ? config.vision.deferredTimeoutMs : config.vision.timeoutMs;
  const timer = setTimeout(() => controller.abort(), budget);

  try {
    const parsed = await provider({ base64, mimeType, stage, signal: controller.signal });
    return {
      pending: false,
      // 只有 locate 階段會回 ROI；read 階段回了也忽略（它看的是裁切圖，格位無意義）
      roiCell: stage === 'locate' && CELL_RE.test(parsed?.roiCell ?? '') ? parsed.roiCell : null,
      texts: normalizeTexts(parsed?.texts),
      anomalies: normalizeAnomalies(parsed?.anomalies),
    };
  } catch {
    // API 失敗 / 逾時 / 回傳非 JSON → 與「未設定」完全相同的降級形狀
    return degraded();
  } finally {
    clearTimeout(timer);
  }
}
