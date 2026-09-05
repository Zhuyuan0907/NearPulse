#!/usr/bin/env bash
# ============================================================================
# NearPulse 端到端驗證腳本
# ============================================================================
# 以 curl 走完設計中的完整事件生命週期（不需瀏覽器、不需任何 API 金鑰）：
#
#   1. 場域圖資（OSM 快照）：鄰近查詢、別名解析、示意幾何
#   2. Vision 端點：無供應商時回降級形狀，並發出 photoRef
#   3. 冪等驗證 + 第一筆回報 → candidate，帶出口錨點／照片／文字補充
#   4. 兩段式確認：兩位「在場 + 有看到」的獨立 session → 達門檻升級 active
#   5. 態勢卡：警示區出現事件；ETag 命中 → 304
#   6. 否證路徑（另一起事件）：在場否證 >= 3 → cancelled
#
# 使用方式：先啟動 server（npm start），再執行本腳本。
# ============================================================================
set -euo pipefail

BASE="http://localhost:3000"
PASS=0; FAIL=0
STEP=""

ok()   { PASS=$((PASS+1)); echo "  ✔ $STEP"; }
fail() { FAIL=$((FAIL+1)); echo "  ✘ $STEP"; }
check() { STEP="$1"; shift; if "$@"; then ok; else fail; fi; }

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

wait_batch() { echo "  … 等待批次 tick（10s）"; sleep 11; }

echo "== 0. 健康檢查 =="
check "server 存活" curl -sf "$BASE/healthz"

echo "== 1. 場域圖資（OSM 快照，server 端） =="
NEARBY=$(curl -s "$BASE/api/venues/nearby?lat=25.04624&lon=121.51747&radius=600")
check "鄰近查詢命中台北車站" \
  test "$(echo "$NEARBY" | json "d['venues'][0]['id']")" = "TPE-A1"
check "台北車站出口數 > 20（OSM 出口圖資）" \
  test "$(echo "$NEARBY" | json "d['venues'][0]['exitCount'] > 20")" = "True"
check "別名解析：BL12 → 台北車站（多線交會站已合併）" \
  test "$(curl -s "$BASE/api/venues/BL12" | json "d['venue']['name']")" = "台北車站"
# 路線代碼只在同一城市內唯一：R14 同時是台北圓山與高雄巨蛋。
# 有歧義的別名必須拒絕解析，而不是先到先得——猜錯會讓使用者看到別的場域。
check "歧義代碼 R14 不解析（台北圓山 vs 高雄巨蛋）" \
  test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/venues/R14")" = "404"
check "加了路網前綴就明確：TPE-R14 = 圓山" \
  test "$(curl -s "$BASE/api/venues/TPE-R14" | json "d['venue']['name']")" = "圓山"
check "示意幾何座標已正規化（供 client 畫 SVG，非圖磚）" \
  test "$(curl -s "$BASE/api/venues/TPE-BL13" | json "all(0 <= e['x'] <= 1 and 0 <= e['y'] <= 1 for e in d['venue']['exits'])")" = "True"
# 送出回報的人不能等 10 秒批次才知道往哪逃——這個端點直接算
EVAC=$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?exit=2&type=fire")
check "即時疏散端點（不等批次 tick）" \
  test "$(echo "$EVAC" | json "'改往' in d['evacuation'] and '避開' in d['evacuation']")" = "True"
check "即時疏散內容與態勢卡一致（同一個 service）" \
  test "$(echo "$EVAC" | json "'成功高中' in d['evacuation']")" = "True"
check "搜尋後備路徑：忠孝 → 有出口的車站排前面" \
  test "$(curl -s "$BASE/api/venues/search?q=%E5%BF%A0%E5%AD%9D" | json "d['venues'][0]['exitsAvailable']")" = "True"

