$body = @{ url = 'https://modem-peripheral-suffering-batman.trycloudflare.com' } | ConvertTo-Json -Compress
$resp = Invoke-WebRequest -Uri 'https://amina-bot.onrender.com/api/tunnel/register' -Method POST -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 30
Write-Host "Status: $($resp.StatusCode)"
Write-Host $resp.Content
