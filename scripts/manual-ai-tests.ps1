#!/usr/bin/env pwsh
# FoodTracker manual AI / OpenRouter tests.
#
# Unlike smoke-test.ps1 (read-only, no external calls), this script deliberately
# exercises every OpenRouter-backed surface in the app so you can confirm the
# key works, has (free) quota, and each feature end-to-end. These calls cost
# tokens and are SLOW on :free models (~60-90s each), so nothing here runs from
# the Stop hook -- run it by hand.
#
# The AI surfaces (see CLAUDE.md). OCR uses the worker's IMAGE model pool; the
# chat surfaces use the backend's TEXT model pool (both driven by the 4-list env
# contract):
#   1. openrouter  -- raw OpenRouter connectivity + key/credits (bypasses the app)
#   2. ocr         -- ocr-service POST /scan   (vision model; OCR_MODEL default)  [needs -Image]
#   3. meal        -- backend POST /api/meals/generate          (chat, text pool)
#   4. tag         -- backend POST /api/foods/auto-tag          (chat, TAG_MODEL|pool)
#   5. merge       -- backend POST /api/foods/merge-suggestions (chat, MERGE_MODEL|pool)
# (FDC nutrition-search is USDA, not OpenRouter, so it's intentionally excluded.)
# NOTE: the old backend sync OCR proxy (POST /api/scan) was removed — all OCR now
# goes through the /staging -> worker -> /inbox queue. ocr-service /scan is the
# per-model executor the worker calls (accepts an optional `model` form field).
#
# Usage (multipart uses curl.exe, so Windows PowerShell 5.1 works; pwsh is fine too):
#   powershell -File scripts/manual-ai-tests.ps1                    # all app tests (skips ocr w/o -Image)
#   powershell -File scripts/manual-ai-tests.ps1 -Test openrouter   # just the key/credits check
#   powershell -File scripts/manual-ai-tests.ps1 -Test ocr -Image C:\path\to\receipt.jpg
#   powershell -File scripts/manual-ai-tests.ps1 -Test meal
#   powershell -File scripts/manual-ai-tests.ps1 -Image .\receipt.jpg   # -Test all + an image

param(
    [ValidateSet('all', 'openrouter', 'ocr', 'meal', 'tag', 'merge')]
    [string]$Test = 'all',
    [string]$Image = '',
    # Override the model used for the raw -Test openrouter check (defaults to MEAL_MODEL from .env).
    [string]$Model = ''
)

$ErrorActionPreference = 'Stop'
$API = 'http://127.0.0.1:4000'
$OCR = 'http://127.0.0.1:8000'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Note($m) { Write-Host "  $m" -ForegroundColor DarkGray }

# --- Read root .env (OPENROUTER_API_KEY + model names) ----------------------
$envFile = Join-Path $RepoRoot '.env'
$envVars = @{}
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*#') { continue }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $envVars[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
        }
    }
}
$apiKey    = $envVars['OPENROUTER_API_KEY']
$ocrModel  = $envVars['OCR_MODEL']
$mealModel = $envVars['MEAL_MODEL']
$tagModel  = if ($envVars['TAG_MODEL']) { $envVars['TAG_MODEL'] } else { $mealModel }
$mergeModel = if ($envVars['MERGE_MODEL']) { $envVars['MERGE_MODEL'] } else { $mealModel }
$baseUrl   = if ($envVars['OPENROUTER_BASE_URL']) { $envVars['OPENROUTER_BASE_URL'] } else { 'https://openrouter.ai/api/v1' }

Info "FoodTracker AI/OpenRouter manual tests"
Note "FREE_IMAGE_MODELS = $($envVars['FREE_IMAGE_MODELS'])"
Note "PAID_IMAGE_MODELS = $($envVars['PAID_IMAGE_MODELS'])"
Note "FREE_TEXT_MODELS  = $($envVars['FREE_TEXT_MODELS'])"
Note "PAID_TEXT_MODELS  = $($envVars['PAID_TEXT_MODELS'])"
Note "USE_PAID_MODELS   = $($envVars['USE_PAID_MODELS'])"
Note "OCR_MODEL (seed)  = $ocrModel"
Note "MEAL_MODEL (seed) = $mealModel"
Note "TAG_MODEL   = $tagModel"
Note "MERGE_MODEL = $mergeModel"
Note "base URL    = $baseUrl"
Write-Host ""

