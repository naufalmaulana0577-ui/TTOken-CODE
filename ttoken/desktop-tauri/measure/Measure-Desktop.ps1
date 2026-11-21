#Requires -Version 7.2
<#
.SYNOPSIS
Measure the memory and timings of TTOken Code Desktop, the Electron build and the Tauri prototype, for the phase 0
gate of PRD-TAURI.

.DESCRIPTION
The script runs scenarios S1 to S3 of the PRD (ttoken/docs/PRD-TAURI.md, "Cara mengukur") on Windows 11, with a
separate Harness home so everyday data is not touched. Both builds run the same Host and Web client: the Tauri
prototype runs the payload of the Electron installation. Electron keeps the dsh project inside app.asar, which plain
Node cannot read, so the script first extracts it to its working folder (scripts/extract-payload.mjs).

The builds are measured interleaved in one call: every run and scenario launches each selected build, in a rotating
order, so heat, power mode, and background work affect all builds alike. Every launch starts from the same state:
Session A open and the default right sidebar, which the end of the previous launch restores; when that fails, an
unrecorded launch restores it. Windows is kept awake while the script runs.

Each launch records:
- (a) the time from process start until the main window shows;
- (b) the time until the composer accepts input, observed by a page watcher installed while the window is still
  hidden;
- (c) session switch times (S3), from the mouse press until the target Session's last answer shows;
- memory: the private working set of the app's whole process tree, also per process kind;
- hostStartMs: when the Host process was created, since start. Electron loads the page before it starts the Host,
  the prototype starts the Host while the page loads; that offset is part of the (a) and (b) differences without
  being a property of Tauri.

Steps:
1. Install the Electron build from CI (installer ttoken-code-windows-x64-unsigned), then run -Setup once.
2. Run without parameters: Electron, Tauri, and Tauri with the compile cache are measured interleaved.
3. Compare the results with Compare-Desktop.ps1.
Cold start: reboot, then -Build Electron -Cold; reboot again, then -Build Tauri -Cold.
A measurement stopped early, also with Ctrl+C, still writes the launches it finished, marked as aborted.

.PARAMETER Setup
Prepare the measurement home: extract the payload, create a small workspace and the synthetic S2 and S3 Sessions,
launch Electron once to enter the API key on the welcome screen, then warm up both builds.

