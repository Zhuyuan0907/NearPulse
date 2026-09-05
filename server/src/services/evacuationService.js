/**
 * ============================================================================
 * evacuationService —— 疏散建議（確定性、且只講知道的事）
 * ============================================================================
 * 【這個模組最重要的一條紀律：不要輸出我們其實不知道的數字】
 *
 * 我們手上唯一的幾何資料，是 OSM 上每個出入口的**地面**經緯度。
 * 用它算出來的「M3 到 M7 距離 91 公尺」有四個問題：
 *
 *   1. 量的是地面，不是地下——地下要走通道、穿大廳、上下樓梯，路徑完全不同
 *   2. 量的不是使用者所在的樓層——垂直移動與走到樓梯的距離都沒算進去
 *   3. 起點本身就不精確——「近 M3 出口」用的是地面出入口座標，
 *      但事件在地下，可能離那個樓梯口 30~50m
 *   4. 地下不能走直線——牆、月台邊緣、閘門、單向電扶梯
 *
 * 在生命安全情境下顯示一個看似精確的錯誤數字，比不顯示更糟。
 * 所以座標在這裡只做**兩件它做得好的事**：排序、以及畫地圖。
 * 對使用者輸出的是「出口編號 + 通往哪裡」——
 * **因為站內的指標系統本來就是用出口編號在導引的**。牆上寫的是「← M7 出口」，
 * 不是「往東 91 公尺」。給出跟現場指標對得上的資訊，才是可行動的。
 *
 * 真正可信的數字只有一種來源：實測步行時間（見 traversalService，
 * 由使用者的錨點配對累積而來）。有實測值時才顯示，並明確標示「實測」。
 *
 * 其餘紀律不變：
 *   - 純函式、零 AI、零延遲，與 llm.js 的 ADVICE_TEMPLATES 同一層級
 *   - 由 batch worker 預先算好寫進態勢卡（client 盡量少事）
 *   - 資訊不足時說「依現場人員指示」，不硬給方向
 */

import { findVenue, findExit, distanceM } from './venueService.js';
import { isAheadOfThreat, motionLine } from './threatMotion.js';

/**
 * 以下兩個半徑是**內部排序用的啟發式**，不對外顯示。
 * 直線距離拿來做「排序」與「粗略分組」是穩健的（差一個數量級的東西排得出來），
 * 拿來當「你要走幾公尺」則不成立——這正是它們不出現在輸出文字裡的原因。
 */
const AVOID_RADIUS_M = 60;   // 這麼近的出口視為可能與事件在同一區
const PREFER_MIN_DIST_M = 80; // 建議的出口至少要離這麼遠才算「另一個區域」

/**
 * 計算疏散選項。
 * @param {string} venueId
 * @param {string|null} nearExitCode - 事件所在（或最接近）的出口代碼
 * @param {{lat, lon}|null} point - 使用者在地圖上點的事件位置（比出口更精確時）
 * @returns {{away: Array, avoid: Array}|null} 資料不足時回 null
 */
export function suggestExits(venueId, nearExitCode, point = null, motion = null, mobility = null) {
  const venue = findVenue(venueId);
  if (!venue?.exits?.length) return null;

  // 事件原點的優先序：地圖選點（最精確）→ 辨識到的出口 → 場域中心
  const origin =
    (Number.isFinite(point?.lat) && Number.isFinite(point?.lon) ? point : null) ??
    findExit(venue.id, nearExitCode) ??
    { lat: venue.lat, lon: venue.lon };

  const usable = venue.exits.filter((e) => e.code !== nearExitCode); // 事件所在的出口不列為去處

  const scored = usable
    .map((e) => ({ exit: e, dist: Math.round(distanceM(origin, e)) }))
    .sort((a, b) => a.dist - b.dist); // 由近而遠

  if (scored.length === 0) return null;

  // 先過門檻（另一個區域），再取其中最近的幾個——「離事件夠遠、但走得到」。
  // 台北車站複合體長達 700m，叫人往最遠的出口跑是壞建議：門檻不是最佳化目標。
  const safe = scored.filter((s) => s.dist >= PREFER_MIN_DIST_M);
  const away = safe.length > 0 ? safe : [scored[scored.length - 1]];

  const nearby = scored.filter((s) => s.dist <= AVOID_RADIUS_M);
  return {
    away: away.slice(0, 3),
    // 若每個出口都落在避開半徑內，這份清單就沒有篩選作用——寧可不說
    avoid: nearby.length === scored.length ? [] : nearby.slice(0, 3),
    /**
     * 全部候選（依距離排序）。無障礙篩選必須從這裡開始，不能用上面的 away——
     * 可通行的出口本來就稀少，先被距離砍掉三個名額就等於找不到。
     */
    all: scored,
  };
}

