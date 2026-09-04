/**
 * ============================================================================
 * stations.js —— 路網圖資料（subset）
 * ============================================================================
 * 定位原則：「路網圖本身就是所有人的共同記憶」——不用個人化常用站，
 * 手選時按官方路線順序排列，使用者憑對路網的既有認知即可 2 次點擊定位。
 * MVP 僅收錄三條線的部分站點；正式版換成完整路網 JSON 即可（介面不變）。
 */

export const LINES = [
  { id: 'BL', name: '板南線', color: '#2560a8', stations: [
    { id: 'BL07', name: '西門' },
    { id: 'BL10', name: '善導寺' },
    { id: 'BL11', name: '忠孝新生' },
    { id: 'BL12', name: '台北車站' },
    { id: 'BL13', name: '忠孝復興' },
    { id: 'BL14', name: '忠孝敦化' },
    { id: 'BL15', name: '國父紀念館' },
    { id: 'BL16', name: '市政府' },
  ]},
  { id: 'R', name: '淡水信義線', color: '#c8102e', stations: [
    { id: 'R07', name: '大安' },
    { id: 'R08', name: '信義安和' },
    { id: 'R09', name: '台北101/世貿' },
    { id: 'R10', name: '象山' },
    { id: 'R11', name: '中山' },
    { id: 'R12', name: '台北車站' },
  ]},
  { id: 'G', name: '松山新店線', color: '#008659', stations: [
    { id: 'G09', name: '松江南京' },
    { id: 'G10', name: '南京復興' },
    { id: 'G11', name: '台北小巨蛋' },
    { id: 'G12', name: '南京三民' },
    { id: 'G13', name: '松山' },
  ]},
];

/** 站點 id → 顯示名（例：BL12 → 「台北車站」） */
const stationIndex = new Map(
  LINES.flatMap((line) => line.stations.map((s) => [s.id, `${s.name}（${line.name}）`]))
);

export function stationDisplayName(stationId) {
  return stationIndex.get(stationId) ?? stationId;
}
