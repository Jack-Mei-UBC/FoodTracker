#!/usr/bin/env bash
# FoodTracker smoke tests (cross-platform / CI edition).
#
# Read-only checks against the running stack — the same contracts the PowerShell
# Stop hook (scripts/smoke-test.ps1) asserts locally, in a portable form for CI
# and non-Windows machines. Gates on backend health; exits non-zero on a real
# regression. Set STRICT=1 to fail (instead of skip) when the backend is down —
# CI sets this so a stack that never boots is a failure, not a pass.
#
# KEEP IN SYNC WITH scripts/smoke-test.ps1. These two are a hand-synced pair
# (like the other cross-language contracts in CLAUDE.md): the PowerShell copy is
# the Stop hook, this one is the CI gate. They drifted badly once — CI was
# asserting a strictly weaker contract than the local hook, so "CI is green"
# stopped meaning "the hook would pass". Add an assertion to both or neither.
#
# An EMPTY catalog is not a regression — it's an unseeded stack. Catalog-
# dependent assertions SKIP in that case. Seed with:
#   node frontend/e2e/fixtures/seed.mjs
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
skip()  { echo "  [SKIP] $1"; }

# JSON assertion: pipe a URL's body into a python predicate returning 0/1.
# Any exception inside the predicate counts as a failure, not a crash.
assert_json() { # name url python_expr(d)->bool
  local name="$1" url="$2" expr="$3"
  if [ -z "$PY" ]; then warn "$name (no python interpreter — skipped)"; return; fi
  if curl -fsS "$url" 2>/dev/null | "$PY" -c "import json,sys
try:
    d = json.load(sys.stdin)
    ok = bool($expr)
except Exception:
    sys.exit(1)
sys.exit(0 if ok else 1)"; then pass "$name"; else failc "$name"; fi
}

