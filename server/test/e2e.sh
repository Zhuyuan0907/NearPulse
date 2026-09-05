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
# 散文與結構化計畫必須出自同一個 service——早期兩邊各算一次，會給出不同的出口
check "即時疏散內容與態勢卡一致（同一個 service）" \
  test "$(echo "$EVAC" | json "all(g['code'] in d['evacuation'] for g in d['plan']['go'])")" = "True"
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
# 整張圖也要能直接讀：使用者不點九宮格、或 AI 指不出格位時，
# 舊版會什麼都不做——那是「有機會認出來」與「保證認不出來」的差別。
check "read 階段接受整張圖（不強制先裁切）" \
  test "$(curl -s -X POST "$BASE/api/vision" -H 'Content-Type: application/json' \
    -d '{"base64":"AAAABBBB","mimeType":"image/webp","stage":"read"}' | json "d['ok']")" = "True"
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
# 一律用 station id 指名，不用索引：其他測試留下的事件會讓 stations[0] 位移
SEL="[e for s in d['stations'] if s['stationId']=='TPE-A1' for e in s['events'] if e['type']=='fire'][0]"
check "疏散計畫以 M3 出口為原點（事件錨點）" \
  test "$(echo "$CARD" | json "$SEL['plan']['from']")" = "M3"
# 結構化：眼睛需要可掃視的區塊，不是一整段散文
check "疏散計畫是結構化的（go/avoid 分開）" \
  test "$(echo "$CARD" | json "isinstance($SEL['plan']['go'], list)")" = "True"
# 只有實測步行時間才有資格出現數字——地面直線距離不能當成地下步行距離
check "疏散計畫不輸出未經實測的距離數字" \
  test "$(echo "$CARD" | json "not any(str(g.get('landmark') or '').endswith('m') for g in $SEL['plan']['go'])")" = "True"
check "疏散計畫附上依站內指標前進的說明" \
  test "$(echo "$CARD" | json "'依站內出口指標' in ($SEL['plan'].get('note') or '')")" = "True"
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
# plan.origin 就是疏散計算的起點——直接驗它比繞著地標字串猜穩定得多
check "疏散計畫以選點為原點（不是場域中心）" \
  test "$(curl -s "$BASE/api/situation" | json "any(abs(((e.get('plan') or {}).get('origin') or {}).get('lat', 0) - 25.04505) < 1e-6 for s in d['stations'] for e in s['events'])")" = "True"

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

echo "== 11. 攻擊事件（依台北捷運真實案例補上的類型） =="
# 原本持械攻擊只能歸「其他」：門檻 3、嚴重度 low——嚴重的錯誤分類
ATK=$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?exit=3&type=attack")
check "攻擊的建議與火警不同（不是往出口疏散）" \
  test "$(echo "$ATK" | json "'圍觀' in d['advice'] and '掩蔽' in d['advice']")" = "True"
# 2014 鄭捷案發生在行進中的車廂裡，乘客 4 分鐘無處可逃——「哪個出口」是無意義的問題
TRAIN=$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?exit=3&type=attack&onTrain=1")
check "在列車上 → 疏散計畫是不同性質的答案" \
  test "$(echo "$TRAIN" | json "d['plan']['kind']")" = "onTrain"
check "列車上的建議提到緊急對講機與其他車廂" \
  test "$(echo "$TRAIN" | json "'對講機' in d['plan']['action'] and '車廂' in d['plan']['action']")" = "True"
# 2025 年那起攻擊從台北車站移動到中山站再到誠品南西——下一個場域現在就該知道
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-atk-1","sessionId":"sess-K1","type":"attack","nearExitCode":"M3",
  "locationClaim":{"source":"manual","stationId":"TPE-A1","confidence":1.0,"timestamp":1}}' > /dev/null
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-atk-2","sessionId":"sess-K2","type":"attack","nearExitCode":"M5",
  "locationClaim":{"source":"manual","stationId":"TPE-A1","confidence":1.0,"timestamp":1}}' > /dev/null
wait_batch
check "攻擊門檻為 2（與火警同級，不能等湊 3 個人）" \
  test "$(curl -s "$BASE/api/reports/context?station=TPE-A1&type=attack" | json "d['events'][0]['status']")" = "active"