# ===========================================================================
# 1. Raw OpenRouter connectivity + key/credits (no app involved)
# ===========================================================================
function Test-OpenRouter {
    Info "[1] Raw OpenRouter (key + credits, bypasses the app)"
    if (-not $apiKey) { Bad "OPENROUTER_API_KEY missing from $envFile"; return }

    $m = if ($Model) { $Model } else { $mealModel }
    if (-not $m) { $m = 'nvidia/nemotron-nano-12b-v2-vl:free' }
    $headers = @{ Authorization = "Bearer $apiKey"; 'Content-Type' = 'application/json' }

    # 1a. Key + remaining credits (this is how you confirm "no paid credits").
    try {
        $key = Invoke-RestMethod -Uri "$baseUrl/key" -Headers $headers -TimeoutSec 30
        Ok "GET /key ok -- label='$($key.data.label)' usage=$($key.data.usage) limit=$($key.data.limit)"
        if ($null -eq $key.data.limit) { Note "limit=null => free-tier / pay-as-you-go; :free models only (see memory)." }
    } catch { Bad "GET /key failed: $($_.Exception.Message)" }

    # 1b. A tiny real chat completion against the meal model.
    Note "Sending a 1-token chat to '$m' (may take 60-90s on a :free model)..."
    $body = @{
        model    = $m
        messages = @(@{ role = 'user'; content = 'Reply with exactly the word: pong' })
        max_tokens = 10
    } | ConvertTo-Json -Depth 6
    try {
        $r = Invoke-RestMethod -Uri "$baseUrl/chat/completions" -Method Post -Headers $headers -Body $body -TimeoutSec 120
        $content = $r.choices[0].message.content
        Ok "chat/completions ok -- model replied: '$($content.Trim())'"
    } catch {
        Bad "chat/completions failed: $($_.Exception.Message)"
        Note "402 => out of credits (switch to a :free model). 401 => bad key. 429 => rate-limited."
    }
    Write-Host ""
}

# ===========================================================================
# Shared: post an image as multipart via curl.exe (works on PS 5.1 and 7).
# ===========================================================================
function Post-Image($url, $imgPath) {
    $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
    if (-not $curl) { throw "curl.exe not found (needed for multipart upload)" }
    # -s silent, -S show errors, -w write final HTTP status on its own line.
    $out = & $curl -s -S -w "`nHTTP_STATUS:%{http_code}" -X POST -F "image=@$imgPath" $url 2>&1
    $text = ($out -join "`n")
    $status = if ($text -match 'HTTP_STATUS:(\d+)') { $Matches[1] } else { '???' }
    $bodyText = ($text -replace "`nHTTP_STATUS:\d+", '')
    return @{ status = $status; body = $bodyText }
}

function Resolve-Image {
    if (-not $Image) { return $null }
    $p = if ([System.IO.Path]::IsPathRooted($Image)) { $Image } else { Join-Path (Get-Location) $Image }
    if (-not (Test-Path $p)) { Bad "image not found: $p"; return $null }
    return $p
}

# ===========================================================================
# 2. OCR service directly (vision model)
# ===========================================================================
function Test-Ocr {
    Info "[2] OCR service POST $OCR/scan (vision, OCR_MODEL)"
    try { $h = Invoke-RestMethod -Uri "$OCR/health" -TimeoutSec 10; Ok "health ok -- model=$($h.model)" }
    catch { Bad "ocr-service not reachable at $OCR (is the container up? it's loopback-only)"; Write-Host ""; return }

    $img = Resolve-Image
    if (-not $img) { Note "no valid -Image given -> skipping the scan call. Re-run with -Image <receipt-or-tag.jpg>"; Write-Host ""; return }

    Note "Uploading $img (vision models take ~60-90s on :free)..."
    $r = Post-Image "$OCR/scan" $img
    if ($r.status -eq '200') {
        Ok "scan returned 200"
        try {
            $j = $r.body | ConvertFrom-Json
            Note "type=$($j.type) confidence=$($j.confidence) model=$($j.model)"
            if ($j.type -eq 'unknown') { Note "type=unknown is a graceful degrade; raw_text is populated for manual entry." }
        } catch { Note "body: $($r.body.Substring(0, [Math]::Min(400, $r.body.Length)))" }
    } else { Bad "scan returned HTTP $($r.status)"; Note $r.body }
    Write-Host ""
}