# JSON assertion taking a full python script (for multi-line logic). The script
# reads the body from stdin as `d` and calls ok(True/False).
assert_py() { # name url python_script
  local name="$1" url="$2" script="$3"
  if [ -z "$PY" ]; then warn "$name (no python interpreter — skipped)"; return; fi
  if curl -fsS "$url" 2>/dev/null | "$PY" -c "import json,sys,datetime
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
$script" ; then pass "$name"; else failc "$name"; fi
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

post_code() { # url json_body
  curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d "$2" "$1" 2>/dev/null || echo 000
}

put_code() { # url json_body
  curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
    -d "$2" "$1" 2>/dev/null || echo 000
}

check_code() { # name expected actual
  [ "$3" = "$2" ] && pass "$1" || failc "$1 (got $3)"
}

echo "FoodTracker smoke tests"
echo "backend $API"

# Gate on backend health.
if ! curl -fsS "$API/api/health" >/dev/null 2>&1; then
  if [ "$STRICT" = "1" ]; then echo "backend not reachable at $API — FAIL (STRICT)"; exit 2; fi
  echo "backend not reachable at $API — skipping"; exit 0
fi

# --- Catalog shape (independent of whether the catalog has rows) -------------
assert_json "GET /api/foods (no limit) is a plain array, not {foods,total}" \
  "$API/api/foods" "isinstance(d,list)"
assert_json "GET /api/foods?limit=2 returns {foods,total,categories}" \
  "$API/api/foods?limit=2&offset=0" "all(k in d for k in ('foods','total','categories')) and len(d['foods'])<=2"

# Discover a real food id rather than assuming 1/5 exist. An empty catalog means
# an unseeded stack, so the catalog-dependent block SKIPs instead of failing.
FOOD_ID=""
if [ -n "$PY" ]; then
  FOOD_ID="$(curl -fsS "$API/api/foods" 2>/dev/null | "$PY" -c "import json,sys
try:
    d = json.load(sys.stdin)
    print(d[0]['id'] if isinstance(d,list) and d else '')
except Exception:
    print('')" 2>/dev/null)"
fi

if [ -z "$FOOD_ID" ]; then
  skip "catalog is empty — run 'node frontend/e2e/fixtures/seed.mjs' to seed fixtures"
  skip "food items expose latest_prices + nutrition + aliases"
  skip "food items expose display_image_id"
  skip "GET /api/foods/:id returns that food with aliases"
  skip "GET /api/foods/:id exposes display_image_id"
  skip "GET /api/foods/:id/prices (join-table read) responds"
  skip "GET /api/foods hides expired sale prices"
else
  assert_json "food items expose latest_prices + nutrition + aliases" \
    "$API/api/foods" "all(k in d[0] for k in ('latest_prices','nutrition','aliases'))"
  assert_json "food items expose display_image_id" \
    "$API/api/foods" "'display_image_id' in d[0]"
  assert_json "GET /api/foods/:id returns that food with aliases" \
    "$API/api/foods/$FOOD_ID" "d.get('id')==$FOOD_ID and 'aliases' in d"
  assert_json "GET /api/foods/:id exposes display_image_id" \
    "$API/api/foods/$FOOD_ID" "'display_image_id' in d"
  check_code "GET /api/foods/:id/prices (join-table read) responds" 200 \
    "$(http_code "$API/api/foods/$FOOD_ID/prices")"

  # A food's CURRENT prices must never include a sale that has already ended —
  # the invariant behind ACTIVE_PRICE_SQL.
  assert_py "GET /api/foods hides expired sale prices" "$API/api/foods" "
today = datetime.date.today().isoformat()
leaked = [f.get('name') for f in d
          for p in (f.get('latest_prices') or [])
          if p and p.get('is_sale') and p.get('sale_ends_at')
          and str(p['sale_ends_at'])[:10] < today]
if leaked:
    print('         leaked: ' + ', '.join(sorted(set(leaked))), file=sys.stderr)
sys.exit(1 if leaked else 0)"
fi

# --- Archive side of the catalog --------------------------------------------
assert_json "GET /api/foods?deleted=1 responds (archive list)" \
  "$API/api/foods?deleted=1" "isinstance(d,list)"

# --- Diary totals include macro + micronutrient sums -------------------------
assert_json "GET /api/diary totals include micronutrient sums" \
  "$API/api/diary" "all(k in d['totals'] for k in ('calories','sodium_mg','calcium_mg','vitamin_d_mcg'))"
assert_json "GET /api/diary returns goals" "$API/api/diary" "'goals' in d"

# --- Goals + efficiency ------------------------------------------------------
assert_json "GET /api/goals (single row)" "$API/api/goals" "d.get('id')==1"
check_code "GET /api/prices/efficiency responds" 200 "$(http_code "$API/api/prices/efficiency")"

# --- Scrape endpoint contracts (unknown store 404s before anything queues) ----
check_code "POST /api/scrape/:storeId rejects unknown store (404)" 404 \
  "$(post_code "$API/api/scrape/999999" '{}')"
check_code "POST /api/scrape-cocowest rejects unknown store (404)" 404 \
  "$(post_code "$API/api/scrape-cocowest" '{"store_id":999999,"url":"https://cocowest.ca/x"}')"
assert_json "GET /api/scrape-jobs responds (array)" "$API/api/scrape-jobs" "isinstance(d,list)"

# --- Images endpoint (a no-file POST must 400 before touching disk or DB) -----
check_code "POST /api/images rejects missing file (400)" 400 \
  "$(post_code "$API/api/images" '{}')"

# --- Meal plans --------------------------------------------------------------
assert_json "GET /api/meals responds (array)" "$API/api/meals" "isinstance(d,list)"
assert_py "meal items expose totals + per_serving" "$API/api/meals" "
if not d:
    sys.exit(0)  # no meals seeded — shape can't be checked, not a regression
sys.exit(0 if all(k in d[0] for k in ('totals','per_serving')) else 1)"
check_code "POST /api/meals rejects missing name (400)" 400 "$(post_code "$API/api/meals" '{}')"
check_code "POST /api/meals/generate rejects empty food_ids (400)" 400 \
  "$(post_code "$API/api/meals/generate" '{}')"
check_code "GET /api/meals/:id 404s on unknown meal" 404 "$(http_code "$API/api/meals/999999")"

# --- Catalog audit: bulk validation (400s before any row is touched) ----------
for body in '{"ids":[],"action":"archive"}' '{"ids":[1],"action":"bogus"}' '{"ids":[1],"action":"category"}'; do
  check_code "POST /api/foods/bulk rejects $body (400)" 400 "$(post_code "$API/api/foods/bulk" "$body")"
done

# --- Save-USDA-candidate validation ------------------------------------------
check_code "POST /api/foods/from-nutrition rejects missing calories (400)" 400 \
  "$(post_code "$API/api/foods/from-nutrition" '{"name":"x","serving_size":10,"serving_unit":"g"}')"

# --- Catalog merge validation -------------------------------------------------
check_code "POST /api/foods/merge rejects missing target_id (400)" 400 \
  "$(post_code "$API/api/foods/merge" '{"source_ids":[1]}')"
check_code "POST /api/foods/merge rejects empty source_ids (400)" 400 \
  "$(post_code "$API/api/foods/merge" '{"target_id":1,"source_ids":[]}')"
check_code "POST /api/foods/merge-suggestions rejects empty food_ids (400)" 400 \
  "$(post_code "$API/api/foods/merge-suggestions" '{"food_ids":[]}')"

# --- Budget / spending --------------------------------------------------------
assert_json "GET /api/receipts/summary returns spend + breakdowns + budget" \
  "$API/api/receipts/summary" "all(k in d for k in ('spent','by_store','by_month','monthly_budget'))"
assert_json "GET /api/receipts responds (array)" "$API/api/receipts" "isinstance(d,list)"
assert_json "GET /api/budget returns monthly_budget" "$API/api/budget" "'monthly_budget' in d"
check_code "POST /api/receipts rejects negative total (400)" 400 \
  "$(post_code "$API/api/receipts" '{"total":-1}')"

# --- Scan jobs: detail contract + re-stage ------------------------------------
SCAN_ID=""
if [ -n "$PY" ]; then
  SCAN_ID="$(curl -fsS "$API/api/scan-jobs" 2>/dev/null | "$PY" -c "import json,sys
try:
    d = json.load(sys.stdin)
    print(d[0]['id'] if isinstance(d,list) and d else '')
except Exception:
    print('')" 2>/dev/null)"
fi
if [ -z "$SCAN_ID" ]; then
  skip "GET /api/scan-jobs/:id exposes original_image_id + attempts (no scan jobs)"
else
  assert_json "GET /api/scan-jobs/:id exposes original_image_id + attempts" \
    "$API/api/scan-jobs/$SCAN_ID" "all(k in d for k in ('original_image_id','attempts'))"
fi
check_code "POST /api/scan-jobs/:id/restage 404s on unknown id" 404 \
  "$(post_code "$API/api/scan-jobs/99999999/restage" '{}')"

# scan_runs: the append-only per-model-call history (never cleared by restage/
# reprocess, unlike scan_jobs.result/attempts) — read-only contract check.
if [ -z "$SCAN_ID" ]; then
  skip "GET /api/scan-jobs/:id/runs responds (array) (no scan jobs)"
else
  assert_json "GET /api/scan-jobs/:id/runs responds (array)" \
    "$API/api/scan-jobs/$SCAN_ID/runs" "isinstance(d,list)"
fi
check_code "POST /api/scan-jobs/:id/reprocess 404s on unknown id" 404 \
  "$(post_code "$API/api/scan-jobs/99999999/reprocess" '{}')"

# --- App settings + sale expiry defaults --------------------------------------
assert_json "GET /api/settings returns default_sale_days" \
  "$API/api/settings" "'default_sale_days' in d"
for bad in '{"default_sale_days":0}' '{"default_sale_days":999}' '{"default_sale_days":"soon"}'; do
  check_code "PUT /api/settings rejects $bad (400)" 400 "$(put_code "$API/api/settings" "$bad")"
done

# --- USDA proxy (external + needs FDC_API_KEY; soft check) --------------------
usda_code="$(http_code "$API/api/nutrition-search?q=milk")"
if [ "$usda_code" = "200" ]; then pass "GET /api/nutrition-search returns USDA candidates"
else warn "USDA search unavailable (code $usda_code — external API / FDC_API_KEY; not failing)"; fi

# --- Frontend pages (soft-gated on the web server being up) -------------------
if [ "$(http_code "$WEB/")" = "200" ]; then
  for path in "/" "/diary" "/history" "/inbox" "/scrapes" "/meals" "/staging" "/budget" "/audit" "/settings"; do
    check_code "GET $WEB$path -> 200" 200 "$(http_code "$WEB$path")"
  done
else
  warn "frontend not reachable at $WEB — skipping page checks"
fi

echo
if [ "$fail" -ne 0 ]; then echo "SMOKE TESTS FAILED"; exit 2; fi
echo "All smoke tests passed."
