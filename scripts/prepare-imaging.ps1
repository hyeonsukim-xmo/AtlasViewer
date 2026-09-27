param(
  [Parameter(Mandatory=$true)][string]$Source,
  [string]$EngineRoot = "work/modality-integration"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
  $enginePath = [System.IO.Path]::GetFullPath($EngineRoot)
  New-Item -ItemType Directory -Force $enginePath | Out-Null
  foreach ($name in @("ct", "mri", "ap", "lat")) {
    $environmentPath = Join-Path $enginePath "envs/$name"
    $pythonPath = Join-Path $environmentPath "Scripts/python.exe"
    if (-not (Test-Path -LiteralPath $pythonPath)) {
      & uv venv --python 3.12 $environmentPath
      if ($LASTEXITCODE -ne 0) { throw "Cannot create $name runtime" }
    }
    $index = if ($name -eq "ct") { "https://download.pytorch.org/whl/cpu" } elseif ($name -eq "mri") { "https://download.pytorch.org/whl/cu128" } else { "https://download.pytorch.org/whl/cu126" }
    & uv pip install --python $pythonPath -r "desktop/requirements-$name.txt" --extra-index-url $index --index-strategy unsafe-best-match
    if ($LASTEXITCODE -ne 0) { throw "Cannot install $name runtime" }
  }
  & (Join-Path $enginePath "envs/ct/Scripts/python.exe") -X utf8 scripts/prepare-imaging-packages.py --source $Source --target (Join-Path $enginePath "packages")
  if ($LASTEXITCODE -ne 0) { throw "Package integrity verification failed" }
  $settings = Join-Path $env:APPDATA "EXMO Atlas"
  New-Item -ItemType Directory -Force $settings | Out-Null
  # UTF-8 without BOM: Node and Python read the same exact JSON.
  [System.IO.File]::WriteAllText((Join-Path $settings "engine.json"), (@{root=$enginePath} | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "Local imaging engine is configured. Keep this directory when updating the desktop app."
} finally { Pop-Location }
