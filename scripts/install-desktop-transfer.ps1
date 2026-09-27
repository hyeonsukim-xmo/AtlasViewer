param(
  [string]$EngineRoot,
  [ValidateSet("cuda", "cpu")][string]$Device = "cuda",
  [switch]$VerifyOnly,
  [switch]$WorkflowCheck
)
$ErrorActionPreference = "Stop"
$bundleRoot = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content -LiteralPath (Join-Path $bundleRoot "transfer-manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema -ne 1 -or $manifest.sourceCommit -notmatch '^[a-f0-9]{40}$') { throw "Invalid transfer manifest" }
$required = @("EXMO-Atlas-Setup.exe", "tools/uv.exe", "scripts/prepare-imaging.ps1", "scripts/prepare-imaging-packages.py", "scripts/validate-imaging-engine.py", "scripts/validate-imaging-transfer.py", "desktop/imaging-palette.json", "desktop/imaging-worker.py", "desktop/classifier-worker.py", "desktop/model-runner.py", "desktop/requirements-ct.txt", "desktop/requirements-mri.txt", "desktop/requirements-ap.txt", "desktop/requirements-lat.txt", "models/EXMO_CT.zip", "models/EXMO_MRI.tar.gz", "models/EXMO_XRAY.zip")
foreach ($name in $required) {
  if ($name -notin $manifest.files.path) { throw "Incomplete manifest: $name" }
}
if ($manifest.files | Group-Object path | Where-Object { $_.Count -gt 1 }) { throw "Duplicate transfer paths" }
$prefix = [System.IO.Path]::GetFullPath($bundleRoot).TrimEnd('\') + '\'
Write-Output "Checking transfer files..."
foreach ($entry in $manifest.files) {
  $file = [System.IO.Path]::GetFullPath((Join-Path $bundleRoot $entry.path))
  if (-not $file.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe transfer path" }
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing transfer file: $($entry.path)" }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw "Checksum mismatch: $($entry.path)" }
}
Write-Output "PASS: transfer file checksums"
if ($VerifyOnly) { return }
if ($WorkflowCheck) {
  if (-not $EngineRoot) {
    $config = Join-Path $env:APPDATA "EXMO Atlas/engine.json"
    $EngineRoot = (Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json).root
  }
  $python = Join-Path $EngineRoot "envs/ct/Scripts/python.exe"
  & $python -X utf8 (Join-Path $PSScriptRoot "validate-imaging-engine.py") --engine-root $EngineRoot --device $Device
  if ($LASTEXITCODE -ne 0) { throw "Runtime check failed" }
  & $python -X utf8 (Join-Path $PSScriptRoot "validate-imaging-transfer.py") --engine-root $EngineRoot --device $Device
  if ($LASTEXITCODE -ne 0) { throw "Workflow check failed; inspect the private workflow report" }
  Write-Output "PASS: sample workflows. Review numerical reproduction differences in workflow-check.json."
  return
}
if (-not $EngineRoot) { $EngineRoot = Join-Path $env:LOCALAPPDATA "EXMO Atlas/engine" }
& (Join-Path $PSScriptRoot "prepare-imaging.ps1") -Source (Join-Path $bundleRoot "models") -EngineRoot $EngineRoot -UvPath (Join-Path $bundleRoot "tools/uv.exe") -Device $Device
if ($LASTEXITCODE -ne 0) { throw "Engine setup failed" }
$installerPath = Join-Path $bundleRoot "EXMO-Atlas-Setup.exe"
Write-Output "Installing EXMO Atlas..."
$installer = Start-Process -FilePath $installerPath -ArgumentList "/S" -WindowStyle Hidden -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "Desktop installer failed: $($installer.ExitCode)" }
Write-Output "Setup complete. Open EXMO Atlas from its shortcut. Run 02-Verify-workflows.cmd for real sample inference."
