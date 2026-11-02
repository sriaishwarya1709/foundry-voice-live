# Runs after `azd provision`: writes .env for local development and creates the Foundry agent.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "Writing .env from the azd environment..."
$keys = "AZURE_VOICELIVE_ENDPOINT", "FOUNDRY_PROJECT_ENDPOINT", "FOUNDRY_PROJECT_NAME", "MODEL_DEPLOYMENT_NAME", "AGENT_NAME"
$values = azd env get-values --output json | ConvertFrom-Json
$keys | ForEach-Object { "$_=$($values.$_)" } | Set-Content -Path (Join-Path $root ".env") -Encoding utf8

$python = if (Test-Path ".venv/Scripts/python.exe") { ".venv/Scripts/python.exe" } else {
    Write-Host "Creating .venv..."
    python -m venv .venv
    ".venv/Scripts/python.exe"
}
& $python -m pip install --quiet --disable-pip-version-check -r requirements.txt

Write-Host "Creating the Foundry prompt agent (role assignments can take a minute to propagate)..."
for ($attempt = 1; $attempt -le 5; $attempt++) {
    & $python agent/create_agent.py
    if ($LASTEXITCODE -eq 0) { exit 0 }
    Write-Host "Attempt $attempt failed, retrying in 30 seconds..."
    Start-Sleep -Seconds 30
}
exit 1
