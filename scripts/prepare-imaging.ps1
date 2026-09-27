param(
  [Parameter(Mandatory=$true)][string]$Source,
  [string]$EngineRoot = "work/modality-integration",
  [string]$UvPath = "uv",
  [ValidateSet("cuda", "cpu")][string]$Device = "cuda",
  [switch]$SkipConfigureApp
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$priorPythonInstallDir = $env:UV_PYTHON_INSTALL_DIR
Push-Location $repoRoot
try {
  if (-not [Environment]::Is64BitOperatingSystem) { throw "Windows x64 is required" }
  $enginePath = [System.IO.Path]::GetFullPath($EngineRoot)
  $sourcePath = (Resolve-Path -LiteralPath $Source).Path
  foreach ($archive in @("EXMO_CT.zip", "EXMO_MRI.tar.gz", "EXMO_XRAY.zip")) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath $archive) -PathType Leaf)) { throw "Missing private archive: $archive" }
  }
  New-Item -ItemType Directory -Force -Path $enginePath | Out-Null
  # Keep the base interpreter with the engine; no dependency on another user's pyenv.
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $enginePath "python"
  foreach ($name in @("ct", "mri", "ap", "lat")) {
    $environmentPath = Join-Path $enginePath "envs/$name"
    $pythonPath = Join-Path $environmentPath "Scripts/python.exe"
    if (-not (Test-Path -LiteralPath $pythonPath)) {
      & $UvPath --no-config python install 3.12.8 --no-bin --no-registry
      if ($LASTEXITCODE -ne 0) { throw "Cannot install the private Python 3.12.8 runtime" }
      & $UvPath --no-config venv --python 3.12.8 --managed-python $environmentPath
      if ($LASTEXITCODE -ne 0) { throw "Cannot create $name runtime" }
    }
    $index = if ($name -eq "ct") { "https://download.pytorch.org/whl/cpu" } else { "https://download.pytorch.org/whl/cu128" }
    & $UvPath --no-config pip install --python $pythonPath -r "desktop/requirements-$name.txt" --extra-index-url $index --index-strategy unsafe-best-match
    if ($LASTEXITCODE -ne 0) { throw "Cannot install $name runtime" }
    & $UvPath --no-config pip check --python $pythonPath
    if ($LASTEXITCODE -ne 0) { throw "Conflicting dependencies in $name runtime" }
  }
  $ctPython = Join-Path $enginePath "envs/ct/Scripts/python.exe"
  & $ctPython -X utf8 scripts/prepare-imaging-packages.py --source $sourcePath --target (Join-Path $enginePath "packages")
  if ($LASTEXITCODE -ne 0) { throw "Package integrity verification failed" }
  & $ctPython -X utf8 scripts/validate-imaging-engine.py --engine-root $enginePath --device $Device
  if ($LASTEXITCODE -ne 0) { throw "Runtime validation failed; application configuration was not changed" }
  if ($SkipConfigureApp) {
    Write-Output "Engine verified at $enginePath. Application configuration was not changed."
    return
  }
  $settings = Join-Path $env:APPDATA "EXMO Atlas"
  New-Item -ItemType Directory -Force -Path $settings | Out-Null
  $config = Join-Path $settings "engine.json"
  if (Test-Path -LiteralPath $config) {
    Copy-Item -LiteralPath $config -Destination ($config + ".backup-" + (Get-Date -Format "yyyyMMdd-HHmmssfff"))
  }
  # UTF-8 without BOM: Node and Python read the same exact JSON.
  [System.IO.File]::WriteAllText(($config + ".tmp"), (@{root=$enginePath} | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath ($config + ".tmp") -Destination $config -Force
  Write-Output "Local imaging engine is configured. Keep this directory when updating the desktop app."
} finally {
  $env:UV_PYTHON_INSTALL_DIR = $priorPythonInstallDir
  Pop-Location
}
