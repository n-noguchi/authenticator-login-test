[CmdletBinding()]
param(
  [switch]$Detach
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

function New-RandomSecret([int]$bytes = 32) {
  $buffer = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($buffer).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

if (-not (Test-Path -LiteralPath $envFile)) {
  $lines = @(
    'KEYCLOAK_ADMIN=admin'
    "KEYCLOAK_ADMIN_PASSWORD=$(New-RandomSecret)"
    "OIDC_CLIENT_SECRET=$(New-RandomSecret)"
    "SESSION_SECRET=$(New-RandomSecret 48)"
    "DEMO_USER_PASSWORD=$(New-RandomSecret)"
  )
  [System.IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host 'Created .env with random local secrets.'
}

Push-Location $root
try {
  if ($Detach) {
    docker compose --env-file .env up --build --detach
  } else {
    docker compose --env-file .env up --build
  }
} finally {
  Pop-Location
}