check "高嚴重度事件會警示鄰近場域" \
  test "$(curl -s "$BASE/api/situation" | json "len(d['nearbyAlerts']) > 0")" = "True"
check "鄰近警示指出來源場域與距離" \
  test "$(curl -s "$BASE/api/situation" | json "all(a.get('fromVenue') and a.get('distanceM') is not None for a in d['nearbyAlerts'])")" = "True"

echo "== 12. 百貨／商場（有地下樓層的公眾零售場所） =="
RT=$(curl -s "$BASE/api/venues/search?q=%E6%96%B0%E5%85%89%E4%B8%89%E8%B6%8A")
check "搜尋得到百貨場域" \
  test "$(echo "$RT" | json "any(v['kind']=='retail' for v in d['venues'])")" = "True"
check "百貨誠實標記無出口圖資（不假裝有疏散路線）" \
  test "$(echo "$RT" | json "all(not v['exitsAvailable'] for v in d['venues'] if v['kind']=='retail')")" = "True"

echo "== 13. 否證否決：在場「沒看到」>=3 → cancelled =="
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
# 結案的事件過去是**無聲消失**的——closingNotice 產生了卻沒送到任何人面前。
# 疏散情境裡，不知道警報解除和不知道警報發生幾乎一樣糟。
RCARD=$(curl -s "$BASE/api/situation")
check "結案事件出現在「已解除」區（不再無聲消失）" \
  test "$(echo "$RCARD" | json "any(r['id']=='$EVT2' for r in d['resolved'])")" = "True"
check "已解除帶結案說明（server 早就備好、之前沒人看得到）" \
  test "$(echo "$RCARD" | json "bool([r for r in d['resolved'] if r['id']=='$EVT2'][0]['notice'])")" = "True"
# 「警報解除」與「查無此事」對讀的人是完全不同的兩件事，
# 而此時 status 已經同樣是 cancelled——必須靠 wasActive 區分
check "區分「曾經成立」與「從未成立」（語氣不同）" \
  test "$(echo "$RCARD" | json "[r for r in d['resolved'] if r['id']=='$EVT2'][0]['wasActive']")" = "False"
check "已解除的事件不再出現在警示區" \
  test "$(echo "$RCARD" | json "not any(e['id']=='$EVT2' for s in d['stations'] for e in s['events'])")" = "True"

echo "== 14. 行進中列車：下一站與到站預告（TDX 官方路網） =="
# 【為什麼有這一段】2014 年鄭捷案發生在行駛中的板南線列車上，車廂內的人
# 被關在封閉空間約 4 分鐘。車上的人做不了什麼；能改變結果的是**下一站月台上的人**。
V_BL13=$(curl -s "$BASE/api/venues/TPE-BL13")
check "捷運場域帶出可能的下一站（供使用者指認）" \
  test "$(echo "$V_BL13" | json "len(d['venue']['nextStations']) >= 2")" = "True"
check "下一站確實與該站相鄰（不是跨城市撞號的結果）" \
  test "$(echo "$V_BL13" | json "sorted(x['venueId'] for x in d['venue']['nextStations']) == ['TPE-A1','TPE-BL14']")" = "True"
check "下一站附官方行車秒數（非估計值）" \
  test "$(echo "$V_BL13" | json "any(x['estimated'] is False and 30 < x['runSec'] < 300 for x in d['venue']['nextStations'])")" = "True"
# 百貨、地下街、地下停車場不在捷運路網上——UI 據此把「事件在列車上」整個藏起來
RETAIL_ID=$(curl -s --get "$BASE/api/venues/search" --data-urlencode "q=百貨" | json "d['venues'][-1]['id']")
check "非捷運場域沒有下一站（UI 隱藏「事件在列車上」）" \
  test "$(curl -s "$BASE/api/venues/$RETAIL_ID" | json "d['venue']['nextStations'] == [] and d['venue']['kind'] != 'metro'")" = "True"

# 三筆獨立回報湊到攻擊門檻（2），事件在列車上、剛離開台北車站、下一站善導寺
for S in trn-A trn-B trn-C; do
  curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d "{
    \"uuid\":\"e2e-train-$S\",\"sessionId\":\"$S\",\"type\":\"attack\",
    \"locationClaim\":{\"source\":\"manual\",\"stationId\":\"TPE-A1\",\"confidence\":1.0,\"timestamp\":1},
    \"onTrain\":true,\"nextVenueId\":\"TPE-BL13\"}" > /dev/null
