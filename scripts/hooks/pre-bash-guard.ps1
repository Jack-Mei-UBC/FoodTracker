#!/usr/bin/env pwsh
# PreToolUse guard for Bash commands — wired in .claude/settings.json.
#
# Reads the hook payload JSON from stdin (PreToolUse hooks DO get a closed
# stdin, unlike the Stop-hook caveat in smoke-test.ps1), inspects
# tool_input.command, and either:
#   * allows silently (exit 0, no output), or
#   * denies with a machine-readable reason the agent can act on.
#
# Two jobs:
#   1. Hard-deny commands that destroy local state (the postgres volume IS the
#      price history — there is no backup) or rewrite shared git history.
#   2. The doc-sync push gate: a big branch diff with no doc updates is pushed
#      only after the docs are rectified (or the gate is deliberately bypassed
#      with SKIP_DOC_GATE=1). This wires the "close the loop by updating the
#      docs" rule from CLAUDE.md into the tooling instead of trusting memory.
#
# False-positive control (learned the hard way — a commit MESSAGE mentioning
# 'docker compose down -v' tripped the first version): the matchers run against
# a SANITIZED copy of the command with heredoc bodies and -m/--message
# arguments removed ($scanA), and for command-word patterns additionally all
# quoted strings removed ($scanB). The psql rule is the exception: real
# destructive SQL usually IS inside quotes or a heredoc, so it requires a psql
# invocation in $scanB (prose about psql is stripped) but scans the ORIGINAL
# command text for DROP/TRUNCATE.

$ErrorActionPreference = 'SilentlyContinue'

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
$cmd = $payload.tool_input.command
if (-not $cmd) { exit 0 }

function Deny($reason) {
    $out = @{
        hookSpecificOutput = @{
            hookEventName            = 'PreToolUse'
            permissionDecision       = 'deny'
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Output $out
    exit 0
}

# --- Sanitize: strip text that is data, not command ---------------------------
# $scanA: heredoc bodies and -m/--message string args removed (other quotes kept)
$scanA = [regex]::Replace($cmd, "(?s)<<-?\s*['`"]?(\w+)['`"]?.*?(\r?\n)\1(\r?\n|\s*$)", ' ')
$scanA = [regex]::Replace($scanA, "\s(-m|--message)\s+('[^']*'|`"[^`"]*`")", ' ')
# $scanB: additionally strip ALL remaining quoted strings (for command-word checks)
$scanB = [regex]::Replace($scanA, "(?s)'[^']*'", ' ')
$scanB = [regex]::Replace($scanB, '(?s)"[^"]*"', ' ')

# --- 1. State-destroying commands: hard deny --------------------------------

if ($scanB -match 'docker\s+compose\b[^|;&]*\bdown\b[^|;&]*(\s-v\b|\s--volumes\b)') {
    Deny "'docker compose down -v' deletes the postgres/redis volumes - that is the entire price history, and there is no backup. Use 'docker compose down' without -v; if a volume reset is really intended, ask the user to run it themselves."
}
if ($scanB -match 'docker\s+volume\s+(rm|prune)\b') {
    Deny "'docker volume rm/prune' can delete the postgres data volume (the entire price history). Ask the user to run this themselves if it is really intended."
}
if ($scanB -match 'git\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b)') {
    Deny "Force-pushing is blocked - it can rewrite shared history on origin. Push a new branch instead, or ask the user."
}
if ($scanB -match '\bpsql\b' -and $cmd -match '(?i)\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+\w)') {
    Deny "Destructive SQL (DROP/TRUNCATE) via psql is blocked. Schema changes go through the idempotent schema.sql + manual ALTER flow documented in CLAUDE.md; anything destructive needs the user to run it themselves."
}

# --- 2. Doc-sync push gate ---------------------------------------------------
# Fires only on `git push` of a large diff (vs origin/main) that touches no doc
# file. Bypass deliberately with:  SKIP_DOC_GATE=1 git push ...

if ($scanB -match '(^|[;&|]\s*)git\s+push\b' -and $cmd -notmatch 'SKIP_DOC_GATE=1') {
    $root = $env:CLAUDE_PROJECT_DIR
    if (-not $root) { $root = (Get-Location).Path }

    $names = git -C $root diff --name-only origin/main...HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $names) {
        $files = @($names | Where-Object { $_ })
        $stat  = git -C $root diff --shortstat origin/main...HEAD 2>$null
        $lines = 0
        if ($stat -match '(\d+) insertion') { $lines += [int]$Matches[1] }
        if ($stat -match '(\d+) deletion')  { $lines += [int]$Matches[1] }

        $docPattern = '^(CLAUDE\.md|README\.md|ROADMAP\.md|SHADCN-MIGRATION\.md|CONTRIBUTING\.md|frontend/e2e/README\.md)$'
        $docsTouched = @($files | Where-Object { $_ -match $docPattern }).Count -gt 0

        if (-not $docsTouched -and ($files.Count -gt 5 -or $lines -gt 150)) {
            Deny ("Doc-sync gate: this branch changes $($files.Count) files / ~$lines lines vs origin/main but touches no doc file. Per the loop in CLAUDE.md, launch the doc-sync agent to rectify CLAUDE.md/README/SHADCN-MIGRATION against the diff (or confirm in your final message why no doc update is needed), then push again. To bypass deliberately: SKIP_DOC_GATE=1 git push ...")
        }
    }
}

exit 0