echo "== 2. Vision 端點（無供應商 → 降級形狀，不擋流程） =="
V1=$(curl -s -X POST "$BASE/api/vision" -H 'Content-Type: application/json' \
  -d '{"base64":"AAAABBBB","mimeType":"image/webp","stage":"locate","venueId":"TPE-A1"}')
check "locate 階段回降級結構" \
  test "$(echo "$V1" | json "d['ok'] and d['result']['pending'] and d['result']['roiCell'] is None")" = "True"
V2=$(curl -s -X POST "$BASE/api/vision" -H 'Content-Type: application/json' \
  -d '{"base64":"AAAABBBB","mimeType":"image/webp","stage":"read","venueId":"TPE-A1"}')
check "read 階段同樣降級（無金鑰仍可跑完整流程）" \
  test "$(echo "$V2" | json "d['result']['pending'] and d['candidates'] == []")" = "True"
PHOTO_REF=$(echo "$V1" | json "d['photoRef']")
check "vision 回 photoRef（回報可免重傳整張圖）" test -n "$PHOTO_REF"

# 回報只帶 photoRef（不含 base64）——模擬 3G 下省掉第二次上傳的路徑
REPORT_1="{\"uuid\":\"e2e-uuid-001\",\"sessionId\":\"sess-A\",\"type\":\"fire\",
  \"nearExitCode\":\"M3\",\"photoRoi\":\"B2\",\"note\":\"月台中部有煙\",\"photoRef\":\"$PHOTO_REF\",
  \"locationClaim\":{\"source\":\"manual\",\"stationId\":\"TPE-A1\",\"confidence\":1.0,\"timestamp\":1}}"

echo "== 3. 回報冪等（同 UUID 重送，帶出口錨點、文字補充、photoRef） =="
R1=$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d "$REPORT_1")
R1b=$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d "$REPORT_1")
check "重送回傳相同結果" test "$R1" = "$R1b"

echo "== 4. 批次分群：首筆回報 → candidate =="
wait_batch
CTX=$(curl -s "$BASE/api/reports/context?station=TPE-A1&type=fire")
EVT=$(echo "$CTX" | json "d['events'][0]['id']")
STAT=$(echo "$CTX" | json "d['events'][0]['status']")
check "BL12 出現 fire candidate（$EVT）" test "$STAT" = "candidate"
EV_JSON=$(curl -s "$BASE/api/events/$EVT")
check "事件帶出口錨點 M3（疏散建議用）" \
  test "$(echo "$EV_JSON" | json "d['event']['nearExitCode']")" = "M3"
check "場域名稱由 server 圖資解析（非 client 帶入）" \
  test "$(echo "$EV_JSON" | json "d['event']['stationName']")" = "台北車站"
check "photoRef 已還原成照片（免重傳生效）" \
  test "$(echo "$EV_JSON" | json "d['event']['hasPhoto']")" = "True"
check "文字補充進入時間線敘事" \
  test "$(echo "$EV_JSON" | json "'月台中部有煙' in (d['event']['timeline'] or '')")" = "True"

echo "== 5. 兩段式確認：2 位獨立在場者 → 達門檻升級 =="
for S in sess-B sess-C; do
  curl -s -X POST "$BASE/api/events/$EVT/confirm" -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$S\",\"step\":\"location\",\"atStation\":true}" > /dev/null
  curl -s -X POST "$BASE/api/events/$EVT/confirm" -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$S\",\"step\":\"witness\",\"atStation\":true,\"witnessed\":\"yes\"}" > /dev/null
done
check "一 session 一票（重複投票被擋）" \
  test "$(curl -s -X POST "$BASE/api/events/$EVT/confirm" -H 'Content-Type: application/json' \
    -d '{"sessionId":"sess-B","step":"witness","atStation":true,"witnessed":"yes"}' | json "d.get('alreadyVoted')")" = "True"

wait_batch
check "火警 2 票門檻達成 → active" \
  test "$(curl -s "$BASE/api/events/$EVT" | json "d['event']['status']")" = "active"