done
wait_batch
TCARD=$(curl -s "$BASE/api/situation")
check "車廂內的事件帶到站預告" \
  test "$(echo "$TCARD" | json "any(e.get('arrival') for s in d['stations'] for e in s['events'])")" = "True"
check "到站預告指向使用者指認的下一站" \
  test "$(echo "$TCARD" | json "[e['arrival']['venueId'] for s in d['stations'] for e in s['events'] if e.get('arrival')][0]")" = "TPE-BL13"
# 下一站月台上的人是唯一能改變車廂內結果的那群人
check "下一站收到「事故列車即將進站」警示" \
  test "$(echo "$TCARD" | json "any(a['venueId']=='TPE-BL13' for a in d['inboundAlerts'])")" = "True"
check "到站警示指出來源方向與事件類型" \
  test "$(echo "$TCARD" | json "[a for a in d['inboundAlerts'] if a['venueId']=='TPE-BL13'][0]['fromVenue']")" = "台北車站"
# ⚠️ 這一項是弱網預算的守門員：剩餘秒數若寫進卡片，每次輪詢 ETag 都會變，
#    304 就永遠不會發生。卡片只放絕對到站時刻，倒數由 client 自己算。
check "卡片只放絕對到站時刻，不放會逐秒變動的剩餘秒數" \
  test "$(echo "$TCARD" | json "all('etaSec' not in a and a['arriveAt'] > 0 for a in d['inboundAlerts'])")" = "True"
# 先多等一個 tick 讓事件敘事（LLM stub）落定再取 ETag——否則量到的是
# 敘事寫入造成的重建，而不是我們要驗的「倒數不會讓卡片改變」
wait_batch
T_ETAG=$(curl -sI "$BASE/api/situation" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
sleep 12
check "倒數進行中，態勢卡仍回 304（弱網預算未被倒數吃掉）" \
  test "$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: $T_ETAG" "$BASE/api/situation")" = "304"
# 未確認的通報不擴散到整座月台：製造的推擠風險可能大過它避免的風險
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-train-solo","sessionId":"trn-Z","type":"other",
  "locationClaim":{"source":"manual","stationId":"TPE-BL14","confidence":1.0,"timestamp":1},
  "onTrain":true,"nextVenueId":"TPE-BL15"}' > /dev/null
wait_batch
check "未確認／低嚴重度的列車事件不發出到站警示" \
  test "$(curl -s "$BASE/api/situation" | json "not any(a['venueId']=='TPE-BL15' for a in d['inboundAlerts'])")" = "True"

# 態勢卡的地圖需要座標才畫得出來——文字敘述則在任何情況下都先到、且獨立可用
check "疏散計畫帶出口座標（態勢卡地圖用）" \
  test "$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?exit=2&type=fire" | json "all(g.get('lat') and g.get('lon') for g in d['plan']['go'])")" = "True"
check "疏散計畫帶避開半徑與事件原點（地圖圓圈用）" \
  test "$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?exit=2&type=fire" | json "d['plan']['avoidRadiusM'] > 0 and d['plan']['origin']['lat'] > 0")" = "True"
# 【地下看不到門牌號碼】TDX 只公佈一個描述欄位，台北車站的出口大多是門牌
# （「忠孝西路1段33號」）——那回答的是「我出去之後會在哪」，不是「我在站內
# 該往哪走」。站體方位是我們算得出來的，而且對應得上地下的空間感。
check "出口帶站體方位（門牌號碼在地下沒有用）" \
  test "$(curl -s "$BASE/api/venues/TPE-A1/evacuation?exit=M3&type=fire" | json "all(g.get('side') for g in d['plan']['go'])")" = "True"

# 【開門側：「哪一節車廂」問題的可行替代】
# 車廂↔樓梯／出口的對應**沒有任何開放資料**——日本的乗換案内是向民間購買
# 人工實測資料，TDX 整份 spec 沒有月台門或車廂欄位，OSM 的
# railway:platform:section 全台灣 0 筆。但開門側是官方公開的，而且不需要
# 知道車廂編號就能執行：到站前先移動到會開門的那一側。
check "到站預告帶開門側（政府開放資料 128416）" \
  test "$(echo "$TCARD" | json "[e['arrival']['doorSide']['side'] for s in d['stations'] for e in s['events'] if e.get('arrival')][0]")" = "left"
