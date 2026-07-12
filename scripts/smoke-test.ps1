#!/usr/bin/env pwsh
# FoodTracker smoke tests - read-only checks against the running stack.
#
# These replace the ad-hoc curl checks used while developing. They hit the
# live backend (127.0.0.1:4000) and frontend (localhost:3000) and assert the
# calorie-tracking / M:N / diary contracts still hold.
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

# Gate on backend health; if it's not up, skip quietly.
try {
    $health = Get-Json "$API/api/health"
    if ($health.status -ne 'healthy') { Write-Host "smoke: backend unhealthy - skipping"; exit 0 }
} catch {
    Write-Host "smoke: backend not reachable at $API - skipping"
    exit 0
}

$script:failures = @()
function Check($name, [bool]$ok) {
    if ($ok) { Write-Host "  [PASS] $name" }
    else { Write-Host "  [FAIL] $name"; $script:failures += $name }
}
function HasProp($obj, $name) { return ($null -ne $obj) -and ($obj.PSObject.Properties.Name -contains $name) }

Write-Host "FoodTracker smoke tests"
Write-Host "backend $API"

# --- Backend: foods, single-food, M:N join reads ---------------------------
# Note: Invoke-RestMethod returns an object[] for a JSON array; do NOT wrap in
# @() (that nests it). Count via Measure-Object so an empty array (which IRM
# turns into $null) still counts as 0 rather than erroring.
try {
    $foods = Get-Json "$API/api/foods"
    Check "GET /api/foods returns items" (($foods | Measure-Object).Count -gt 0)
    $sample = $foods | Select-Object -First 1
    Check "food items expose latest_prices + nutrition + aliases" (
        (HasProp $sample 'latest_prices') -and (HasProp $sample 'nutrition') -and (HasProp $sample 'aliases'))

    $f1 = Get-Json "$API/api/foods/1"
    Check "GET /api/foods/:id returns that food with aliases" (($f1.id -eq 1) -and (HasProp $f1 'aliases'))

    # M:N: a food's prices are read through the food_prices join table. Getting
    # here without an exception means the join query didn't 500.
    Get-Json "$API/api/foods/5/prices" | Out-Null
    Check "GET /api/foods/:id/prices (join-table read) responds" $true
} catch { Check "foods endpoints reachable" $false }

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
    foreach ($path in @('/', '/diary', '/history', '/inbox', '/scrapes', '/meals')) {
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