echo "== 6. 態勢卡與 ETag =="
CARD=$(curl -s "$BASE/api/situation")
BL12_ON_CARD=$(echo "$CARD" | json "any(s['stationId']=='TPE-A1' for s in d['stations'])")
check "警示區包含 BL12 事件" test "$BL12_ON_CARD" = "True"
check "疏散計畫以 M3 出口為原點（事件錨點）" \
  test "$(echo "$CARD" | json "d['stations'][0]['events'][0]['plan']['from']")" = "M3"
# 結構化：眼睛需要可掃視的區塊，不是一整段散文
check "疏散計畫是結構化的（go/avoid 分開）" \
  test "$(echo "$CARD" | json "isinstance(d['stations'][0]['events'][0]['plan']['go'], list)")" = "True"
# 只有實測步行時間才有資格出現數字——地面直線距離不能當成地下步行距離
check "疏散計畫不輸出未經實測的距離數字" \
  test "$(echo "$CARD" | json "not any('m' in str(g.get('landmark') or '') and str(g.get('landmark') or '').endswith('m') for g in d['stations'][0]['events'][0]['plan']['go'])")" = "True"
check "疏散計畫附上依站內指標前進的說明" \
  test "$(echo "$CARD" | json "'依站內出口指標' in (d['stations'][0]['events'][0]['plan'].get('note') or '')")" = "True"
ETAG=$(curl -sI "$BASE/api/situation" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: $ETAG" "$BASE/api/situation")
check "ETag 命中 → 304（$CODE）" test "$CODE" = "304"

echo "== 7. 地圖選點驅動疏散（比出口錨點更精確的位置） =="
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-uuid-003","sessionId":"sess-H","type":"crush",
  "incidentPoint":{"lat":25.04505,"lon":121.52302},
  "locationClaim":{"source":"manual","stationId":"TPE-BL13","confidence":1.0,"timestamp":1}}' > /dev/null
wait_batch
EVT3=$(curl -s "$BASE/api/reports/context?station=TPE-BL13&type=crush" | json "d['events'][0]['id']")
EV3=$(curl -s "$BASE/api/events/$EVT3")
check "事件保留地圖選點座標" \
  test "$(echo "$EV3" | json "abs(d['event']['incidentPoint']['lat'] - 25.04505) < 1e-6")" = "True"
check "疏散計畫以選點為原點（不是場域中心）" \
  test "$(curl -s "$BASE/api/situation" | json "any(any(g['code']=='3' and g.get('landmark')=='成功高中' for g in (e.get('plan') or {}).get('go',[])) for s in d['stations'] for e in s['events'])")" = "True"

echo "== 8. 移動威脅追蹤（無差別攻擊：事件會跑） =="
# 兩個獨立目擊者、不同出口、間隔足夠 → 應判定為移動中
# 用獨立的場域與類型，避免與前面的測試事件互相污染
for PAIR in "sess-M1 1" "sess-M2 3"; do
  set -- $PAIR
  curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d "{
    \"uuid\":\"e2e-move-$2\",\"sessionId\":\"$1\",\"type\":\"medical\",\"nearExitCode\":\"$2\",
    \"locationClaim\":{\"source\":\"manual\",\"stationId\":\"TPE-BL13\",\"confidence\":1.0,\"timestamp\":1}}" > /dev/null
  sleep 25   # 必須超過 MIN_GAP_SEC（20s），留一點餘裕
done
wait_batch
EVT4=$(curl -s "$BASE/api/reports/context?station=TPE-BL13&type=medical" | json "d['events'][0]['id']")
EV4=$(curl -s "$BASE/api/events/$EVT4")
check "兩個獨立目擊者在不同出口 → 判定為移動中" \
  test "$(echo "$EV4" | json "d['event']['motion']['moving']")" = "True"
check "移動方向已算出（不是硬猜）" \
  test "$(echo "$EV4" | json "d['event']['motion'].get('compass') is not None")" = "True"
