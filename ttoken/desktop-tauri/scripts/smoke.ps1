#Requires -Version 7.2
<#
.SYNOPSIS
Buka prototipe shell Tauri dengan sebuah payload sampai composer tampil, ambil screenshot, lalu tutup.

.DESCRIPTION
Dipakai CI (workflow ttoken-desktop-tauri.yml) dan bisa dijalankan manual. Home Harness dibuat baru di folder keluaran,
jadi profil dibuat oleh prototipe sendiri. Hasil di folder keluaran:

- screenshot.png      seluruh layar saat composer sudah tampil
- timeline.jsonl      kejadian shell bertanda waktu
- memory.json         satu sampel memori pohon proses (bukan angka K1; itu tugas skrip di measure/)
- smoke.json          ringkasan: waktu composer tampil, cara keluar, dan proses yang tersisa

Di Windows jendela ditutup lewat WM_CLOSE, dan skrip gagal bila ada proses milik app yang tersisa (kriteria Fase 1).
Di macOS dan Linux pohon proses dihentikan paksa setelah screenshot.

.PARAMETER Shell
Path executable prototipe.

.PARAMETER Payload
Payload untuk Node biasa (berisi dsh dan runtime): hasil scripts/extract-payload.mjs dari folder resources build
Electron, karena Node biasa tidak bisa membaca app.asar.

.PARAMETER OutputDirectory
Folder keluaran; dibuat bila belum ada.

.PARAMETER TimeoutSeconds
Batas waktu sampai composer tampil.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Shell,
    [Parameter(Mandatory)] [string] $Payload,
    [Parameter(Mandatory)] [string] $OutputDirectory,
    [int] $TimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..' 'measure' 'DesktopProcess.psm1') -Force

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$output = (Resolve-Path $OutputDirectory).Path
$harnessHome = Join-Path $output 'home'
$timelinePath = Join-Path $output 'timeline.jsonl'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $harnessHome, $timelinePath

function Read-Timeline {
    if (-not (Test-Path $timelinePath)) { return @() }
    @(Get-Content $timelinePath | Where-Object { $_ -ne '' } | ForEach-Object { $_ | ConvertFrom-Json })
}

# ProcessStartInfo.ArgumentList quotes each argument; the macOS payload path contains a space ("TTOken Code.app").
$start = [System.Diagnostics.ProcessStartInfo]::new((Resolve-Path $Shell).Path)
$start.UseShellExecute = $false
$start.ArgumentList.Add('--payload')
$start.ArgumentList.Add((Resolve-Path $Payload).Path)
$start.Environment['DSH_HOME'] = $harnessHome
$start.Environment['TTOKEN_DESKTOP_TIMELINE'] = $timelinePath
$start.Environment['TTOKEN_DESKTOP_MARK_COMPOSER'] = '1'
$launchedAt = Get-UnixMilliseconds
$shellProcess = [System.Diagnostics.Process]::Start($start)
Write-Host "Prototipe berjalan sebagai proses $($shellProcess.Id)"

$summary = [ordered]@{
    launchedAt      = $launchedAt
    composerShownMs = $null
    failure         = $null
    exit            = $null
    remaining       = @()
}
$tree = @()
try {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $events = Read-Timeline
        $failure = $events | Where-Object { $_.event -in 'startup-failed', 'host-failed', 'boot-failed' } | Select-Object -First 1
        if ($null -ne $failure) { throw "prototipe gagal start ($($failure.event)): $($failure.detail)" }
        $shown = $events | Where-Object event -EQ 'composer-shown' | Select-Object -First 1
        if ($null -ne $shown) {
            $summary.composerShownMs = [long] $shown.wallMs - $launchedAt
            break
        }
        if ($shellProcess.HasExited) { throw "prototipe keluar dengan kode $($shellProcess.ExitCode) sebelum composer tampil" }
        if ((Get-Date) -gt $deadline) { throw "composer tidak tampil dalam $TimeoutSeconds detik" }
        Start-Sleep -Milliseconds 250
    }
    Write-Host "Composer tampil $($summary.composerShownMs) ms setelah start"
    # Beri waktu satu putaran render setelah composer muncul sebelum screenshot.
    Start-Sleep -Seconds 3
    $tree = @(Get-ProcessTree -RootId $shellProcess.Id)
    Get-TreeMemory -RootId $shellProcess.Id | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'memory.json')
}
catch {
    $summary.failure = $_.Exception.Message
}
finally {
    try { Save-Screenshot -Path (Join-Path $output 'screenshot.png') }
    catch { Write-Warning "screenshot gagal: $($_.Exception.Message)" }
    if ($tree.Count -eq 0 -and -not $shellProcess.HasExited) { $tree = @(Get-ProcessTree -RootId $shellProcess.Id) }

    if (-not $shellProcess.HasExited) { $shellProcess.Refresh() }
    if ($IsWindows -and -not $shellProcess.HasExited -and $shellProcess.CloseMainWindow()) {
        if ($shellProcess.WaitForExit(30000)) { $summary.exit = 'graceful' } else { $summary.exit = 'timeout' }
    }
    elseif (-not $shellProcess.HasExited) {
        Stop-ProcessTree -Tree $tree
        $summary.exit = 'killed'
    }
    else {
        $summary.exit = "exited-early ($($shellProcess.ExitCode))"
    }
    # Proses milik app punya beberapa detik untuk keluar setelah shell selesai.
    $settle = (Get-Date).AddSeconds(10)
    do {
        $remaining = @(Get-RemainingProcesses -Tree $tree)
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $settle)
    $summary.remaining = @($remaining | ForEach-Object { "$($_.Name) ($($_.Id))" })
    Stop-ProcessTree -Tree $remaining
    $summary | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'smoke.json')
}

$summary | ConvertTo-Json -Depth 5 | Write-Host
if ($null -ne $summary.failure) { throw $summary.failure }
if ($IsWindows -and $summary.exit -ne 'graceful') { throw "prototipe tidak keluar rapi lewat WM_CLOSE ($($summary.exit))" }
if ($IsWindows -and $summary.remaining.Count -gt 0) { throw "proses milik app tersisa: $($summary.remaining -join ', ')" }
