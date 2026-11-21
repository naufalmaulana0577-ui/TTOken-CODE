#Requires -Version 7.2
<#
.SYNOPSIS
Open the Tauri shell prototype with a payload until the composer shows, take a screenshot, then close it.

.DESCRIPTION
Used by CI (workflow ttoken-desktop-tauri.yml) and can be run by hand. A fresh Harness home is created in the output
folder, so the prototype creates its profile itself. Results in the output folder:

- screenshot.png      the whole screen once the composer shows
- timeline.jsonl      timestamped shell events
- memory.json         one memory sample of the process tree (not a K1 number; measure/ does that)
- smoke.json          summary: when the composer showed, how the app exited, and which processes remained

On Windows the window is closed through WM_CLOSE, and the script fails when an app process remains (a phase 1
criterion). On macOS and Linux the process tree is killed after the screenshot.

.PARAMETER Shell
Path of the prototype executable.

.PARAMETER Payload
Payload for plain Node (holding dsh and runtime): the output of scripts/extract-payload.mjs for the resources folder
of an Electron build, because plain Node cannot read app.asar.

.PARAMETER OutputDirectory
Output folder; created when missing.

.PARAMETER TimeoutSeconds
How long to wait for the composer.
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
# On Windows the window is watched the way Measure-Desktop.ps1 watches it, so CI runs that code against a real window.
$windowWatch = if ($IsWindows) { Start-WindowWatch -Process $shellProcess -TimeoutSeconds $TimeoutSeconds } else { $null }

$summary = [ordered]@{
    launchedAt      = $launchedAt
    windowShownMs   = $null
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
    if ($null -ne $windowWatch) {
        $summary.windowShownMs = (Wait-WindowWatch -Watch $windowWatch) - $launchedAt
        # The shell records window-shown right after it shows the window; the watch must see the window about then.
        $marked = Read-Timeline | Where-Object event -EQ 'window-shown' | Select-Object -First 1
        if ($null -eq $marked) { throw 'timeline tidak mencatat window-shown' }
        $markedMs = [long] $marked.wallMs - $launchedAt
        Write-Host "Jendela tampil $($summary.windowShownMs) ms setelah start (timeline shell: $markedMs ms)"
        if ($summary.windowShownMs -lt $markedMs - 250 -or $summary.windowShownMs -gt $markedMs + 3000) {
            throw "pengamat jendela melihat jendela pada $($summary.windowShownMs) ms, sedangkan shell menampilkannya pada $markedMs ms"
        }
    }
    # Give the page one rendering pass after the composer appears before the screenshot.
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
    # WM_CLOSE reaches the shell only through its main window, which stays hidden until the page boots; a start that
    # failed earlier is stopped instead.
    $windowShown = $IsWindows -and -not $shellProcess.HasExited -and (Test-ProcessWindow -ProcessId $shellProcess.Id)
    if ($windowShown -and $shellProcess.CloseMainWindow()) {
        if ($shellProcess.WaitForExit(30000)) { $summary.exit = 'graceful' } else { $summary.exit = 'timeout' }
    }
    elseif (-not $shellProcess.HasExited) {
        Stop-ProcessTree -Tree $tree
        $summary.exit = if ($IsWindows -and -not $windowShown) { 'killed-before-window' } else { 'killed' }
    }
    else {
        $summary.exit = "exited-early ($($shellProcess.ExitCode))"
    }
    # The app's processes get a few seconds to exit after the shell has finished.
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
# The exit code of the last native command (ps, screencapture) must not decide the CI step's result.
exit 0
