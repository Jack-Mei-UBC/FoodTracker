#!/usr/bin/env bash
# FoodTracker smoke tests (cross-platform / CI edition).
#
# Read-only checks against the running stack — the same contracts the PowerShell
# Stop hook (scripts/smoke-test.ps1) asserts locally, in a portable form for CI
# and non-Windows machines. Gates on backend health; exits non-zero on a real
# regression. Set STRICT=1 to fail (instead of skip) when the backend is down —
# CI sets this so a stack that never boots is a failure, not a pass.
#
# Usage:  bash scripts/smoke-test.sh
set -uo pipefail

API="${API:-http://127.0.0.1:4000}"
WEB="${WEB:-http://localhost:3000}"
STRICT="${STRICT:-0}"

# Python 3 interpreter (python3 on CI/Linux, python on Git Bash/Windows).
PY="$(command -v python3 || command -v python || true)"

fail=0
pass()  { echo "  [PASS] $1"; }
failc() { echo "  [FAIL] $1"; fail=1; }
warn()  { echo "  [WARN] $1"; }

# JSON assertion: pipe a URL's body into a python predicate returning 0/1.
assert_json() { # name url python_expr(d)->bool
  local name="$1" url="$2" expr="$3"
  if [ -z "$PY" ]; then warn "$name (no python interpreter — skipped)"; return; fi
  if curl -fsS "$url" 2>/dev/null | "$PY" -c "import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if ($expr) else 1)"; then pass "$name"; else failc "$name"; fi
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

echo "FoodTracker smoke tests"
echo "backend $API"

# Gate on backend health.
if ! curl -fsS "$API/api/health" >/dev/null 2>&1; then
  if [ "$STRICT" = "1" ]; then echo "backend not reachable at $API — FAIL (STRICT)"; exit 2; fi
  echo "backend not reachable at $API — skipping"; exit 0
fi

# Backend: foods, single-food, M:N join reads
assert_json "GET /api/foods returns items" \
  "$API/api/foods" "isinstance(d,list) and len(d)>0"
assert_json "GET /api/foods (no limit) is a plain array, not {foods,total}" \
  "$API/api/foods" "isinstance(d,list)"
assert_json "food items expose latest_prices + nutrition + aliases" \
  "$API/api/foods" "all(k in d[0] for k in ('latest_prices','nutrition','aliases'))"
assert_json "food items expose display_image_id" \
  "$API/api/foods" "'display_image_id' in d[0]"
assert_json "GET /api/foods/:id returns that food with aliases" \
  "$API/api/foods/1" "d.get('id')==1 and 'aliases' in d"
assert_json "GET /api/foods/:id exposes display_image_id" \
  "$API/api/foods/1" "'display_image_id' in d"
[ "$(http_code "$API/api/foods/5/prices")" = "200" ] \
  && pass "GET /api/foods/:id/prices (join-table read) responds" \
  || failc "GET /api/foods/:id/prices (join-table read) responds"
assert_json "GET /api/foods?limit=2 returns {foods,total,categories}" \
  "$API/api/foods?limit=2&offset=0" "all(k in d for k in ('foods','total','categories')) and len(d['foods'])<=2"

# Backend: diary totals include macro + micronutrient sums
assert_json "GET /api/diary totals include micronutrient sums" \
  "$API/api/diary" "all(k in d['totals'] for k in ('calories','sodium_mg','calcium_mg','vitamin_d_mcg'))"
assert_json "GET /api/diary returns goals" \
  "$API/api/diary" "'goals' in d"

# Backend: goals + efficiency
assert_json "GET /api/goals (single row)" "$API/api/goals" "d.get('id')==1"
[ "$(http_code "$API/api/prices/efficiency")" = "200" ] \
  && pass "GET /api/prices/efficiency responds" \
  || failc "GET /api/prices/efficiency responds"

# Backend: Flipp scrape endpoint contract — unknown store 404s before queuing.
scrape_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$API/api/scrape/999999" 2>/dev/null || echo 000)"
[ "$scrape_code" = "404" ] \
  && pass "POST /api/scrape/:storeId rejects unknown store (404)" \
  || failc "POST /api/scrape/:storeId rejects unknown store (404)"

# Backend: cocowest scrape endpoint contract — unknown store 404s before queuing.
cocowest_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"store_id":999999,"url":"https://cocowest.ca/x"}' "$API/api/scrape-cocowest" 2>/dev/null || echo 000)"
[ "$cocowest_code" = "404" ] \
  && pass "POST /api/scrape-cocowest rejects unknown store (404)" \
  || failc "POST /api/scrape-cocowest rejects unknown store (404)"

# Backend: scrape-jobs progress endpoint (the /scrapes dashboard reads this).
assert_json "GET /api/scrape-jobs responds (array)" \
  "$API/api/scrape-jobs" "isinstance(d,list)"

# Backend: meal plans (read-only contract checks).
assert_json "GET /api/meals responds (array)" "$API/api/meals" "isinstance(d,list)"

meal_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$API/api/meals" 2>/dev/null || echo 000)"
[ "$meal_code" = "400" ] \
  && pass "POST /api/meals rejects missing name (400)" \
  || failc "POST /api/meals rejects missing name (400)"

gen_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$API/api/meals/generate" 2>/dev/null || echo 000)"
[ "$gen_code" = "400" ] \
  && pass "POST /api/meals/generate rejects empty food_ids (400)" \
  || failc "POST /api/meals/generate rejects empty food_ids (400)"

[ "$(http_code "$API/api/meals/999999")" = "404" ] \
  && pass "GET /api/meals/:id 404s on unknown meal" \
  || failc "GET /api/meals/:id 404s on unknown meal"

# Backend: USDA proxy (external + needs FDC_API_KEY; soft check)
usda_code="$(http_code "$API/api/nutrition-search?q=milk")"
if [ "$usda_code" = "200" ]; then pass "GET /api/nutrition-search returns USDA candidates"
else warn "USDA search unavailable (code $usda_code — external API / FDC_API_KEY; not failing)"; fi

# Frontend pages (soft-gated on the web server being up)
if [ "$(http_code "$WEB/")" = "200" ]; then
  for path in "/" "/diary" "/history" "/inbox" "/scrapes" "/meals"; do
    [ "$(http_code "$WEB$path")" = "200" ] \
      && pass "GET $WEB$path -> 200" \
      || failc "GET $WEB$path -> 200"
  done
else
  warn "frontend not reachable at $WEB — skipping page checks"
fi

echo
if [ "$fail" -ne 0 ]; then echo "SMOKE TESTS FAILED"; exit 2; fi
echo "All smoke tests passed."
