#!/usr/bin/env pwsh
# Stop hook #2: per-service TypeScript check — wired in .claude/settings.json
# alongside smoke-test.ps1.
#
# Runs `tsc --noEmit` for each Node service (backend / worker / frontend) that
# has UNCOMMITTED changes, so a turn can't end with a type error in a file the
# agent just edited. Services without dirty files are skipped, so a clean repo
# costs nothing; docker isn't needed (uses the host node_modules).
#
# Same conventions as smoke-test.ps1:
#   * does NOT read stdin (see the caveat there);
#   * a 20s marker debounce prevents Stop-hook refire loops — a genuine fix
#     cycle takes longer than 20s, so real re-checks still happen;
#   * exit 2 feeds the tsc output back to the agent; exit 0 otherwise.

$marker = Join-Path $env:TEMP 'foodtracker-typecheck.last'
if (Test-Path $marker) {
    $age = (Get-Date) - (Get-Item $marker).LastWriteTime
    if ($age.TotalSeconds -lt 20) { exit 0 }
}
Set-Content -Path $marker -Value (Get-Date).Ticks -ErrorAction SilentlyContinue

$root = $env:CLAUDE_PROJECT_DIR
if (-not $root) { $root = (Get-Location).Path }

$failures = @()
foreach ($svc in @('backend', 'worker', 'frontend')) {
    $dirty = git -C $root status --porcelain -- "$svc/src" "$svc/e2e" "$svc/tsconfig.json" 2>$null
    if (-not $dirty) { continue }

    $tsc = Join-Path $root "$svc/node_modules/.bin/tsc.cmd"
    if (-not (Test-Path $tsc)) { continue }   # no host install - docker-only setup, skip

    Write-Host "typecheck: $svc (dirty)..."
    $out = & $tsc --noEmit -p (Join-Path $root $svc) 2>&1
    if ($LASTEXITCODE -ne 0) {
        $failures += "== tsc: $svc =="
        $failures += ($out | Out-String)
    }
}

if ($failures.Count -gt 0) {
    [Console]::Error.WriteLine("TypeScript errors in edited services - fix before finishing:`n" + ($failures -join "`n"))
    exit 2
}
exit 0
