# Prompts for the Qualcomm Cloud AI Playground API key (hidden input), saves it to
# backend/.env (gitignored, never committed) and checks it against the API.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\set-qualcomm-key.ps1

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo "backend\.env"
$endpoint = "https://aisuite.cirrascale.com/apis/v2"

Write-Host ""
Write-Host "=== SpatialTwin: Qualcomm Cloud AI 100 API key ===" -ForegroundColor Cyan
$secure = Read-Host "Paste your Cloud AI Playground API key (input is hidden), then press Enter" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim()
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
if (-not $key) { Write-Host "No key entered. Nothing saved." -ForegroundColor Yellow; Read-Host "Press Enter to close"; exit 1 }
$ep = (Read-Host "Paste the endpoint URL you were given (press Enter to keep $endpoint)").Trim()
if ($ep) { $endpoint = $ep.TrimEnd('/') }
foreach ($suffix in @('/chat/completions', '/models')) { if ($endpoint.EndsWith($suffix)) { $endpoint = $endpoint.Substring(0, $endpoint.Length - $suffix.Length) } }

# Keep other lines of backend/.env, replace/add the Qualcomm ones.
$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^\s*QUALCOMM_(API_KEY|ENDPOINT)\s*=' }) }
$lines += "QUALCOMM_API_KEY=$key"
$lines += "QUALCOMM_ENDPOINT=$endpoint"
New-Item -ItemType Directory -Force (Split-Path $envFile) | Out-Null
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
Write-Host "Saved to backend\.env (gitignored)." -ForegroundColor Green

# Safety check: make sure git really ignores it.
Push-Location $repo
$ignored = git check-ignore backend/.env 2>$null
Pop-Location
if (-not $ignored) { Write-Host "WARNING: backend/.env is NOT gitignored. Do not commit!" -ForegroundColor Red }

# Check the key (the key itself is never printed).
Write-Host "Checking the key against $endpoint/models ..."
try {
    $resp = Invoke-RestMethod -Uri "$endpoint/models" -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 15
    $ids = @()
    if ($resp.data) { $ids = $resp.data | ForEach-Object { $_.id } } elseif ($resp -is [array]) { $ids = $resp | ForEach-Object { if ($_.id) { $_.id } else { $_ } } }
    Write-Host "Key works. Models available:" -ForegroundColor Green
    $ids | Select-Object -First 25 | ForEach-Object { Write-Host "  - $_" }
} catch {
    Write-Host "Could not list models: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "The key is saved anyway. Claude-2 will confirm the exact endpoint path (task B7)."
}
Write-Host ""
Read-Host "Done. Press Enter to close"