# 最關鍵的一條：疏散建議不得把人往威脅前進的方向趕
check "移動威脅會反映在事件的 motion 欄位" \
  test "$(curl -s "$BASE/api/situation" | json "any((e.get('motion') or {}).get('moving') for s in d['stations'] for e in s['events'])")" = "True"

echo "== 9. 無障礙疏散（火災時電梯不可用 → 答案性質不同） =="
ACC=$(curl -s "$BASE/api/venues/TPE-BL06/evacuation?exit=2&type=fire&mobility=stepFree")
check "府中站有無障礙資料（known>=2）" \
  test "$(echo "$ACC" | json "d['accessibility']['known'] >= 2")" = "True"
# 這是整個功能的核心：一般路線給出口，無障礙路線在電梯不可用時改成待援
check "無障礙版與一般版是不同性質的答案" \
  test "$(echo "$ACC" | json "d['plan']['kind'] != d['planStepFree']['kind']")" = "True"
check "火災＋僅電梯可無障礙 → 建議待援而非前往出口" \
  test "$(echo "$ACC" | json "d['planStepFree']['kind']=='shelter' and '電梯' in d['planStepFree']['reason']")" = "True"
# 同一站在電梯可用的事故類型下，應該給得出出口
ACC2=$(curl -s "$BASE/api/venues/TPE-BL06/evacuation?exit=2&type=crush&mobility=stepFree")
check "非火災（電梯可用）→ 給得出無障礙出口" \
  test "$(echo "$ACC2" | json "d['planStepFree']['kind']=='exits' and len(d['planStepFree']['go'])>0")" = "True"
# 安全預設：沒有標註不能當成可通行
NOACC=$(curl -s "$BASE/api/venues/TPE-G13/evacuation?exit=1&type=fire&mobility=stepFree")
check "無無障礙資料的場域 → 誠實說不知道，不假裝可通行" \
  test "$(echo "$NOACC" | json "d['planStepFree']['kind'] == 'shelter'")" = "True"

echo "== 10. 有人無法自行疏散（救援優先資訊） =="
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-assist-1","sessionId":"sess-AS","type":"fire","nearExitCode":"1",
  "needsAssistance":true,
  "locationClaim":{"source":"manual","stationId":"TPE-BL06","confidence":1.0,"timestamp":1}}' > /dev/null
wait_batch
EVT5=$(curl -s "$BASE/api/reports/context?station=TPE-BL06&type=fire" | json "d['events'][0]['id']")
check "事件記錄「有人需要協助」" \
  test "$(curl -s "$BASE/api/events/$EVT5" | json "d['event']['assistanceReports'] >= 1")" = "True"
check "態勢卡帶出無障礙版疏散計畫" \
  test "$(curl -s "$BASE/api/situation" | json "any(e.get('planStepFree') for s in d['stations'] for e in s['events'])")" = "True"

echo "== 11. 否證否決：在場「沒看到」>=3 → cancelled =="
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-uuid-002","sessionId":"sess-D","type":"other",
  "locationClaim":{"source":"manual","stationId":"TPE-G13","confidence":1.0,"timestamp":1}}' > /dev/null
wait_batch
EVT2=$(curl -s "$BASE/api/reports/context?station=TPE-G13&type=other" | json "d['events'][0]['id']")
for S in sess-E sess-F sess-G; do
  curl -s -X POST "$BASE/api/events/$EVT2/confirm" -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$S\",\"step\":\"witness\",\"atStation\":true,\"witnessed\":\"no\"}" > /dev/null
done
wait_batch
check "G13 事件被否證取消" \
  test "$(curl -s "$BASE/api/events/$EVT2" | json "d['event']['status']")" = "cancelled"

echo ""
echo "======================================"
echo " 結果：$PASS 通過 · $FAIL 失敗"
[ "$FAIL" -eq 0 ] && echo " ✅ 端到端流程全部通過" || echo " ❌ 有失敗項目，請檢查 server log"
exit $FAIL
