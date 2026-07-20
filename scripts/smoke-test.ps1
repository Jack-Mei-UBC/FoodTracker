#!/usr/bin/env pwsh
# FoodTracker smoke tests - read-only checks against the running stack.
#
# These replace the ad-hoc curl checks used while developing. They hit the
# live backend (127.0.0.1:4000) and frontend (localhost:3000) and assert the
# calorie-tracking / M:N / diary contracts still hold.
#
# KEEP IN SYNC WITH scripts/smoke-test.sh. These two are a hand-synced pair
# (like the other cross-language contracts in CLAUDE.md): this copy is the Stop
# hook, the bash copy is the CI gate. They drifted badly once - CI was asserting
# a strictly weaker contract than this file, so "CI is green" stopped meaning
# "the hook would pass". Add an assertion to both or neither.
#
# An EMPTY catalog is not a regression - it's an unseeded stack, and the
# catalog-dependent assertions skip. Seed with: node frontend/e2e/fixtures/seed.mjs
#
# Wired as a Stop hook in .claude/settings.json so it runs when Claude finishes
# a turn. Designed to be safe to run repeatedly:
#   * read-only - never mutates the database;
#   * skips (exit 0) when the backend isn't running, so it never nags when the
#     stack is simply down;
#   * exits 2 only on a real regression while the stack is up, which surfaces
#     the failure back to Claude.
#
# Run manually any time:  pwsh -File scripts/smoke-test.ps1  (or powershell -File ...)

$API = 'http://127.0.0.1:4000'
$WEB = 'http://localhost:3000'

# Loop guard (debounce): a Stop hook can re-fire quickly; if we ran within the
# last 20s, skip. This prevents tight loops without reading stdin (reading a
# tool-redirected stdin that never closes would hang the script).
$marker = Join-Path $env:TEMP 'foodtracker-smoke.last'
if (Test-Path $marker) {
    $age = (Get-Date) - (Get-Item $marker).LastWriteTime
    if ($age.TotalSeconds -lt 20) { exit 0 }
}
Set-Content -Path $marker -Value (Get-Date).Ticks -ErrorAction SilentlyContinue

function Get-Json($url) { return Invoke-RestMethod -Uri $url -TimeoutSec 20 }

# Gate on backend health. Default: skip (exit 0) when the stack is down — but
# LOUDLY, so a green turn where nothing was verified is at least visible.
# STRICT=1 (the CI mode, same contract as smoke-test.sh) fails instead of skips.
$strict = $env:STRICT -eq '1'
try {
    $health = Get-Json "$API/api/health"
    if ($health.status -ne 'healthy') {
        if ($strict) { Write-Host "smoke: backend unhealthy - FAIL (STRICT)"; exit 2 }
        Write-Host "smoke: !! backend unhealthy - NOTHING WAS VERIFIED (skipping) !!"
        exit 0
    }
} catch {
    if ($strict) { Write-Host "smoke: backend not reachable at $API - FAIL (STRICT)"; exit 2 }
    Write-Host "smoke: !! backend not reachable at $API - NOTHING WAS VERIFIED (skipping) !!"
    exit 0
}

$script:failures = @()
function Check($name, [bool]$ok) {
    if ($ok) { Write-Host "  [PASS] $name" }
    else { Write-Host "  [FAIL] $name"; $script:failures += $name }
}
function Skip($name) { Write-Host "  [SKIP] $name" }
function HasProp($obj, $name) { return ($null -ne $obj) -and ($obj.PSObject.Properties.Name -contains $name) }

Write-Host "FoodTracker smoke tests"
Write-Host "backend $API"

# --- Backend: foods, single-food, M:N join reads ---------------------------
# Note: Invoke-RestMethod returns an object[] for a JSON array; do NOT wrap in
# @() (that nests it). Count via Measure-Object so an empty array (which IRM
# turns into $null) still counts as 0 rather than erroring.
# Catalog shape first — these hold whether or not any rows exist. Each assertion
# gets its own try so one throw can't collapse the whole block into a single
# opaque "foods endpoints reachable" failure (it used to).
$foods = $null
try {
    $foods = Get-Json "$API/api/foods"
    Check "GET /api/foods (no limit) is a plain array, not {foods,total}" (-not (HasProp $foods 'foods'))
} catch { Check "GET /api/foods responds" $false }

try {
    $paged = Get-Json "$API/api/foods?limit=2&offset=0"
    $pagedOk = (HasProp $paged 'foods') -and (HasProp $paged 'total') -and (HasProp $paged 'categories') -and
               (($paged.foods | Measure-Object).Count -le 2)
    Check "GET /api/foods?limit=2 returns {foods,total,categories}" $pagedOk
} catch { Check "GET /api/foods?limit=2 returns {foods,total,categories}" $false }

