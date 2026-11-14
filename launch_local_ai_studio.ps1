param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$serverPath = [IO.Path]::GetFullPath((Join-Path $projectRoot "sidecars\local_ai_chat\server.js"))
$trayPath = [IO.Path]::GetFullPath((Join-Path $projectRoot "local_ai_tray.pyw"))
$port = 63719
$appUrl = "http://127.0.0.1:$port/"

function Get-StudioProcesses {
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match "^(node|nodejs)(\.exe)?$" -and
        $_.CommandLine -and
        $_.CommandLine -match "sidecars[\\/]local_ai_chat[\\/]server\.js"
    })
}

function Stop-ProcessSafely([int]$processId) {
    if ($processId -gt 0) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

# Close only app windows opened for this local Studio URL, including a stale
# window that may still display the previous server after a relaunch.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -match "^(msedge|chrome)(\.exe)?$" -and
        $_.CommandLine -and
        $_.CommandLine -match "--app=$([regex]::Escape($appUrl))"
    } |
    ForEach-Object { Stop-ProcessSafely $_.ProcessId }

$currentServerPath = $serverPath.ToLowerInvariant()
# Reinicia siempre la instancia del proyecto actual para que el lanzador no
# conserve módulos Node cargados antes de una actualización del repositorio.
Get-StudioProcesses | ForEach-Object { Stop-ProcessSafely $_.ProcessId }

Start-Sleep -Milliseconds 750

Start-Process -FilePath "node.exe" -ArgumentList @($serverPath) -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null

$ready = $false
$version = $null
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        $version = Invoke-RestMethod -Uri "${appUrl}api/version" -TimeoutSec 2
        $currentServer = Get-StudioProcesses |
            Where-Object { $_.CommandLine.ToLowerInvariant() -like "*$currentServerPath*" } |
            Select-Object -First 1
        if ($currentServer -and $version.v -eq "2.1.0") {
            $ready = $true
            break
        }
    } catch {
        # The server is still starting.
    }
}

if (-not $ready) {
    throw "Local AI Studio no pudo iniciar desde $projectRoot."
}

if (-not $NoBrowser) {
    $edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    $chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
    $build = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $browserArgs = @("--app=${appUrl}?build=$build", "--disable-application-cache", "--disable-features=BackForwardCache")
    if (Test-Path -LiteralPath $edgePath) {
        Start-Process -FilePath $edgePath -ArgumentList $browserArgs | Out-Null
    } elseif (Test-Path -LiteralPath $chromePath) {
        Start-Process -FilePath $chromePath -ArgumentList $browserArgs | Out-Null
    } else {
        Start-Process $appUrl | Out-Null
    }
}