/**
 * 威脅移動時重新篩選出口。
 *
 * 靜態事件只要「離事件夠遠」；移動威脅還要「不在它前進的路徑上」。
 * 這是兩者最關鍵的差別——一個往北移動的威脅，北邊的出口即使距離很遠，
 * 也可能在你抵達前就被它追上。**把人往威脅前進的方向趕，比不給建議更糟。**
 */
function applyMotion(venue, s, motion, nearExitCode) {
  if (!motion?.moving || motion.bearing === undefined) return s;

  const ahead = [];
  const behind = [];
  for (const item of s.away) {
    (isAheadOfThreat(motion, item.exit) ? ahead : behind).push(item);
  }

  // 全部候選都在威脅前方 → 退回距離最遠的那些，並把「都在前方」如實講出來
  const away = behind.length > 0 ? behind : s.away;

  // 前方的出口一律進避開清單（含原本因為太近而入列的）
  const avoidCodes = new Set(s.avoid.map((x) => x.exit.code));
  const avoid = [...s.avoid];
  for (const item of ahead) {
    if (!avoidCodes.has(item.exit.code)) { avoid.push(item); avoidCodes.add(item.exit.code); }
  }

  // 保留 s 的其餘欄位（特別是 all）——無障礙篩選需要完整候選清單
  return { ...s, away, avoid: avoid.slice(0, 4), allAhead: behind.length === 0 && ahead.length > 0 };
}

// ---------------------------------------------------------------------------
// 無障礙疏散
// ---------------------------------------------------------------------------

/**
 * 篩出「行動不便者真的走得出去」的出口。
 *
 * 【為什麼這不是把清單過濾一下就好】
 * 火災時電梯不可使用——這是消防常識，本專案的避難模板本來就寫著「勿使用電梯」。
 * 但捷運站裡**大多數的無障礙出口就是電梯**。兩件事合起來的結論很殘酷：
 *
 *   火警 + 輪椅使用者 → 多數「無障礙出口」在此刻並不存在
 *
 * 國際上的官方準則對這個處境的建議是**前往避難空間待援**，而不是前往出口。
 * 所以這裡在找不到可用出口時，不會退而求其次給一個有台階的出口
 * （那對輪椅使用者等於沒有建議），而是切換成「待援」這個**不同性質的答案**，
 * 並提示對外求援——這才是正確的回答。
 *
 * 【安全預設】
 * `stepFree === null`（OSM 沒有標註）一律**不當成可通行**。
 * 把「不知道」講成「可以」，對必須依賴這個資訊的人是會害死人的。
 */
function filterStepFree(scored, { fire }) {
  const usable = [];
  const liftOnly = [];
  let unknown = 0;

  for (const item of scored) {
    const e = item.exit;
    if (e.stepFree === null || e.stepFree === undefined) { unknown++; continue; }
    if (e.stepFree === 'no') continue;
    // 火災時電梯不可用 → 依賴電梯達成的無障礙在此刻無效
    if (fire && e.hasLift) { liftOnly.push(item); continue; }
    usable.push(item);
  }
  return { usable, liftOnly, unknown };
}

/**
 * 出口的可讀標示。
 * 地標（OSM 的 exit_to / 名稱括號內文字）是**方向資訊**，不是距離——
 * 「M7 出口（市民大道）」告訴你往哪走，而且跟站內指標寫的是同一件事。
 */
function label(exit) {
  return exit.landmark ? `${exit.code} 出口（往${exit.landmark}）` : `${exit.code} 出口`;
}

/**
 * 產生**結構化**的疏散計畫。
 *
 * 為什麼不是回一句話：一整段散文塞進「警示 + 起點 + 去處 + 地標 + 避開 +
 * 程序說明」之後，在恐慌情境下根本讀不完。眼睛需要的是**可掃視的結構**，
 * 耳朵才需要完整句子。所以這裡回結構，散文交給 evacuationLine 從結構生成。
 *
 * @returns {object|null} 無出口圖資時回 null，由呼叫端退回通用建議
 */