# Catalog-dependent assertions. An EMPTY catalog is an unseeded stack, not a
# regression, so these SKIP rather than fail. Seed with:
#   node frontend/e2e/fixtures/seed.mjs
# The food id is DISCOVERED, never hard-coded — ids 1/5 don't survive a fresh DB.
$sample = $foods | Select-Object -First 1
if ($null -eq $sample) {
    Skip "catalog is empty - run 'node frontend/e2e/fixtures/seed.mjs' to seed fixtures"
    Skip "food items expose latest_prices + nutrition + aliases"
    Skip "food items expose display_image_id"
    Skip "GET /api/foods/:id returns that food with aliases"
    Skip "GET /api/foods/:id exposes display_image_id"
    Skip "GET /api/foods/:id/prices (join-table read) responds"
} else {
    Check "food items expose latest_prices + nutrition + aliases" (
        (HasProp $sample 'latest_prices') -and (HasProp $sample 'nutrition') -and (HasProp $sample 'aliases'))
    Check "food items expose display_image_id" (HasProp $sample 'display_image_id')

    try {
        $f1 = Get-Json "$API/api/foods/$($sample.id)"
        Check "GET /api/foods/:id returns that food with aliases" (($f1.id -eq $sample.id) -and (HasProp $f1 'aliases'))
        Check "GET /api/foods/:id exposes display_image_id" (HasProp $f1 'display_image_id')
    } catch {
        Check "GET /api/foods/:id returns that food with aliases" $false
        Check "GET /api/foods/:id exposes display_image_id" $false
    }

    # M:N: a food's prices are read through the food_prices join table. Getting
    # here without an exception means the join query didn't 500.
    try {
        Get-Json "$API/api/foods/$($sample.id)/prices" | Out-Null
        Check "GET /api/foods/:id/prices (join-table read) responds" $true
    } catch { Check "GET /api/foods/:id/prices (join-table read) responds" $false }
}

# --- Backend: diary totals include macro + micronutrient sums ---------------
try {
    $diary = Get-Json "$API/api/diary"
    $microOk = (HasProp $diary.totals 'calcium_mg') -and (HasProp $diary.totals 'vitamin_d_mcg') -and
               (HasProp $diary.totals 'sodium_mg') -and (HasProp $diary.totals 'calories')
    Check "GET /api/diary totals include micronutrient sums" $microOk
    Check "GET /api/diary returns goals" (HasProp $diary 'goals')
} catch { Check "diary endpoint reachable" $false }

# --- Backend: goals + efficiency --------------------------------------------
try { $goals = Get-Json "$API/api/goals"; Check "GET /api/goals (single row)" ($goals.id -eq 1) }
catch { Check "goals endpoint reachable" $false }

try { Get-Json "$API/api/prices/efficiency" | Out-Null; Check "GET /api/prices/efficiency responds" $true }
catch { Check "efficiency endpoint reachable" $false }

# --- Backend: Flipp scrape endpoint contract ---------------------------------
# Unknown store must 404 before anything is queued (read-only: no job created).
try {
    Invoke-RestMethod -Uri "$API/api/scrape/999999" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
    Check "POST /api/scrape/:storeId rejects unknown store (404)" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/scrape/:storeId rejects unknown store (404)" ($code -eq 404)
}

# --- Backend: cocowest scrape endpoint contract -------------------------------
# Unknown store must 404 before anything is queued (read-only: no job created).
try {
    Invoke-RestMethod -Uri "$API/api/scrape-cocowest" -Method Post -ContentType 'application/json' -Body '{"store_id":999999,"url":"https://cocowest.ca/x"}' -TimeoutSec 10 | Out-Null
    Check "POST /api/scrape-cocowest rejects unknown store (404)" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/scrape-cocowest rejects unknown store (404)" ($code -eq 404)
}

# --- Backend: scrape-jobs progress endpoint ----------------------------------
# The progress dashboard reads this; it must return a JSON array (possibly empty).
try {
    $sjobs = Get-Json "$API/api/scrape-jobs"
    Check "GET /api/scrape-jobs responds (array)" (($null -eq $sjobs) -or ($sjobs -is [array]) -or ($sjobs.PSObject.Properties.Name -contains 'id'))
} catch { Check "GET /api/scrape-jobs responds (array)" $false }

# --- Backend: images endpoint contract (read-only: rejected before any write) -
# The crop-before-OCR flow POSTs the original then the crop (with original_image_id)
# to this endpoint. A no-file POST must 400 before multer/registerImage touch disk
# or the DB, so this exercises the endpoint without mutating anything.
try {
    Invoke-RestMethod -Uri "$API/api/images" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
    Check "POST /api/images rejects missing file (400)" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/images rejects missing file (400)" ($code -eq 400)
}

