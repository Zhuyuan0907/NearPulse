#!/usr/bin/env bash
# ============================================================================
# NearPulse 端到端驗證腳本
# ============================================================================
# 以 curl 走完設計中的完整事件生命週期（不需瀏覽器）：
#
#   1. 冪等驗證：同一 UUID 重送 → 相同結果
#   2. 第一筆回報 → 批次後成為 candidate（徵詢中）
#   3. 兩段式確認：兩位「在場 + 有看到」的獨立 session → 達門檻升級 active
#   4. 態勢卡：警示區出現事件；ETag 命中 → 304
#   5. 否證路徑（另一起事件）：在場否證 >= 3 → cancelled
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

echo "== 1. 回報冪等（同 UUID 重送） =="
R1=$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-uuid-001","sessionId":"sess-A","type":"fire",
  "locationClaim":{"source":"manual","stationId":"BL12","confidence":1.0,"timestamp":1}}')
R1b=$(curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-uuid-001","sessionId":"sess-A","type":"fire",
  "locationClaim":{"source":"manual","stationId":"BL12","confidence":1.0,"timestamp":1}}')
check "重送回傳相同結果" test "$R1" = "$R1b"

echo "== 2. 批次分群：首筆回報 → candidate =="
wait_batch
CTX=$(curl -s "$BASE/api/reports/context?station=BL12&type=fire")
EVT=$(echo "$CTX" | json "d['events'][0]['id']")
STAT=$(echo "$CTX" | json "d['events'][0]['status']")
check "BL12 出現 fire candidate（$EVT）" test "$STAT" = "candidate"

echo "== 3. 兩段式確認：2 位獨立在場者 → 達門檻升級 =="
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

echo "== 4. 態勢卡與 ETag =="
CARD=$(curl -s "$BASE/api/situation")
BL12_ON_CARD=$(echo "$CARD" | json "any(s['stationId']=='BL12' for s in d['stations'])")
check "警示區包含 BL12 事件" test "$BL12_ON_CARD" = "True"
ETAG=$(curl -sI "$BASE/api/situation" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "If-None-Match: $ETAG" "$BASE/api/situation")
check "ETag 命中 → 304（$CODE）" test "$CODE" = "304"

echo "== 5. 否證否決：在場「沒看到」>=3 → cancelled =="
curl -s -X POST "$BASE/api/reports" -H 'Content-Type: application/json' -d '{
  "uuid":"e2e-uuid-002","sessionId":"sess-D","type":"other",
  "locationClaim":{"source":"manual","stationId":"G13","confidence":1.0,"timestamp":1}}' > /dev/null
wait_batch
EVT2=$(curl -s "$BASE/api/reports/context?station=G13&type=other" | json "d['events'][0]['id']")
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