# 西門是疊式月台，兩個方向開門側**相反**——這是解析器最容易錯的形態
check "疊式月台的開門側依方向不同（西門 往南港展覽館=右／往頂埔=左）" \
  test "$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?exit=2&type=fire" > /dev/null; \
    node -e "import('./src/services/trainService.js').then(t=>{
      const a=t.doorSideAt('TPE-BL11','BL','南港展覽館')?.side;
      const b=t.doorSideAt('TPE-BL11','BL','頂埔')?.side;
      console.log(a==='right' && b==='left');})" 2>/dev/null | tail -1)" = "true"
# 輪椅席車廂是官方唯一公開的車廂級資訊，對無障礙疏散直接有用
check "到站預告帶輪椅席車廂（官方唯一公開的車廂級資訊）" \
  test "$(echo "$TCARD" | json "len([e['arrival']['wheelchairCars'] for s in d['stations'] for e in s['events'] if e.get('arrival')][0]) >= 1")" = "True"

echo "== 15. 目擊位置回報：歹徒動態怎麼更新 =="
# 【為什麼有這一段】移動判定的原料是「(時間, 錨點, 目擊者)」三元組，而在加入
# 第三問之前，這些三元組只能從新回報取得——一個剛答完「有，我看到了」的
# 現場目擊者，明明最清楚歹徒在哪，卻沒有管道說出來。
for S in sgt-A sgt-B; do
  curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d "{
    \"uuid\":\"e2e-sight-$S\",\"sessionId\":\"$S\",\"type\":\"attack\",
    \"locationClaim\":{\"source\":\"manual\",\"stationId\":\"TPE-A1\",\"confidence\":1.0,\"timestamp\":1},
    \"nearExitCode\":\"M3\"}" > /dev/null
done
wait_batch
SEVT=$(curl -s "$BASE/api/reports/context?station=TPE-A1&type=attack" | json "d['events'][0]['id']")
sight() { curl -s -X POST "$BASE/api/events/$SEVT/confirm" -H 'Content-Type: application/json' -d "$1"; }

# 軌跡會變成「往哪個方向逃」的建議——不在現場的人絕不能污染它
check "不在現場者的目擊位置被拒絕（軌跡不可被遠端污染）" \
  test "$(sight '{"sessionId":"e2e-outsider","step":"sighting","nearExitCode":"M8"}' | json "d['ok']")" = "False"

sight '{"sessionId":"e2e-eyeA","step":"location","atStation":true}' > /dev/null
sight '{"sessionId":"e2e-eyeA","step":"witness","atStation":true,"witnessed":"yes"}' > /dev/null
check "在場目擊者的位置寫入事件軌跡" \
  test "$(sight '{"sessionId":"e2e-eyeA","step":"sighting","nearExitCode":"M6"}' | json "d['recorded']")" = "True"
# 同一個人可以回報多次：歹徒會一直移動，一次目擊不是一張票
check "同一目擊者可重複回報位置（觀測不是投票）" \
  test "$(sight '{"sessionId":"e2e-eyeA","step":"sighting","nearExitCode":"M6"}' | json "d['recorded']")" = "True"

sleep 22   # threatMotion 要求觀測間隔 >= 20 秒，否則不成立為一段位移
sight '{"sessionId":"e2e-eyeB","step":"location","atStation":true}' > /dev/null
sight '{"sessionId":"e2e-eyeB","step":"witness","atStation":true,"witnessed":"yes"}' > /dev/null
SRES=$(sight '{"sessionId":"e2e-eyeB","step":"sighting","nearExitCode":"M8"}')
# 兩個**互相獨立**的目擊者、不同出口、間隔足夠 → 才算移動
check "兩位獨立目擊者的位置差 → 判定移動中" \
  test "$(echo "$SRES" | json "d['motion']['moving']")" = "True"
check "移動判定給出方位（疏散建議據此避開）" \
  test "$(echo "$SRES" | json "bool(d['motion']['compass'])")" = "True"