# --- Backend: meal plans (read-only contract checks) -------------------------
# GET list must return an array whose items carry computed totals/per-serving;
# validation must reject a nameless meal and an ingredient-less AI generate.
try {
    $mealsList = Get-Json "$API/api/meals"
    $isArr = ($null -eq $mealsList) -or ($mealsList -is [array]) -or (HasProp $mealsList 'id')
    Check "GET /api/meals responds (array)" $isArr
    $m1 = $mealsList | Select-Object -First 1
    if ($m1) {
        Check "meal items expose totals + per_serving" ((HasProp $m1 'totals') -and (HasProp $m1 'per_serving'))
    }
} catch { Check "GET /api/meals responds (array)" $false }

try {
    Invoke-RestMethod -Uri "$API/api/meals" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
    Check "POST /api/meals rejects missing name (400)" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/meals rejects missing name (400)" ($code -eq 400)
}

try {
    Invoke-RestMethod -Uri "$API/api/meals/generate" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
    Check "POST /api/meals/generate rejects empty food_ids (400)" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/meals/generate rejects empty food_ids (400)" ($code -eq 400)
}

try {
    Invoke-RestMethod -Uri "$API/api/meals/999999" -TimeoutSec 10 | Out-Null
    Check "GET /api/meals/:id 404s on unknown meal" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "GET /api/meals/:id 404s on unknown meal" ($code -eq 404)
}

# --- Backend: catalog audit (read-only contract checks) ----------------------
# The /audit page bulk-archives non-food. Archived foods must be hidden from the
# default catalog read and listed by ?deleted=1; bad bulk bodies must 400 before
# any row is touched, so these are read-only.
try {
    $arch = Get-Json "$API/api/foods?deleted=1"
    Check "GET /api/foods?deleted=1 responds (archive list)" (($null -eq $arch) -or ($arch -is [array]) -or (HasProp $arch 'id'))
} catch { Check "GET /api/foods?deleted=1 responds (archive list)" $false }

foreach ($body in @('{"ids":[],"action":"archive"}', '{"ids":[1],"action":"bogus"}', '{"ids":[1],"action":"category"}')) {
    try {
        Invoke-RestMethod -Uri "$API/api/foods/bulk" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 10 | Out-Null
        Check "POST /api/foods/bulk rejects $body (400)" $false
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        Check "POST /api/foods/bulk rejects $body (400)" ($code -eq 400)
    }
}

# --- Backend: save-USDA-candidate-to-catalog validation (read-only) ----------
# POST /api/foods/from-nutrition creates a food+nutrition with no price. A body
# missing calories must 400 before any row is written, so this is read-only.
try {
    Invoke-RestMethod -Uri "$API/api/foods/from-nutrition" -Method Post -ContentType 'application/json' -Body '{"name":"x","serving_size":10,"serving_unit":"g"}' -TimeoutSec 10 | Out-Null
    Check "POST /api/foods/from-nutrition rejects missing calories (400)" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/foods/from-nutrition rejects missing calories (400)" ($code -eq 400)
}

# --- Backend: catalog-merge validation (read-only) ---------------------------
# The merge + duplicate-finder endpoints must 400 on a bad request before touching
# any row, so these assertions never mutate the catalog.
foreach ($case in @(
    @{ url = "$API/api/foods/merge"; body = '{"source_ids":[1]}'; name = 'POST /api/foods/merge rejects missing target_id (400)' },
    @{ url = "$API/api/foods/merge"; body = '{"target_id":1,"source_ids":[]}'; name = 'POST /api/foods/merge rejects empty source_ids (400)' },
    @{ url = "$API/api/foods/merge-suggestions"; body = '{"food_ids":[]}'; name = 'POST /api/foods/merge-suggestions rejects empty food_ids (400)' }
)) {
    try {
        Invoke-RestMethod -Uri $case.url -Method Post -ContentType 'application/json' -Body $case.body -TimeoutSec 10 | Out-Null
        Check $case.name $false
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        Check $case.name ($code -eq 400)
    }
}

# --- Backend: budget / spending tracking (read-only contract checks) ---------
try {
    $sum = Get-Json "$API/api/receipts/summary"
    $sumOk = (HasProp $sum 'spent') -and (HasProp $sum 'by_store') -and (HasProp $sum 'by_month') -and (HasProp $sum 'monthly_budget')
    Check "GET /api/receipts/summary returns spend + breakdowns + budget" $sumOk
} catch { Check "GET /api/receipts/summary responds" $false }

try {
    $rcpts = Get-Json "$API/api/receipts"
    Check "GET /api/receipts responds (array)" (($null -eq $rcpts) -or ($rcpts -is [array]) -or (HasProp $rcpts 'id'))
} catch { Check "GET /api/receipts responds (array)" $false }

try { $bud = Get-Json "$API/api/budget"; Check "GET /api/budget returns monthly_budget" (HasProp $bud 'monthly_budget') }
catch { Check "GET /api/budget responds" $false }

