#!/usr/bin/env pwsh
# Renders docs/banner.svg -> docs/banner.png (1280x640), the same PNG used for
# GitHub's repo social-preview upload (Settings > General > Social preview
# requires a raster image; the README embeds the SVG directly and doesn't need
# this). Re-run after editing the SVG.
#
# Uses `resvg-cli` (Rust resvg via napi-rs) through `npx --yes` so nothing is
# added to any service's package.json - there's no root package.json in this
# repo and the banner isn't a runtime asset of any of the four services.

$ErrorActionPreference = 'Stop'
$root = $env:CLAUDE_PROJECT_DIR
if (-not $root) { $root = (Get-Location).Path }

$svg = Join-Path $root 'docs/banner.svg'
$png = Join-Path $root 'docs/banner.png'

if (-not (Test-Path $svg)) { Write-Error "not found: $svg"; exit 1 }

npx --yes resvg-cli --fit-width 1280 $svg $png
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "wrote $png"
