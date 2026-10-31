$ErrorActionPreference = 'Stop'

$appExe = Join-Path $PSScriptRoot '..\dist\win-unpacked\emocode v3.1.exe'
$appExe = [System.IO.Path]::GetFullPath($appExe)
if (-not (Test-Path $appExe)) {
  throw "Windows uygulama dosyası bulunamadı: $appExe"
}

$profile = Join-Path $env:RUNNER_TEMP ('emocode-startup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile | Out-Null
$process = $null
try {
  $quotedProfile = '"' + $profile + '"'
  $process = Start-Process -FilePath $appExe -ArgumentList @(
    '--no-sandbox',
    "--user-data-dir=$quotedProfile",
    '--remote-debugging-port=0'
  ) -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $page = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) {
      throw "Uygulama renderer hazır olmadan kapandı (çıkış kodu: $($process.ExitCode))."
    }

    $activePortFile = Join-Path $profile 'DevToolsActivePort'
    if (Test-Path $activePortFile) {
      try {
        $port = [int](Get-Content -LiteralPath $activePortFile -TotalCount 1)
        $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
        $page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -like 'file://*' } | Select-Object -First 1
        if ($page) { break }
      } catch {
        # Electron başlarken DevTools endpoint'i henüz hazır olmayabilir.
      }
    }
    Start-Sleep -Milliseconds 250
  }

  if (-not $page) {
    throw 'Paketlenmiş uygulamanın renderer sayfası 60 saniye içinde hazır olmadı.'
  }
  Write-Host "Windows paketindeki renderer hazır: $($page.title)"
} finally {
  if ($process) {
    $process.Refresh()
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $process.WaitForExit(5000)
    }
  }
  Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
}