export function evacuationPlan({
  venueId, nearExitCode = null, point = null, motion = null,
  incidentType = null, mobility = null, onTrain = false,
} = {}) {
  // ---- 在列車上：沒有「出口」可去，這是完全不同的答案 ----
  // 2014 年鄭捷案就發生在行進中的車廂裡，龍山寺→江子翠這段距離較長，
  // 乘客在密閉空間中 4 分鐘無處可逃。對他們講「往 3 號出口」毫無意義。
  if (onTrain) {
    return {
      kind: 'onTrain', stepFree: mobility === 'stepFree', from: null, go: [], avoid: [],
      unknownExits: 0,
      reason: '事件發生在列車上',
      action: incidentType === 'attack'
        ? '往其他車廂移動並遠離加害者，按下車廂內的緊急對講機通報司機員。列車進站前不要嘗試開門；到站後立刻下車並遠離月台。'
        : '往其他車廂移動，按下車廂內的緊急對講機通報司機員。行進中不要嘗試開門或跳車，到站後立刻下車。',
    };
  }

  const base = suggestExits(venueId, nearExitCode, point, motion);
  if (!base) return null;
  const venue = findVenue(venueId);
  const s = applyMotion(venue, base, motion, nearExitCode);
  const stepFree = mobility === 'stepFree';

  const brief = (x) => ({ code: x.exit.code, landmark: x.exit.landmark ?? null });

  // ---- 無障礙路線是**性質不同的答案**，先處理 ----
  if (stepFree) {
    const known = venue?.accessibility?.known ?? 0;
    if (known === 0) {
      return {
        kind: 'shelter', stepFree: true, from: nearExitCode,
        reason: '這個場域沒有出口的無障礙資訊',
        action: '請立即向站務人員求助，並讓周圍的人知道你需要協助',
        go: [], avoid: [], unknownExits: venue?.exits?.length ?? 0,
      };
    }

    const fire = incidentType === 'fire';
    const { usable, liftOnly, unknown } = filterStepFree(s.all ?? s.away ?? [], { fire });
    // 篩選順序刻意與一般路徑相反：先過無障礙，再套安全距離與威脅方向。
    // 可通行的出口本來就稀少，若先用距離砍到剩三個，往往一個都不剩。
    const notAhead = usable.filter((x) => !isAheadOfThreat(motion, x.exit));
    const safe = notAhead.filter((x) => x.dist >= PREFER_MIN_DIST_M);
    const picked = (safe.length > 0 ? safe : notAhead).slice(0, 3);

    if (picked.length > 0) {
      return {
        kind: 'exits', stepFree: true, from: nearExitCode,
        go: picked.map(brief), avoid: [], unknownExits: unknown,
        note: '請依站內出口指標前進',
      };
    }

    return {
      kind: 'shelter', stepFree: true, from: nearExitCode,
      reason: fire && liftOnly.length > 0
        ? `唯一的無障礙出口（${liftOnly.map((x) => x.exit.code).join('、')} 出口）需要電梯，火災時電梯不可使用`
        : usable.length > 0
          ? '僅有的無障礙出口位於威脅前進的方向上'
          : '此處沒有無台階可通行的出口',
      action: '請前往站內避難空間或月台端點的安全區域待援，並讓周圍的人與站務人員知道你的位置。不要嘗試使用樓梯或電梯',
      go: [], avoid: [], unknownExits: unknown,
    };
  }

  // ---- 一般路線 ----
  if (s.allAhead) {
    return {
      kind: 'shelter', stepFree: false, from: nearExitCode,
      reason: '可用出口都位於威脅前進的方向上',
      action: '請優先尋找站內避難空間或聽從現場人員指示，不要盲目往出口移動',
      go: [], avoid: s.avoid.map(brief), unknownExits: 0,
    };
  }

  return {
    kind: 'exits', stepFree: false, from: nearExitCode,
    go: s.away.map(brief), avoid: s.avoid.map(brief), unknownExits: 0,
    note: '請依站內出口指標前進',
  };
}

/**
 * 把結構化計畫轉成一句話。
 *
 * **這個版本是給耳朵的**（語音播報、以及只需要一行文字的場合）。
 * 畫面上請直接用 evacuationPlan 的結構排版——散文在恐慌中掃視不了。
 */
export function planToSentence(plan, motion = null) {
  if (!plan) return null;
  const name = (e) => (e.landmark ? `${e.code} 出口（往${e.landmark}）` : `${e.code} 出口`);
  const parts = [];

  const m = motionLine(motion);
  if (m) parts.push(m);

  const from = plan.from ? `遠離 ${plan.from} 出口一帶` : '遠離事件位置';
  const prefix = plan.stepFree ? '♿ ' : '';

  if (plan.kind === 'shelter') {
    parts.push(`${prefix}${plan.reason}。${plan.action}。`);
  } else {
    const go = plan.go.map(name).join('、');
    const avoid = plan.avoid.length > 0 ? `；避開 ${plan.avoid.map(name).join('、')}` : '';
    const unknown = plan.unknownExits > 0
      ? `（另有 ${plan.unknownExits} 個出口無無障礙資訊，未列入）` : '';
    parts.push(`${prefix}${from}，改往${plan.stepFree ? '無台階可通行的' : ''} ${go}${unknown}${avoid}。${plan.note}。`);
  }
  return parts.join(' ');
}

/**
 * 一行疏散建議文字（沿用舊介面，內部走結構化路徑）。
 * @returns {string|null}
 */
export function evacuationLine(opts = {}) {
  return planToSentence(evacuationPlan(opts), opts.motion ?? null);
}