# 立刻重算，不等批次：歹徒移動時 10 秒是很長的時間
check "目擊回報立即反映在態勢卡（不等批次 tick）" \
  test "$(curl -s "$BASE/api/situation" | json "any(e.get('motion',{}).get('moving') for s in d['stations'] for e in s['events'])")" = "True"
# 軌跡的用途就是這個：讓其他人別往他前進的方向走
check "威脅前進方向上的出口被排除在建議之外" \
  test "$(curl -s "$BASE/api/situation" | json "any(e['motion'].get('moving') and len(e['plan'].get('avoid') or []) > 0 for s in d['stations'] for e in s['events'] if e.get('motion'))")" = "True"

echo "== 16. Vision 限流：保護額度，但不擋通報 =="
# /api/vision 無認證且會轉發到**付費** API——公開部署等同開放一個免費 Vision 代理。
# 這一段擺最後，因為它會刻意打爆限流視窗。
for _ in $(seq 1 14); do
  curl -s -X POST "$BASE/api/vision" -H 'Content-Type: application/json' \
    -d '{"base64":"AAAABBBB","mimeType":"image/webp","stage":"locate"}' > /dev/null
done
RL=$(curl -s -X POST "$BASE/api/vision" -H 'Content-Type: application/json' \
  -d '{"base64":"AAAABBBB","mimeType":"image/webp","stage":"locate"}')
check "超過每分鐘上限後會限流（不再呼叫供應商）" \
  test "$(echo "$RL" | json "d['result'].get('rateLimited') is not None")" = "True"
# **最重要的一項**：限流回的是降級形狀，不是 429。視覺辨識是選配加值，
# 呼叫端不需要也不應該分辨「被限流」與「AI 沒開」——通報永遠不會因限流而失敗。
check "限流時回降級形狀而非錯誤（通報流程不受影響）" \
  test "$(echo "$RL" | json "d['ok'] and d['result']['pending'] and d['result']['roiCell'] is None")" = "True"
RL_REPORT=$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-after-ratelimit","sessionId":"sess-RL","type":"other",
  "locationClaim":{"source":"manual","stationId":"TPE-BL13","confidence":1.0,"timestamp":1}}')
check "限流後回報仍正常受理" test "$(echo "$RL_REPORT" | json "d['ok']")" = "True"

echo "== 20. 升級門檻：再多一個人就成立 =="
# 門檻全部設為 2（原本推擠／其他是 3）。3 個獨立 session 在真實情境中很難湊到，
# 而一個永遠升不上去的門檻等於沒有這個類型。
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-thr-1","sessionId":"thr-A","type":"crush",
  "locationClaim":{"source":"manual","stationId":"TPE-BL06","confidence":1.0,"timestamp":1}}' > /dev/null
wait_batch
TEVT=$(curl -s "$BASE/api/reports/context?station=TPE-BL06&type=crush" | json "d['events'][0]['id']")
check "第一筆回報仍是 candidate（單一訊號不成立）" \
  test "$(curl -s "$BASE/api/events/$TEVT" | json "d['event']['status']")" = "candidate"
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-thr-2","sessionId":"thr-B","type":"crush",
  "locationClaim":{"source":"manual","stationId":"TPE-BL06","confidence":1.0,"timestamp":1}}' > /dev/null
wait_batch
check "第二個獨立訊號 → 升級為 active" \
  test "$(curl -s "$BASE/api/events/$TEVT" | json "d['event']['status']")" = "active"

# 【曾經的 bug】獨立訊號的計數原本只認 gps|manual|session 三種來源，
# 而「自己描述地點」(freeform) 與「只拍照」(unknown) 完全不算——
# 用那兩條路通報的事件再多人也升不上去，會一直停在未經確認直到過期。
# 而那兩條路正是給「不知道自己在哪」的人用的。
for S in fr-A fr-B; do
  curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d "{
    \"uuid\":\"e2e-thr-$S\",\"sessionId\":\"$S\",\"type\":\"other\",
    \"locationClaim\":{\"source\":\"freeform\",\"place\":\"某某地下街 B2 美食區\"}}" > /dev/null
done
wait_batch
check "自己描述地點的回報也計入門檻（不再永遠升不上去）" \
  test "$(curl -s "$BASE/api/situation" | json "any(e['status']=='active' and e['independentSignals']>=2 for s in d['stations'] if s['stationName']=='某某地下街 B2 美食區' for e in s['events'])")" = "True"