.PARAMETER Build
Builds measured interleaved: Electron, Tauri, and TauriCache (Tauri with Node's compile cache, D12). All three by
default. With -Cold, exactly one build.

.PARAMETER Scenario
Scenarios to run; S1, S2, and S3 by default.

.PARAMETER Runs
Launches per scenario and build; the reports use medians.

.PARAMETER Cold
One launch without a warm-up, for a cold start after a reboot.

.PARAMETER SettleSeconds
With -Cold: how many seconds the processor and disk must be quiet before the launch (waited for at most 15 minutes).

.PARAMETER IdleSeconds
How long S1 idles after the composer is ready.

.PARAMETER ElectronExe
Path of "TTOken Code.exe"; by default it is looked up in %LOCALAPPDATA%\Programs.

.PARAMETER TauriExe
Path of ttoken-code-desktop.exe; by default next to the measure folder (the content of the CI artifact).

.PARAMETER WorkRoot
Working folder: Harness home, workspace, Electron data, cache, payload, and results.
#>
[CmdletBinding(DefaultParameterSetName = 'Measure')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Setup')] [switch] $Setup,
    [Parameter(ParameterSetName = 'Measure')] [ValidateSet('Electron', 'Tauri', 'TauriCache')] [string[]] $Build = @('Electron', 'Tauri', 'TauriCache'),
    [Parameter(ParameterSetName = 'Measure')] [ValidateSet('S1', 'S2', 'S3')] [string[]] $Scenario = @('S1', 'S2', 'S3'),
    [Parameter(ParameterSetName = 'Measure')] [ValidateRange(1, 50)] [int] $Runs = 5,
    [Parameter(ParameterSetName = 'Measure')] [switch] $Cold,
    [Parameter(ParameterSetName = 'Measure')] [ValidateRange(0, 3600)] [int] $SettleSeconds = 60,
    [ValidateRange(10, 3600)] [int] $IdleSeconds = 120,
    [string] $ElectronExe,
    [string] $TauriExe,
    [string] $WorkRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ttoken-measure')
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Pengukuran Fase 0 dijalankan di Windows 11.' }
Import-Module (Join-Path $PSScriptRoot 'DesktopProcess.psm1'), (Join-Path $PSScriptRoot 'Cdp.psm1'),
(Join-Path $PSScriptRoot 'Scenario.psm1') -Force

$harnessHome = Join-Path $WorkRoot 'home'
$workspace = Join-Path $WorkRoot 'workspace'
$electronUserData = Join-Path $WorkRoot 'electron-userdata'
$compileCacheDirectory = Join-Path $WorkRoot 'node-compile-cache'
$resultsDirectory = Join-Path $WorkRoot 'results'
$origins = @{ Electron = 'dsh-app://app/'; Tauri = 'http://ttoken-app.localhost/' }
# Chromium writes localStorage changes to disk a few seconds after they happen.
$storageCommitSeconds = 6

# Builds that can be measured. TauriCache is the same prototype with Node's compile cache (D12).
$armCatalog = [ordered]@{
    Electron   = [pscustomobject]@{ Name = 'Electron'; Shell = 'Electron'; CompileCache = $false; Label = 'electron' }
    Tauri      = [pscustomobject]@{ Name = 'Tauri'; Shell = 'Tauri'; CompileCache = $false; Label = 'tauri' }
    TauriCache = [pscustomobject]@{ Name = 'TauriCache'; Shell = 'Tauri'; CompileCache = $true; Label = 'tauri-cache' }
}
$arms = @(if ($Setup) { $armCatalog.Electron, $armCatalog.Tauri } else { @($Build | Select-Object -Unique) | ForEach-Object { $armCatalog[$_] } })
if ($Cold -and $arms.Count -ne 1) { throw '-Cold mengukur tepat satu build: -Build Electron, -Build Tauri, atau -Build TauriCache.' }

function Resolve-ElectronExe {
    if ($ElectronExe) { return (Resolve-Path $ElectronExe).Path }
    foreach ($folder in 'TTOken Code', 'ttoken-code') {
        $candidate = Join-Path $env:LOCALAPPDATA "Programs\$folder\TTOken Code.exe"
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'TTOken Code (Electron) tidak ditemukan di %LOCALAPPDATA%\Programs; isi -ElectronExe.'
}

function Resolve-TauriExe {
    if ($TauriExe) { return (Resolve-Path $TauriExe).Path }
    foreach ($candidate in (Join-Path $PSScriptRoot '..' 'ttoken-code-desktop.exe'),
        (Join-Path $PSScriptRoot '..' 'target' 'release' 'ttoken-code-desktop.exe')) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }
    throw 'ttoken-code-desktop.exe tidak ditemukan di samping folder measure; isi -TauriExe.'
}

$electron = Resolve-ElectronExe
$electronResources = Join-Path (Split-Path $electron) 'resources'
$payloadNode = Join-Path $electronResources 'runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $payloadNode)) { throw "payload Electron tidak lengkap: $payloadNode tidak ada" }
# Payload for plain Node: the dsh project extracted from app.asar, and the runtime linked to the Electron installation.
$payload = Join-Path $WorkRoot 'payload'
$project = Join-Path $payload 'dsh'
$extractor = Join-Path $PSScriptRoot '..' 'scripts' 'extract-payload.mjs'
$tauri = if (@($arms | Where-Object Shell -EQ 'Tauri').Count -gt 0) { Resolve-TauriExe } else { $null }

function Update-Payload {
    <# Extract the dsh project from the app.asar of the Electron installation; nothing happens while app.asar is unchanged. #>
    if (-not (Test-Path $extractor)) { throw "extract-payload.mjs tidak ditemukan: $extractor" }
    & $payloadNode $extractor $electronResources $payload
    if ($LASTEXITCODE -ne 0) { throw "ekstrak payload gagal dengan kode $LASTEXITCODE" }
}

function Get-FreePort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Get-Median {
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [double[]] $Values)
    if ($Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $middle = [int] [Math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 1) { return $sorted[$middle] }
    ($sorted[$middle - 1] + $sorted[$middle]) / 2
}

function Get-PowerState {
    <# Windows power source and power scheme; the scheme and the power mode change the processor frequency. #>
    Add-Type -AssemblyName System.Windows.Forms
    $overlay = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes' -ErrorAction SilentlyContinue
    [ordered]@{
        line    = [string] [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus
        scheme  = ((& powercfg /getactivescheme) -join ' ').Trim()
        overlay = $(if ($null -ne $overlay -and $overlay.PSObject.Properties['ActiveOverlayAcPowerScheme']) { [string] $overlay.ActiveOverlayAcPowerScheme } else { $null })
    }
}

function Assert-OnPower {
    <# On battery Windows lowers the processor frequency, so measurements run only with the charger plugged in. #>
    Add-Type -AssemblyName System.Windows.Forms
    if ([System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq 'Offline') {
        throw 'Laptop berjalan dengan baterai. Colokkan charger, lalu jalankan skrip ini lagi.'
    }
}

function Start-Desktop {
    param([Parameter(Mandatory)] [object] $Arm, [Parameter(Mandatory)] [int] $Port, [string] $Timeline)
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.UseShellExecute = $false
    $info.Environment['DSH_HOME'] = $harnessHome
    # Only the TauriCache build uses the compile cache, whatever the caller's environment holds.
    $null = $info.Environment.Remove('NODE_COMPILE_CACHE')
    if ($Arm.Shell -eq 'Electron') {
        $info.FileName = $electron
        $info.ArgumentList.Add("--remote-debugging-port=$Port")
        $info.ArgumentList.Add("--user-data-dir=$electronUserData")
    }
    else {
        $info.FileName = $tauri
        $info.ArgumentList.Add('--payload')
        $info.ArgumentList.Add($payload)
        $info.Environment['TTOKEN_DESKTOP_DEBUG_PORT'] = "$Port"
        if ($Timeline) { $info.Environment['TTOKEN_DESKTOP_TIMELINE'] = $Timeline }
        if ($Arm.CompileCache) { $info.Environment['NODE_COMPILE_CACHE'] = $compileCacheDirectory }
    }
    $launchedAt = Get-UnixMilliseconds
    $process = [System.Diagnostics.Process]::Start($info)
    [pscustomobject]@{ Name = $Arm.Shell; Arm = $Arm; Process = $process; LaunchedAt = $launchedAt; Port = $Port; Origin = $origins[$Arm.Shell] }
}

function Stop-Desktop {
    <#
    Close the app the ordinary way: Tauri through WM_CLOSE, Electron through a second instance with
    --quit-for-installer, because closing its window only hides the app to the tray.
    #>
    param([Parameter(Mandatory)] [object] $Launch)
    $tree = @(Get-ProcessTree -RootId $Launch.Process.Id)
    $requested = $false
    if (-not $Launch.Process.HasExited) {
        if ($Launch.Name -eq 'Electron') {
            $info = [System.Diagnostics.ProcessStartInfo]::new($electron)
            $info.UseShellExecute = $false
            $info.Environment['DSH_HOME'] = $harnessHome
            $info.ArgumentList.Add('--quit-for-installer')
            $info.ArgumentList.Add("--user-data-dir=$electronUserData")
            $quitter = [System.Diagnostics.Process]::Start($info)
            $null = $quitter.WaitForExit(30000)
            $requested = $true
        }
        else {
            $Launch.Process.Refresh()
            # WM_CLOSE reaches the shell only through its main window, hidden until the page boots; a launch that
            # failed earlier is stopped below instead of waiting for a close that cannot arrive.
            if (Test-ProcessWindow -ProcessId $Launch.Process.Id) { $requested = $Launch.Process.CloseMainWindow() }
        }
    }
    $graceful = $requested -and $Launch.Process.WaitForExit(30000)
    $deadline = (Get-Date).AddSeconds(15)
    while (@(Get-RemainingProcesses -Tree $tree).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    $left = @(Get-RemainingProcesses -Tree $tree)
    Stop-ProcessTree -Tree $left
    [ordered]@{ graceful = $graceful; leftover = @($left | ForEach-Object { "$($_.Name) ($($_.Id))" }) }
}

function Assert-NoUserInstance {
    <#
    The user's own TTOken Code must be closed first: Stop-Strays kills processes with the same path, and a running app
    would disturb the numbers. The main process of the user's instance carries no --type, --user-data-dir, or Host entry.
    #>
    $running = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -eq $electron -and $_.CommandLine -notmatch '--type=|--user-data-dir=|dsh-desktop-host'
        })
    if ($running.Count -gt 0) {
        throw 'TTOken Code masih berjalan, mungkin di tray. Keluar lewat menu tray, lalu jalankan skrip ini lagi.'
    }
}

function Stop-Strays {
    <#
    Stop what earlier runs left behind: the shells of both builds and Node from the payload, by real path or link path.
    When the user opens their own TTOken Code during the measurement, the script stops instead of killing it.
    #>
    Assert-NoUserInstance
    $paths = @($electron, $tauri, $payloadNode, (Join-Path $payload 'runtime\primary-runtime\dependencies\node\bin\node.exe')) |
        Where-Object { $_ }
    Get-Process | Where-Object { $_.Path -and $paths -contains $_.Path } | ForEach-Object {
        Write-Warning "menghentikan sisa proses $($_.ProcessName) ($($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}

function Wait-MainWindow {
    param([Parameter(Mandatory)] [object] $Launch, [int] $TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Test-ProcessWindow -ProcessId $Launch.Process.Id)) {
        if ($Launch.Process.HasExited) { throw "app keluar dengan kode $($Launch.Process.ExitCode) sebelum jendelanya tampil" }
        if ((Get-Date) -gt $deadline) { throw "jendela utama tidak tampil dalam $TimeoutSeconds detik" }
        Start-Sleep -Milliseconds 10
    }
    (Get-UnixMilliseconds) - $Launch.LaunchedAt
}

function Wait-SystemQuiet {
    <# Cold start: wait until the processor and disk have been quiet for $Seconds seconds in a row, at most 15 minutes. #>
    param([int] $Seconds)
    $started = Get-Date
    $deadline = $started.AddMinutes(15)
    $quietSince = $null
    Write-Host "Menunggu CPU dan disk tenang selama $Seconds detik (paling lama 15 menit)."
    while ((Get-Date) -lt $deadline) {
        $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name = '_Total'").PercentProcessorTime
        $diskIdle = (Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name = '_Total'").PercentIdleTime
        if ($cpu -lt 10 -and $diskIdle -gt 90) {
            if ($null -eq $quietSince) { $quietSince = Get-Date }
            if (((Get-Date) - $quietSince).TotalSeconds -ge $Seconds) {
                return [ordered]@{ waitedSeconds = [int] ((Get-Date) - $started).TotalSeconds; timedOut = $false }
            }
        }
        else { $quietSince = $null }
        Start-Sleep -Seconds 2
    }
    Write-Warning 'Sistem tidak tenang dalam 15 menit; peluncuran tetap dijalankan dan ditandai.'
    [ordered]@{ waitedSeconds = [int] ((Get-Date) - $started).TotalSeconds; timedOut = $true }
}

function Get-TimelineEvent {
    <# The first event named $Name in the Tauri shell's timeline, or $null. #>
    param([Parameter(Mandatory)] [string] $Path, [Parameter(Mandatory)] [string] $Name)
    if (-not (Test-Path $Path)) { return $null }
    Get-Content $Path | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object event -EQ $Name |
        Select-Object -First 1
}

function Measure-Memory {
    param([Parameter(Mandatory)] [object[]] $Samples)
    $kinds = @($Samples | ForEach-Object { $_.processes } | ForEach-Object { $_.kind } | Sort-Object -Unique)
    $byKind = [ordered]@{}
    foreach ($kind in $kinds) {
        $byKind[$kind] = Get-Median -Values @($Samples | ForEach-Object {
                [double] (@($_.processes | Where-Object kind -EQ $kind) | Measure-Object -Property bytes -Sum).Sum
            })
    }
    [ordered]@{
        metric       = $Samples[0].metric
        medianTotal  = Get-Median -Values @($Samples | ForEach-Object { [double] $_.total })
        totals       = @($Samples | ForEach-Object { $_.total })
        byKind       = $byKind
        processCount = @($Samples[-1].processes).Count
        lastSample   = $Samples[-1].processes
    }
}

function Reset-AfterLaunch {
    <#
    Put the page back in the start state for the next launch (Session A, default right sidebar). It runs after this
    launch's measurements, so it does not change them.
    #>
    param([Parameter(Mandatory)] [object] $Launch, [object] $Session)
    $own = $null -eq $Session
    try {
        if ($own) {
            $page = Find-CdpPage -Port $Launch.Port -UrlPrefix $Launch.Origin -TimeoutSeconds 30
            $Session = Connect-Cdp -WebSocketUrl $page.webSocketDebuggerUrl
            Install-PageHelpers -Session $Session
        }
        Reset-LaunchState -Session $Session
        Start-Sleep -Seconds $storageCommitSeconds
        'ok'
    }
    finally {
        if ($own -and $null -ne $Session) { Disconnect-Cdp -Session $Session }
    }
}

function Invoke-Launch {
    param([Parameter(Mandatory)] [object] $Arm, [Parameter(Mandatory)] [string] $ScenarioName, [int] $Run, [string] $RunDirectory)
    Assert-OnPower
    Stop-Strays
    $port = Get-FreePort
    $timeline = if ($RunDirectory -and $Arm.Shell -eq 'Tauri') { Join-Path $RunDirectory ('{0}-{1}-{2}.timeline.jsonl' -f $Arm.Label, $ScenarioName, $Run) } else { $null }
    $record = [ordered]@{
        scenario = $ScenarioName; run = $Run; launchedAt = $null; windowMs = $null; windowFrom = $null; composerMs = $null
        composerLate = $null; startedOn = $null; hostStartMs = $null; details = $null; memory = $null; reset = $null; stop = $null
        failure = $null
    }
    $launch = Start-Desktop -Arm $Arm -Port $port -Timeline $timeline
    $record.launchedAt = $launch.LaunchedAt
    $session = $null
    try {
        # The window is watched on a thread of its own from the start, so the page helpers go in while the window is
        # still hidden. Both builds show the window before the page renders the composer, so the composer watcher of
        # page.js is in place before the composer appears and (b) is not an upper bound.
        $windowWatch = Start-WindowWatch -Process $launch.Process
        $page = Find-CdpPage -Port $port -UrlPrefix $launch.Origin -TimeoutSeconds 180 -Process $launch.Process
        $session = Connect-Cdp -WebSocketUrl $page.webSocketDebuggerUrl -NoActivate
        Install-PageHelpers -Session $session
        $record.windowMs = (Wait-WindowWatch -Watch $windowWatch) - $launch.LaunchedAt
        $record.windowFrom = 'window'
        # Input reaches the page only while it is the foreground page; done once the window shows, as for a user.
        $null = Invoke-Cdp -Session $session -Method 'Page.bringToFront'
        $composer = Wait-Composer -Session $session -TimeoutSeconds 180
        $record.composerMs = [long] $composer.at - $launch.LaunchedAt
        $record.composerLate = [bool] $composer.late
        # The Session restored at start; Session A in every launch.
        $record.startedOn = Get-OpenFixture -Session $session
        switch ($ScenarioName) {
            'S2' { $record.details = Invoke-ScenarioS2 -Session $session }
            'S3' { $record.details = Invoke-ScenarioS3 -Session $session }
            default { }
        }
        # Memory is sampled without a DevTools connection, the same for both builds.
        Disconnect-Cdp -Session $session
        $session = $null
        Start-Sleep -Seconds $(if ($ScenarioName -in 'S1', 'Cold') { $IdleSeconds } else { 10 })
        $samples = @(foreach ($index in 1..5) {
                Get-TreeMemory -RootId $launch.Process.Id
                if ($index -lt 5) { Start-Sleep -Seconds 1 }
            })
        $record.memory = Measure-Memory -Samples $samples
        $hostProcess = @($samples[0].processes | Where-Object kind -EQ 'host') | Select-Object -First 1
        if ($null -ne $hostProcess) { $record.hostStartMs = [long] $hostProcess.started - $launch.LaunchedAt }
        # A prototype window shown by its 30-second fallback means the page had not booted: the watch saw a blank window.
        # A warm launch that slow is a failure. A cold start that slow is kept, with (a) taken from the moment the page
        # booted, when the window shows without the fallback, as Electron shows its own.
        if ($timeline) {
            $shown = Get-TimelineEvent -Path $timeline -Name 'window-shown'
            if ($null -ne $shown -and $shown.PSObject.Properties['detail'] -and $shown.detail -eq 'deadline') {
                $booted = Get-TimelineEvent -Path $timeline -Name 'boot-answered'
                if ($ScenarioName -ne 'Cold' -or $null -eq $booted) {
                    throw 'jendela prototipe tampil karena batas 30 detik, bukan karena halaman boot'
                }
                $record.windowMs = [long] $booted.wallMs - $launch.LaunchedAt
                $record.windowFrom = 'boot-answered'
            }
        }
    }
    catch {
        $record.failure = $_.Exception.Message
        Write-Warning "$($Arm.Name) $ScenarioName run $Run gagal: $($record.failure)"
    }
    finally {
        try { $record.reset = Reset-AfterLaunch -Launch $launch -Session $session }
        catch { $record.reset = "gagal: $($_.Exception.Message)" }
        if ($null -ne $session) { Disconnect-Cdp -Session $session }
        $record.stop = Stop-Desktop -Launch $launch
    }
    $record
}

function Initialize-Fixture {
    New-Item -ItemType Directory -Force -Path $harnessHome, $workspace, $electronUserData, $resultsDirectory | Out-Null
    # A small workspace: a README and 20 small modules with fixed content.
    Set-Content -Path (Join-Path $workspace 'README.md') -Value '# Workspace ukur TTOken Code' -Encoding utf8
    New-Item -ItemType Directory -Force -Path (Join-Path $workspace 'src') | Out-Null
    foreach ($index in 1..20) {
        Set-Content -Path (Join-Path $workspace ('src\module-{0:d2}.ts' -f $index)) -Encoding utf8 -Value @(
            "export const value$index = $index"
            "export function double$index(input: number): number { return input * 2 + value$index }"
        )
    }
    $info = [System.Diagnostics.ProcessStartInfo]::new($payloadNode)
    $info.UseShellExecute = $false
    $info.WorkingDirectory = $project
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in '--input-type=module', '--eval', (Get-Content -Raw (Join-Path $PSScriptRoot 'seed-fixture.mjs')), $harnessHome, $workspace) {
        $info.ArgumentList.Add($argument)
    }
    $seeder = [System.Diagnostics.Process]::Start($info)
    $output = $seeder.StandardOutput.ReadToEndAsync()
    $errors = $seeder.StandardError.ReadToEndAsync()
    $seeder.WaitForExit()
    Write-Host $output.Result
    if ($seeder.ExitCode -ne 0) { throw "seed-fixture gagal: $($errors.Result)" }
}

function Invoke-WarmUp {
    <#
    One unrecorded launch: close an open dialog, open each fixture Session once, then return to the start state and
    quit. With -AskUser the script first waits for Enter, so the user can fill in Electron's welcome screen.
    #>
    param([Parameter(Mandatory)] [object] $Arm, [int] $ComposerTimeoutSeconds = 180, [switch] $AskUser)
    # Leftovers of an interrupted run hold the Electron instance lock for the same --user-data-dir.
    Stop-Strays
    $port = Get-FreePort
    $launch = Start-Desktop -Arm $Arm -Port $port
    $session = $null
    try {
        $null = Wait-MainWindow -Launch $launch -TimeoutSeconds 600
        if ($AskUser) { $null = Read-Host 'Tekan Enter setelah jendela utama TTOken Code tampil' }
        $page = Find-CdpPage -Port $port -UrlPrefix $launch.Origin -TimeoutSeconds $ComposerTimeoutSeconds
        $session = Connect-Cdp -WebSocketUrl $page.webSocketDebuggerUrl
        Install-PageHelpers -Session $session
        $null = Wait-Composer -Session $session -TimeoutSeconds $ComposerTimeoutSeconds
        $dialog = Invoke-CdpScript -Session $session -Expression 'window.__ttokenMeasure.dialogButton()'
        if ($null -ne $dialog) {
            Invoke-CdpClick -Session $session -X $dialog.x -Y $dialog.y
            Start-Sleep -Seconds 1
        }
        foreach ($key in 'Long', 'A', 'B', 'C') { $null = Open-FixtureSession -Session $session -Key $key }
        $null = Reset-AfterLaunch -Launch $launch -Session $session
    }
    finally {
        if ($null -ne $session) { Disconnect-Cdp -Session $session }
        $null = Stop-Desktop -Launch $launch
    }
}

function Assert-CompileCache {
    <#
    Node writes its compile cache when the Host exits normally. An empty folder means the next launches would be
    measured without the cache, so the TauriCache measurement stops here instead of reporting "no difference".
    #>
    param([Parameter(Mandatory)] [System.Collections.IDictionary] $Result)
    $entries = @(Get-ChildItem -Path $compileCacheDirectory -Recurse -File -ErrorAction SilentlyContinue)
    if ($entries.Count -eq 0) { throw "compile cache Node kosong ($compileCacheDirectory): Host tidak keluar normal setelah pemanasan." }
    $megabytes = ($entries | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host ('Compile cache Node: {0} entri, {1:N1} MB' -f $entries.Count, $megabytes)
    $Result.settings['compileCacheEntries'] = $entries.Count
}

# Ninety minutes without input would let Windows turn the display off and sleep: a launch in flight would time out
# and the session would lock. While this script runs, Windows keeps the system and the display on.
Add-Type -Namespace TTokenMeasure -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
$null = [TTokenMeasure.Power]::SetThreadExecutionState(0x80000003) # ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
try {
    Assert-NoUserInstance

    if ($Setup) {
        Stop-Strays
        Write-Host "Folder kerja: $WorkRoot"
        Update-Payload
        Initialize-Fixture
        Write-Host ''
        Write-Host 'Langkah manual: TTOken Code (Electron) terbuka dengan home ukur. Isi API key TTOken Gateway di layar sambutan,'
        Write-Host 'tunggu jendela utama tampil, lalu tekan Enter di sini. Skrip melanjutkan sendiri dan menutup app.'
        Invoke-WarmUp -Arm $armCatalog.Electron -AskUser
        Invoke-WarmUp -Arm $armCatalog.Tauri
        Write-Host 'Setup selesai. Jalankan Measure-Desktop.ps1 tanpa parameter untuk mengukur ketiga build bergantian.'
        return
    }

    New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
    if (-not (Test-Path (Join-Path $harnessHome 'sessions'))) { throw "home ukur belum disiapkan; jalankan dulu: Measure-Desktop.ps1 -Setup" }
    Assert-OnPower
    # A cold start must not read the app's files before the launch, so the last extracted payload is used as it is.
    if (-not $Cold) { Update-Payload }
    elseif (-not (Test-Path (Join-Path $payload 'payload.json'))) { throw 'payload belum diekstrak; jalankan dulu: Measure-Desktop.ps1 -Setup' }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $runDirectory = Join-Path $resultsDirectory ('{0}-{1}' -f $(if ($Cold) { "$($arms[0].Label)-cold" } else { 'bergantian' }), $stamp)
    New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $machine = [ordered]@{ os = "$($os.Caption) $($os.Version)"; cpu = $cpu.Name; memoryBytes = [long] $os.TotalVisibleMemorySize * 1024; power = Get-PowerState }
    $results = [ordered]@{}
    foreach ($arm in $arms) {
        $results[$arm.Name] = [ordered]@{
            schema   = 2
            build    = $arm.Name
            label    = '{0}{1}' -f $arm.Label, $(if ($Cold) { '-cold' } else { '' })
            started  = (Get-Date).ToString('o')
            settings = [ordered]@{
                runs = $(if ($Cold) { 1 } else { $Runs }); idleSeconds = $IdleSeconds; scenarios = $(if ($Cold) { @('Cold') } else { $Scenario })
                compileCache = $arm.CompileCache; cold = $Cold.IsPresent; interleavedWith = @($arms | ForEach-Object Name); stamp = $stamp
            }
            machine  = $machine
            # Filled in after the launches, so a cold start is not preceded by reading the app's files.
            versions = $null
            records  = @()
        }
    }

    # A measurement that stops early, also through Ctrl+C, still writes the launches it finished, marked "aborted".
    # Ctrl+C skips catch blocks but runs finally blocks, so the results are written in one.
    $aborted = 'dihentikan sebelum selesai (Ctrl+C atau terminal ditutup)'
    try {
        if ($Cold) {
            $arm = $arms[0]
            $results[$arm.Name].settings['settle'] = Wait-SystemQuiet -Seconds $SettleSeconds
            if ($arm.CompileCache) { Assert-CompileCache -Result $results[$arm.Name] }
            Write-Host "Start dingin $($arm.Name): satu peluncuran tanpa pemanasan."
            $results[$arm.Name].records += Invoke-Launch -Arm $arm -ScenarioName Cold -Run 1 -RunDirectory $runDirectory
        }
        else {
            foreach ($arm in $arms) {
                Write-Host "Pemanasan $($arm.Name) (tidak dicatat)."
                Invoke-WarmUp -Arm $arm
                if ($arm.CompileCache) { Assert-CompileCache -Result $results[$arm.Name] }
            }
            foreach ($run in 1..$Runs) {
                for ($index = 0; $index -lt $Scenario.Count; $index++) {
                    $name = $Scenario[$index]
                    # The build order rotates per run and scenario, so no build always goes first.
                    $offset = ($run - 1 + $index) % $arms.Count
                    $order = @($arms[$offset..($arms.Count - 1)]) + @(if ($offset -gt 0) { $arms[0..($offset - 1)] })
                    foreach ($arm in $order) {
                        Write-Host ("{0} {1} run {2}/{3}" -f $arm.Name, $name, $run, $Runs)
                        $record = Invoke-Launch -Arm $arm -ScenarioName $name -Run $run -RunDirectory $runDirectory
                        $results[$arm.Name].records += $record
                        if ($record.reset -ne 'ok') {
                            # The next launch of this build would open another Session; an unrecorded launch puts the
                            # start state back. A launch that still starts elsewhere is left out by Compare-Desktop.ps1.
                            Write-Warning "$($arm.Name): keadaan awal tidak bisa dikembalikan ($($record.reset)); satu peluncuran pemulihan, tidak dicatat."
                            try { Invoke-WarmUp -Arm $arm }
                            catch { Write-Warning "peluncuran pemulihan $($arm.Name) gagal: $($_.Exception.Message)" }
                        }
                        Start-Sleep -Seconds 5
                    }
                }
            }
        }
        $aborted = $null
    }
    catch {
        $aborted = $_.Exception.Message
        Write-Warning "pengukuran berhenti: $aborted"
    }
    finally {
        $versions = [ordered]@{
            electron = (Get-Item $electron).VersionInfo.ProductVersion
            tauri    = $(if ($tauri) { (Get-Item $tauri).VersionInfo.ProductVersion } else { $null })
            host     = (Get-Content -Raw (Join-Path $project 'node_modules\@deepseek-ai\dsh-desktop-host\package.json') | ConvertFrom-Json).version
        }
        $lines = @("# Pengukuran $stamp", '', "Mesin: $($machine.os), $($machine.cpu); daya: $($machine.power.line), $($machine.power.scheme)", '')
        if ($null -ne $aborted) { $lines += "Pengukuran berhenti sebelum selesai: $aborted", '' }
        $paths = @()
        foreach ($arm in $arms) {
            $result = $results[$arm.Name]
            $result['aborted'] = $aborted
            $result.versions = $versions
            $jsonPath = Join-Path $runDirectory "$($result.label).json"
            $result | ConvertTo-Json -Depth 12 | Set-Content -Path $jsonPath -Encoding utf8
            $paths += $jsonPath
            $lines += "## $($arm.Name)", ''
            $lines += '| Skenario | Run sah | Memori total median (MB) | (a) jendela median (ms) | (a) dari saat boot | (b) composer median (ms) | (b) batas atas | Host mulai median (ms) | (c) ganti sesi median (ms) | Gagal | Mulai bukan dari sesi A |'
            $lines += '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
            foreach ($name in @($result.records | ForEach-Object scenario | Select-Object -Unique)) {
                $all = @($result.records | Where-Object scenario -EQ $name)
                $done = @($all | Where-Object { $null -eq $_.failure })
                # As in Compare-Desktop.ps1, only launches that started from Session A count.
                $valid = @($done | Where-Object { $_.startedOn -eq 'A' })
                $memory = Get-Median -Values @($valid | ForEach-Object { [double] $_.memory.medianTotal })
                $window = Get-Median -Values @($valid | Where-Object { $null -ne $_.windowMs } | ForEach-Object { [double] $_.windowMs })
                $fromBoot = @($valid | Where-Object { $_.windowFrom -eq 'boot-answered' }).Count
                $composerTimes = Get-Median -Values @($valid | ForEach-Object { [double] $_.composerMs })
                # A composer that was ready before its watcher was installed: the time is only an upper bound.
                $late = @($valid | Where-Object composerLate).Count
                $hostStart = Get-Median -Values @($valid | Where-Object { $null -ne $_.hostStartMs } | ForEach-Object { [double] $_.hostStartMs })
                $switches = Get-Median -Values @($valid | Where-Object { $_.details -and $_.details.Contains('switchMs') } | ForEach-Object { Get-Median -Values @($_.details.switchMs) })
                $lines += '| {0} | {1}/{2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} | {10} | {11} |' -f $name, $valid.Count, $all.Count,
                $(if ($null -ne $memory) { [Math]::Round($memory / 1MB, 1) } else { '-' }), $(if ($null -ne $window) { [Math]::Round($window) } else { '-' }),
                $fromBoot, $(if ($null -ne $composerTimes) { [Math]::Round($composerTimes) } else { '-' }), $late,
                $(if ($null -ne $hostStart) { [Math]::Round($hostStart) } else { '-' }),
                $(if ($null -ne $switches) { [Math]::Round($switches, 1) } else { '-' }), ($all.Count - $done.Count), ($done.Count - $valid.Count)
            }
            $lines += ''
        }
        $lines | Set-Content -Path (Join-Path $runDirectory 'summary.md') -Encoding utf8
        $lines | ForEach-Object { Write-Host $_ }
        Write-Host 'Hasil:'
        $paths | ForEach-Object { Write-Host "  $_" }
    }
    if ($null -ne $aborted) { throw "pengukuran berhenti sebelum selesai; hasil sebagian di $runDirectory" }
}
finally {
    # ES_CONTINUOUS alone ends the request; Windows may sleep again.
    $null = [TTokenMeasure.Power]::SetThreadExecutionState(0x80000000)
}
