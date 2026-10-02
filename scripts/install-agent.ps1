param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$ManifestUri = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$helper = Join-Path $env:LOCALAPPDATA "IDFRI\idfri-mcp.exe"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("idfri-agent-" + [Guid]::NewGuid().ToString("N"))

function Fail-Json([string]$Code, [string]$Message) {
  [Console]::Out.WriteLine((@{ ok = $false; error = @{ code = $Code; message = $Message } } | ConvertTo-Json -Compress))
  exit 1
}

function Helper-MatchesVersion {
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { return $false }
  try {
    $output = & $helper version --json 2> $null
    if ($LASTEXITCODE -ne 0) { return $false }
    $record = ($output | Out-String) | ConvertFrom-Json
    return $record.ok -eq $true -and $record.result.version -eq $Version
  } catch {
    return $false
  }
}

try {
  if (-not (Helper-MatchesVersion)) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
      & $winget.Source install --id IDFRI.IDFRI --version $Version --exact --force --silent --disable-interactivity --accept-package-agreements --accept-source-agreements *> $null
    }
  }

  if (-not (Helper-MatchesVersion)) {
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    if (-not $ManifestUri) {
      $ManifestUri = "https://github.com/16188/idfri/releases/download/v$Version/idfri-agent-bootstrap.json"
    }
    $manifestPath = Join-Path $tempRoot "manifest.json"
    Invoke-WebRequest -UseBasicParsing -Uri $ManifestUri -OutFile $manifestPath
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schema -ne 1 -or $manifest.version -ne $Version) {
      Fail-Json "manifest_mismatch" "IDFRI 发布元数据与请求版本不一致。"
    }
    if ($manifest.installer.url -notmatch '^https://github\.com/16188/idfri/releases/download/' -or
        $manifest.installer.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
      Fail-Json "manifest_invalid" "IDFRI 发布元数据无效。"
    }

    $installer = Join-Path $tempRoot "IDFRI-setup.exe"
    Invoke-WebRequest -UseBasicParsing -Uri $manifest.installer.url -OutFile $installer
    $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $manifest.installer.sha256.ToLowerInvariant()) {
      Fail-Json "hash_mismatch" "IDFRI 安装包 SHA-256 与发布清单不一致。"
    }

    $process = Start-Process -FilePath $installer -ArgumentList "/S" -PassThru
    if (-not $process.WaitForExit(600000)) {
      Fail-Json "installer_interrupted" "IDFRI 安装正在等待 Windows 批准或安全软件检查。"
    }
    if ($process.ExitCode -ne 0) {
      Fail-Json "installer_failed" "IDFRI 安装失败，请检查 Windows 安全提示。"
    }
  }

  if (-not (Helper-MatchesVersion)) {
    Fail-Json "helper_version_mismatch" "IDFRI 未安装请求版本的 Agent 助手。"
  }

  & $helper setup --client auto --yes --json
  exit $LASTEXITCODE
} catch {
  Fail-Json "bootstrap_failed" "IDFRI 安装或 Agent 配置失败。"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