echo "== 17. 錨點消歧：月台上最大的字不是你所在的站 =="
# 【真實回報的 bug】使用者拍土城月台、已手選土城，卻收到別站的疏散建議。
# 原因：月台指標帶同時印著前後站（海山、永寧）與方向牌（往頂埔），
# 而舊版「第一個命中的站名就採用並覆蓋使用者選擇」——模型輸出順序一變答案就變。
anchors() { node -e "
  import('./src/services/venueService.js').then(v=>{
    const r=v.resolveAnchors({texts:$1, venueId:$2});
    console.log(JSON.stringify({venue:r.venue?r.venue.name:null,
      cands:r.candidates.map(c=>[c.venueName,c.confidence])}));
  });" 2>/dev/null | tail -1; }

# 方向牌講的是**目的地**，不是所在地
check "「往X」不被當成所在地" \
  test "$(anchors "['往頂埔','土城']" "'TPE-BL03'" | json "d['venue']")" = "土城"
# 使用者手選的場域也出現在照片裡 → 尊重使用者，不要自作主張換掉
check "鄰站站名不覆蓋使用者的手選場域" \
  test "$(anchors "['海山','Haishan','土城','Tucheng']" "'TPE-BL03'" | json "d['venue']")" = "土城"
check "前後站都入鏡時仍解析為使用者所在站" \
  test "$(anchors "['永寧','土城','海山']" "'TPE-BL03'" | json "d['venue']")" = "土城"
# 路線代碼只印在**本站自己**的牌子上，鄰站在指標帶上只有名字——最可靠的消歧訊號
check "路線代碼（BL03）可在無使用者選擇時消歧" \
  test "$(anchors "['海山','土城','BL03']" "null" | json "d['venue']")" = "土城"
# **猜不出來就不要猜**：猜錯會送出另一座車站的疏散指示，比多一次點擊糟得多
check "多站名、無代碼、無選擇 → 不猜，交給使用者點選" \
  test "$(anchors "['海山','永寧']" "null" | json "d['venue'] is None and len(d['cands'])==2")" = "True"
check "歧義候選一律低信心（client 據此不自動套用）" \
  test "$(anchors "['海山','永寧']" "null" | json "all(c[1]=='low' for c in d['cands'])")" = "True"
# 照片明確指向單一車站時，仍要能糾正使用者選錯的場域
check "照片明確時仍會糾正使用者選錯的場域" \
  test "$(anchors "['土城','Tucheng']" "'TPE-A1'" | json "d['venue']")" = "土城"

echo "== 18. 不知道自己在哪也要能通報 =="
# 【為什麼】「我在一個陌生的地下空間、不知道自己在哪」正是這個 App 存在的理由。
# 舊版沒有 stationId 就整筆退回，等於把最需要幫助的人擋在門外。
# 而圖資也永遠不會完整：836 個場域裡百貨只有 58 個、有出口圖資的只有 279 個。
# 但**至少要有一種**：完全沒有位置的通報，沒有人能行動、也沒有人能確認，
# 它只會成為態勢卡上的雜訊。之所以「擇一」不算門檻，是因為其中兩條
# 完全不需要你知道自己在哪——拍照只要把鏡頭對著牆，GPS 只要授權。
check "完全沒有位置線索的回報被擋下（並說明怎麼補）" \
  test "$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
    "uuid":"e2e-noloc-0","sessionId":"nl-Z","type":"fire",
    "locationClaim":{"source":"unknown"}}' | json "d['ok']")" = "False"
# 照片就算視覺辨識讀不出來也算位置線索——站務人員與其他在場的人看得懂那張照片
check "只有照片也算位置線索（不需要知道自己在哪）" \
  test "$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
    "uuid":"e2e-noloc-1","sessionId":"nl-A","type":"fire",
    "locationClaim":{"source":"unknown"},"photo":{"base64":"AAAABBBB","mimeType":"image/webp"}}' | json "d['ok']")" = "True"
check "只有座標也算位置線索" \
  test "$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
    "uuid":"e2e-noloc-1b","sessionId":"nl-A2","type":"fire",
    "locationClaim":{"source":"gps","lat":25.046,"lon":121.517}}' | json "d['ok']")" = "True"
