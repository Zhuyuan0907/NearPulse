/**
 * ============================================================================
 * /api/venues —— 場域查詢（零打字定位的資料來源）
 * ============================================================================
 * 三條路徑，對應「零打字」的優先序：
 *   1. GET /nearby?lat=&lon=  —— 主路徑。粗糙 GPS 也夠用（站距 > 300m），
 *      把全台 500+ 場域收斂成 3~8 個點選目標
 *   2. GET /:id               —— 選定後取出口清單與示意幾何（畫地圖用）
 *   3. GET /search?q=         —— **後備路徑**。沒有定位訊號時才需要打字
 *
 * 全部只讀記憶體中的快照，不碰外部網路（見 services/venueService.js）。
 */

import { nextStations } from '../services/trainService.js';
import { lookupPlaces, placeLookupMeta } from '../services/placeLookup.js';
import { Router } from 'express';
import {
  nearbyVenues,
  searchVenues,
  findVenue,
  venueGeometry,
  venueMeta,
} from '../services/venueService.js';
import { evacuationLine, evacuationPlan } from '../services/evacuationService.js';
import { getAdvice } from '../pipeline/advisors/llm.js';

export function createVenuesRouter() {
  const router = Router();

  /** 快照資訊（含 ODbL 姓名標示，前端頁尾顯示用） */
  router.get('/meta', (_req, res) => res.json({ ok: true, ...venueMeta() }));

  router.get('/nearby', (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: '缺少或無效的 lat/lon' });
    }
    const radiusM = Math.min(Number(req.query.radius) || 1200, 5000);
    res.json({ ok: true, venues: nearbyVenues(lat, lon, { radiusM }) });
  });

  /**
   * 在 OSM 地圖上找地點——**我們圖資裡沒有的地方**。
   *
   * 我們的快照是篩選過的（只留有地下特徵的場域），所以一間沒標地下樓層的
   * 百貨會整個消失，即使 OSM 知道它存在。正確的解法不是我們自己補清單
   *（那會變成一份越來越舊的手工資料），而是去問 OSM。
   *
   * 回來的地點**沒有出口資料**，只有名稱與座標——足以說「事件在這裡」，
   * 而疏散建議會誠實地說給不出出口層級的指引。
   *
   * ⚠️ 這是 server 唯一會在執行時連外的端點，而且只在搜尋路徑上。
   * 失敗一律回空陣列：使用者仍然可以自己打地點名稱或拍照，通報照樣成立。
   */
  router.get('/lookup', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ ok: true, places: [], ...placeLookupMeta });
    res.json({ ok: true, places: await lookupPlaces(q), ...placeLookupMeta });
  });

  router.get('/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ ok: true, venues: [] });
    res.json({ ok: true, venues: searchVenues(q) });
  });

  /**
   * 即時疏散建議——給「剛送出回報、正要開始逃」的人。
   *
   * 態勢卡的疏散文字要等下一個批次 tick（最多 10 秒）才會出現，
   * 但回報的人現在就要知道往哪走。這個端點直接算，不經過批次。
   * 內容與態勢卡完全一致（同一個 evacuationService），只是不必等。
   */
  router.get('/:id/evacuation', (req, res) => {
    const venue = findVenue(req.params.id);
    if (!venue) return res.status(404).json({ ok: false, error: '查無此場域' });

    const exit = typeof req.query.exit === 'string' ? req.query.exit.toUpperCase() : null;
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const point = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
    const type = typeof req.query.type === 'string' ? req.query.type : 'other';

    const mobility = req.query.mobility === 'stepFree' ? 'stepFree' : null;
    const onTrain = req.query.onTrain === '1';
    res.json({
      ok: true,
      venueName: venue.name,
      advice: getAdvice(type, 'active'),
      evacuation: evacuationLine({ venueId: venue.id, nearExitCode: exit, point, incidentType: type }),
      evacuationStepFree: evacuationLine({
        venueId: venue.id, nearExitCode: exit, point, incidentType: type, mobility: 'stepFree',
      }),
      plan: evacuationPlan({ venueId: venue.id, nearExitCode: exit, point, incidentType: type, onTrain }),
      planStepFree: evacuationPlan({
        venueId: venue.id, nearExitCode: exit, point, incidentType: type, onTrain, mobility: 'stepFree',
      }),
      mobility,
      accessibility: venue.accessibility ?? null,
    });
  });

  /** 單一場域：出口清單 + 真實經緯度（client 據此在地圖上標記） */
  router.get('/:id', (req, res) => {
    const venue = findVenue(req.params.id);
    if (!venue) return res.status(404).json({ ok: false, error: '查無此場域' });
    res.json({
      ok: true,
      venue: {
        ...venueGeometry(venue.id),
        /**
         * 可能的下一站。**只有捷運場域會有**——地下街、百貨、停車場不在路網上，
         * 回空陣列讓 client 直接把「事件在列車上」整個選項藏起來。
         * 掛在這支既有的請求上而不另開端點，是為了少一次來回。
         */
        nextStations: nextStations(venue.id),
      },
    });
  });

  return router;
}