# Validation: a negative total must 400 before any row is written (read-only).
try {
    Invoke-RestMethod -Uri "$API/api/receipts" -Method Post -ContentType 'application/json' -Body '{"total":-1}' -TimeoutSec 10 | Out-Null
    Check "POST /api/receipts rejects negative total (400)" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/receipts rejects negative total (400)" ($code -eq 400)
}

# --- Backend: scan job detail + re-stage contract (read-only) ----------------
# The inbox needs `original_image_id` (to show the crop beside its uncropped
# original) and `attempts` (the per-model OCR trace) on the detail endpoint.
try {
    $sjobs = Get-Json "$API/api/scan-jobs"
    $firstJob = $sjobs | Select-Object -First 1
    if ($firstJob) {
        $detail = Get-Json "$API/api/scan-jobs/$($firstJob.id)"
        $detailOk = (HasProp $detail 'original_image_id') -and (HasProp $detail 'attempts')
        Check "GET /api/scan-jobs/:id exposes original_image_id + attempts" $detailOk
    } else {
        Write-Host "  [SKIP] no scan jobs to inspect"
    }
} catch { Check "GET /api/scan-jobs/:id responds" $false }

# Re-stage: a job that doesn't exist must 404 (no row is touched by this call).
try {
    Invoke-RestMethod -Uri "$API/api/scan-jobs/99999999/restage" -Method Post -TimeoutSec 10 | Out-Null
    Check "POST /api/scan-jobs/:id/restage 404s on unknown id" $false
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    Check "POST /api/scan-jobs/:id/restage 404s on unknown id" ($code -eq 404)
}

# --- Backend: app settings + sale expiry (read-only contract checks) ---------
try { $st = Get-Json "$API/api/settings"; Check "GET /api/settings returns default_sale_days" (HasProp $st 'default_sale_days') }
catch { Check "GET /api/settings responds" $false }

foreach ($bad in @('{"default_sale_days":0}', '{"default_sale_days":999}', '{"default_sale_days":"soon"}')) {
    try {
        Invoke-RestMethod -Uri "$API/api/settings" -Method Put -ContentType 'application/json' -Body $bad -TimeoutSec 10 | Out-Null
        Check "PUT /api/settings rejects $bad (400)" $false
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        Check "PUT /api/settings rejects $bad (400)" ($code -eq 400)
    }
}

# A food's current prices must never include a sale that has already ended — this
# is the invariant behind ACTIVE_PRICE_SQL, checked against whatever is in the DB.
try {
    $all = Get-Json "$API/api/foods"
    $today = (Get-Date).Date
    $leaked = @()
    foreach ($f in $all) {
        foreach ($p in @($f.latest_prices)) {
            if ($null -ne $p -and $p.is_sale -and $null -ne $p.sale_ends_at) {
                if ([datetime]$p.sale_ends_at -lt $today) { $leaked += $f.name }
            }
        }
    }
    Check "GET /api/foods hides expired sale prices" ($leaked.Count -eq 0)
    if ($leaked.Count -gt 0) { Write-Host ("         leaked: {0}" -f (($leaked | Select-Object -Unique) -join ', ')) }
} catch { Check "GET /api/foods expired-sale check ran" $false }

# --- Backend: USDA FoodData Central proxy (external; soft check) -------------
try {
    $cands = Get-Json "$API/api/nutrition-search?q=milk"
    $first = $cands | Select-Object -First 1
    if ($first -and $null -ne $first.calories) { Write-Host "  [PASS] GET /api/nutrition-search returns USDA candidates" }
    else { Write-Host "  [WARN] USDA search returned no candidates (external API - not failing)" }
} catch { Write-Host "  [WARN] USDA search unavailable (external API / FDC_API_KEY - not failing)" }

# --- Frontend pages (soft-gated on the web server being up) -----------------
$webUp = $true
try { Invoke-WebRequest -UseBasicParsing -Uri $WEB -TimeoutSec 8 | Out-Null } catch { $webUp = $false }
if ($webUp) {
    foreach ($path in @('/', '/diary', '/history', '/inbox', '/scanner', '/scrapes', '/meals', '/staging', '/budget', '/audit', '/settings')) {
        $ok = $false
        try { $ok = (Invoke-WebRequest -UseBasicParsing -Uri "$WEB$path" -TimeoutSec 12).StatusCode -eq 200 } catch { }
        Check "GET $WEB$path -> 200" $ok
    }
} else {
    Write-Host "  [SKIP] frontend not reachable at $WEB"
}

Write-Host ""
if ($script:failures.Count -gt 0) {
    Write-Host ("SMOKE TESTS FAILED ({0}): {1}" -f $script:failures.Count, ($script:failures -join ', '))
    exit 2
}
Write-Host "All smoke tests passed."
exit 0
