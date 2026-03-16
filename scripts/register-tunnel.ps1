$tunnelToken = $env:LMSTUDIO_TUNNEL_TOKEN
if ([string]::IsNullOrWhiteSpace($tunnelToken)) {
    throw 'LMSTUDIO_TUNNEL_TOKEN is not set'
}

$body = @{ url = 'https://modem-peripheral-suffering-batman.trycloudflare.com' } | ConvertTo-Json -Compress
$headers = @{
    'Content-Type' = 'application/json'
    'X-Amina-Tunnel-Token' = $tunnelToken
}

$resp = Invoke-WebRequest -Uri 'https://amina.vibecoding.by/api/tunnel/register' -Method POST -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 30
Write-Host "Status: $($resp.StatusCode)"
Write-Host $resp.Content