check "自己描述地點的回報被受理（圖資查不到的商店／連通道）" \
  test "$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
    "uuid":"e2e-noloc-2","sessionId":"nl-B","type":"crush",
    "locationClaim":{"source":"freeform","place":"京站地下街 B1 星巴克前"}}' | json "d['ok']")" = "True"
wait_batch
NCARD=$(curl -s "$BASE/api/situation")
check "無場域事件標記為圖資外（UI 據此誠實降級）" \
  test "$(echo "$NCARD" | json "any(s.get('offMap') for s in d['stations'])")" = "True"
check "自由描述的地點成為事件標題" \
  test "$(echo "$NCARD" | json "any(s['stationName']=='京站地下街 B1 星巴克前' for s in d['stations'])")" = "True"
check "沒有場域就不給出口層級的疏散建議（不假裝知道）" \
  test "$(echo "$NCARD" | json "all(e['plan'] is None for s in d['stations'] if s.get('offMap') for e in s['events'])")" = "True"
# **不能**把所有無場域的通報併成一件——那會把不同地點的人混為一談
check "不同描述的無場域事件不會被錯併成一件" \
  test "$(echo "$NCARD" | json "len([s for s in d['stations'] if s.get('offMap')]) >= 2")" = "True"
# 同一個地點的第二筆才該併進去
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-noloc-3","sessionId":"nl-C","type":"crush",
  "locationClaim":{"source":"freeform","place":"京站地下街 B1 星巴克前"}}' > /dev/null
wait_batch
check "相同描述的第二筆併入同一件事" \
  test "$(curl -s "$BASE/api/situation" | json "sum(e['reportCount'] for s in d['stations'] if s['stationName']=='京站地下街 B1 星巴克前' for e in s['events'])")" = "2"

# 【錨點解析：辨識回來的是整行字，不是乾淨欄位】
# 實測模型回傳 ['往頂埔 To Dingpu','土城 Tucheng','← 海山 Haishan']——
# 只做完全相等比對的話一個都對不上，這正是一張清楚拍到站名的月台照
# 最後顯示「位置待確認」的原因。
check "整行字也能認出站名（不是只做完全相等比對）" \
  test "$(anchors "['土城 Tucheng']" "null" | json "d['venue']")" = "土城"
# 月台名牌上是「← 前站　本站　後站 →」，本站是唯一與其他候選都相鄰的那個。
# 相鄰關係來自 TDX 官方站序，不是猜的。
check "月台名牌：本站是與前後站都相鄰的那一個" \
  test "$(anchors "['土城 Tucheng','← 海山 Haishan','永寧 → Yongning']" "null" | json "d['venue']")" = "土城"
check "不相鄰的多站名仍然不猜" \
  test "$(anchors "['土城 Tucheng','台北車站 Taipei Main Station']" "null" | json "d['venue'] is None")" = "True"
# 最長匹配：中山國小必須勝過中山，否則使用者會被判到隔壁站
check "最長匹配優先（中山國小 不會被判成 中山）" \
  test "$(anchors "['中山國小']" "null" | json "d['venue']")" = "中山國小"

