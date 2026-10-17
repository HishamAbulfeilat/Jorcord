# Windows PowerShell version of init-env.sh: writes .env with random secrets. Safe to re-run (never overwrites).
if (Test-Path .env) { Write-Host ".env already exists, leaving it alone"; exit 0 }
function Rnd {
  $b = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ([Convert]::ToBase64String($b) -replace '[^A-Za-z0-9]', '').Substring(0, 48)
}
$publicUrl = if ($env:PUBLIC_URL) { $env:PUBLIC_URL } else { 'http://localhost:3000' }
$cors = if ($env:CORS_ORIGINS) { $env:CORS_ORIGINS } else { 'https://hishamabulfeilat.github.io,http://localhost:5173' }
$lk = if ($env:LIVEKIT_URL) { $env:LIVEKIT_URL } else { 'ws://localhost:7880' }
$lines = @(
  "JWT_SECRET=$(Rnd)",
  "POSTGRES_PASSWORD=$(Rnd)",
  "LIVEKIT_API_SECRET=$(Rnd)",
  "MINIO_ROOT_PASSWORD=$(Rnd)",
  "PUBLIC_URL=$publicUrl",
  "CORS_ORIGINS=$cors",
  "LIVEKIT_URL=$lk"
)
# UTF-8 without BOM so docker compose reads the first key correctly
[System.IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote .env"