# ===========================================================================
# Meal AI drafting (chat model). Auto-picks foods that have nutrition.
# ===========================================================================
function Test-Meal {
    Info "[4] Meal AI POST $API/api/meals/generate (chat, MEAL_MODEL)"
    try { $foods = Invoke-RestMethod -Uri "$API/api/foods" -TimeoutSec 20 }
    catch { Bad "backend not reachable at $API"; Write-Host ""; return }

    $withNutrition = @($foods | Where-Object { $_.nutrition -and $_.nutrition.serving_size -ne $null })
    if ($withNutrition.Count -eq 0) {
        Bad "no catalog foods have nutrition facts -- add nutrition to a few foods first (dashboard food modal / USDA search)."
        Write-Host ""; return
    }
    $ids = @($withNutrition | Select-Object -First 5 | ForEach-Object { $_.id })
    Note "Using food_ids: $($ids -join ', ')  ($($withNutrition.Count) foods have nutrition)"
    $body = @{ food_ids = $ids; targets = @{ calories = 600; protein_g = 40 }; notes = 'quick manual test meal' } | ConvertTo-Json -Depth 6

    Note "Generating (chat model, may take 60-90s on :free)..."
    try {
        $r = Invoke-RestMethod -Uri "$API/api/meals/generate" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
        $d = $r.draft
        Ok "draft returned -- name='$($d.name)' servings=$($d.servings) ingredients=$($d.ingredients.Count)"
        foreach ($ing in $d.ingredients) { Note "  - $($ing.food_name): $($ing.amount) $($ing.amount_unit)" }
    } catch {
        Bad "generate failed: $($_.Exception.Message)"
        Note "502 'no usable ingredients' can happen when a :free model returns junk -- just retry."
    }
    Write-Host ""
}

# ===========================================================================
# 5. Audit auto-tagger (chat model). Needs some foods + at least one tag.
# ===========================================================================
function Test-Tag {
    Info "[5] Auto-tagger POST $API/api/foods/auto-tag (chat, TAG_MODEL|MEAL_MODEL)"
    try {
        $foods = Invoke-RestMethod -Uri "$API/api/foods" -TimeoutSec 20
        $tags  = Invoke-RestMethod -Uri "$API/api/tags" -TimeoutSec 20
    } catch { Bad "backend not reachable at $API"; Write-Host ""; return }

    $foodIds = @($foods | Select-Object -First 5 | ForEach-Object { $_.id })
    $tagIds  = @($tags  | Select-Object -First 8 | ForEach-Object { $_.id })
    if ($foodIds.Count -eq 0) { Bad "catalog is empty -- add some foods first."; Write-Host ""; return }
    if ($tagIds.Count -eq 0)  { Bad "no tags exist -- create a tag on /audit (or POST /api/tags) first."; Write-Host ""; return }

    Note "foods: $($foodIds -join ', ')   tags: $($tagIds -join ', ')"
    $body = @{ food_ids = $foodIds; tag_ids = $tagIds; hint = 'manual test' } | ConvertTo-Json -Depth 6
    Note "Requesting tag suggestions (chat model, may take 60-90s on :free)..."
    try {
        $r = Invoke-RestMethod -Uri "$API/api/foods/auto-tag" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
        Ok "suggestions returned (model=$($r.model)) for $($r.suggestions.Count) foods"
        foreach ($s in $r.suggestions) { Note "  - $($s.food_name): tag_ids [$($s.tag_ids -join ', ')]" }
    } catch { Bad "auto-tag failed: $($_.Exception.Message)" }
    Write-Host ""
}

# ===========================================================================
# 6. Duplicate-finder (chat model). Sends the active catalog for clustering.
# ===========================================================================
function Test-Merge {
    Info "[6] Duplicate-finder POST $API/api/foods/merge-suggestions (chat, MERGE_MODEL)"
    try { $foods = Invoke-RestMethod -Uri "$API/api/foods" -TimeoutSec 20 }
    catch { Bad "backend not reachable at $API"; Write-Host ""; return }

    $ids = @($foods | Select-Object -First 40 | ForEach-Object { $_.id })
    if ($ids.Count -lt 2) { Bad "need at least 2 catalog foods to look for duplicates."; Write-Host ""; return }
    Note "Scanning $($ids.Count) foods for duplicates (chat model, may take 60-90s on :free)..."
    $body = @{ food_ids = $ids } | ConvertTo-Json
    try {
        $r = Invoke-RestMethod -Uri "$API/api/foods/merge-suggestions" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
        Ok "returned (model=$($r.model)) -- $($r.groups.Count) duplicate group(s)"
        foreach ($g in $r.groups) { Note "  - [$($g.reason)] $(( $g.foods | ForEach-Object { $_.name }) -join '  |  ')" }
        if ($r.groups.Count -eq 0) { Note "no duplicates proposed (fine -- or retry; :free models are flaky)." }
    } catch { Bad "merge-suggestions failed: $($_.Exception.Message)" }
    Write-Host ""
}

# --- Dispatch ---------------------------------------------------------------
switch ($Test) {
    'openrouter' { Test-OpenRouter }
    'ocr'        { Test-Ocr }
    'meal'       { Test-Meal }
    'tag'        { Test-Tag }
    'merge'      { Test-Merge }
    'all' {
        Test-OpenRouter
        Test-Ocr
        Test-Meal
        Test-Tag
        Test-Merge
    }
}

Info "Done. Reminder: :free models are slow (~60-90s) and flaky -- a single failure often clears on retry."