# 【月台上到處都是數字，但只有一種是出口】
# 使用者實測拍忠孝敦化月台：車門貼「車廂3 Car 3」、看板寫「2月台」、
# 站名牌是「BL16」。車廂編號被當成 3 號出口，會把人指到站內完全不同的位置。
anchors2() { node -e "
  import('./src/services/venueService.js').then(v=>{
    const r=v.resolveAnchors({texts:$1, venueId:$2});
    console.log(JSON.stringify({venue:r.venue?r.venue.name:null,
      exits:r.candidates.map(c=>c.exitCode)}));
  });" 2>/dev/null | tail -1; }

check "車廂編號不會變成出口編號" \
  test "$(anchors2 "[{label:'車廂',value:'車廂3'},{label:'站名',value:'忠孝敦化'}]" "null" | json "d['exits'] == [None]")" = "True"
check "月台編號不會變成出口編號" \
  test "$(anchors2 "[{label:'月台',value:'2月台'},{label:'站名',value:'忠孝敦化'}]" "null" | json "d['exits'] == [None]")" = "True"
# 模型會把 BL16 的 16 單獨列出來還標成「出口」——不能只依賴模型標對
check "站名代碼的數字（BL16 的 16）不會變成出口編號" \
  test "$(anchors2 "[{label:'站名',value:'BL16 忠孝敦化'},{label:'出口',value:'16'}]" "null" | json "d['exits'] == [None]")" = "True"
check "真正的出口牌仍然讀得出來" \
  test "$(anchors2 "[{label:'站名',value:'善導寺'},{label:'出口',value:'出口3'}]" "null" | json "d['exits']")" = "['3']"
check "帶字母前綴的出口代碼不受影響" \
  test "$(anchors2 "[{label:'出口',value:'M3'}]" "'TPE-A1'" | json "d['exits']")" = "['M3']"
# 短代碼用單詞邊界比對：R3 曾命中「Car 3」裡的 ar3，把忠孝敦化判到高雄小港
check "路線代碼不會誤中普通英文字（Car 3 不是 R3）" \
  test "$(anchors2 "[{label:'文字',value:'車廂3 Car 3'},{label:'站名',value:'忠孝敦化'}]" "null" | json "d['venue']")" = "忠孝敦化"

echo "== 19. 指認位置：通報者說不出來，但看照片的人認得 =="
# 【為什麼】態勢卡對圖資外的事件寫著「請協助確認」，但點進去卻是
# 「你現在在『位置待確認』嗎？」——一個無意義的問題。通報者說不出自己在哪，
# 但看照片的人可能一眼就認出來，而系統當時沒有任何管道收下那個答案。
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-ident-1","sessionId":"id-A","type":"other",
  "locationClaim":{"source":"freeform","place":"某個地下通道"},
  "note":"手扶梯旁邊有濃煙"}' > /dev/null
wait_batch
# 用 note 精準指定：第 18 段也留下了圖資外事件，取 [0] 會抓錯
IEVT=$(curl -s "$BASE/api/situation" | json "[e['id'] for s in d['stations'] for e in s['events'] if e.get('note')=='手扶梯旁邊有濃煙'][0]")
check "圖資外事件會帶出通報者的文字（不是只給「位置待確認」）" \
  test "$(curl -s "$BASE/api/situation" | json "any(e.get('note')=='手扶梯旁邊有濃煙' for s in d['stations'] if s.get('offMap') for e in s['events'])")" = "True"
# 指認**不要求在場**：認得一個地方不需要人在那裡，這正是它的價值
check "指認位置會套用到事件" \
  test "$(curl -s -X POST "$BASE/api/events/$IEVT/confirm" -H 'Content-Type: application/json' \
    -d '{"sessionId":"id-B","step":"identify","venueId":"TPE-BL13"}' | json "d['applied'] and d['event']['stationName']=='善導寺'")" = "True"
# 已經有場域的事件不接受覆寫——否則這會變成可以隨意改寫他人通報位置的介面
check "已被指認的事件不接受他人改寫" \
  test "$(curl -s -X POST "$BASE/api/events/$IEVT/confirm" -H 'Content-Type: application/json' \
    -d '{"sessionId":"id-C","step":"identify","venueId":"TPE-A1"}' | json "d['applied'] is False and d['event']['stationName']=='善導寺'")" = "True"
wait_batch   # 態勢卡是快取的，指認只標記 dirty，要等下一個 tick 才重建
check "指認後不再是圖資外，且給得出疏散建議" \
  test "$(curl -s "$BASE/api/situation" | json "any(not s.get('offMap') and any(e['id']=='$IEVT' and e['plan'] for e in s['events']) for s in d['stations'])")" = "True"

# 沒有錨點就不該指認任何出口為「不要走」——那會把人推向錯的方向
check "無站內錨點時不產生「不要走」清單" \
  test "$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?type=crush" | json "d['plan']['avoid'] == [] and d['plan']['anchored'] is False")" = "True"
check "有錨點時才給「不要走」" \
  test "$(curl -s "$BASE/api/venues/TPE-BL13/evacuation?exit=2&type=crush" | json "len(d['plan']['avoid']) > 0 and d['plan']['anchored'] is True")" = "True"

echo ""
echo "======================================"
echo " 結果：$PASS 通過 · $FAIL 失敗"
[ "$FAIL" -eq 0 ] && echo " ✅ 端到端流程全部通過" || echo " ❌ 有失敗項目，請檢查 server log"
exit $FAIL
