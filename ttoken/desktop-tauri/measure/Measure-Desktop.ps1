#Requires -Version 7.2
<#
.SYNOPSIS
Ukur RAM dan waktu TTOken Code Desktop, build Electron atau prototipe Tauri, untuk gerbang Fase 0 PRD-TAURI.

.DESCRIPTION
Skrip ini menjalankan skenario S1 sampai S3 dari PRD (ttoken/docs/PRD-TAURI.md, bagian "Cara mengukur") di Windows 11,
dengan home Harness terpisah supaya data harian tidak tersentuh. Kedua build memakai Host dan Web client yang sama:
prototipe Tauri menjalankan payload instalasi Electron. Electron menyimpan project dsh di dalam app.asar, yang tidak
bisa dibaca Node biasa, jadi skrip ini mengekstraknya dulu ke folder kerja (scripts/extract-payload.mjs).

Tiap peluncuran mencatat:
- (a) waktu dari start proses sampai jendela utama tampil;
- (b) waktu sampai composer bisa diketik;
- (c) waktu ganti sesi (S3), dari tekan tombol mouse sampai jawaban terakhir sesi tujuan tampil;
- memori: jumlah private working set seluruh pohon proses app, beserta angka per jenis proses.

Langkah:
1. Pasang build Electron dari CI (installer ttoken-code-windows-x64-unsigned), lalu jalankan -Setup sekali.
2. Jalankan -Build Electron dan -Build Tauri (opsional -Build Tauri -CompileCache untuk D12).
3. Bandingkan hasilnya dengan Compare-Desktop.ps1.
Start dingin: reboot, lalu -Build Electron -Cold; reboot lagi, lalu -Build Tauri -Cold.

.PARAMETER Setup
Siapkan home ukur: workspace kecil, sesi sintetis S2 dan S3, satu peluncuran Electron untuk mengisi API key di layar
sambutan, lalu pemanasan kedua build.

.PARAMETER Build
Build yang diukur: Electron atau Tauri.

.PARAMETER Scenario
Skenario yang dijalankan; bawaan S1, S2, dan S3.

.PARAMETER Runs
Jumlah peluncuran per skenario; laporan memakai median.

.PARAMETER Cold
Satu peluncuran tanpa pemanasan, untuk start dingin setelah reboot.

.PARAMETER CompileCache
Hanya untuk Tauri: jalankan Host dengan compile cache Node (D12) di folder kerja.

.PARAMETER IdleSeconds
Lama idle S1 setelah composer siap.

.PARAMETER ElectronExe
Path "TTOken Code.exe"; bawaannya dicari di %LOCALAPPDATA%\Programs.

.PARAMETER TauriExe
Path ttoken-code-desktop.exe; bawaannya di samping folder measure (isi artifact CI).

.PARAMETER WorkRoot
Folder kerja: home Harness, workspace, data Electron, cache, dan hasil.
#>
[CmdletBinding(DefaultParameterSetName = 'Measure')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Setup')] [switch] $Setup,
    [Parameter(Mandatory, ParameterSetName = 'Measure')] [ValidateSet('Electron', 'Tauri')] [string] $Build,
    [Parameter(ParameterSetName = 'Measure')] [ValidateSet('S1', 'S2', 'S3')] [string[]] $Scenario = @('S1', 'S2', 'S3'),
    [Parameter(ParameterSetName = 'Measure')] [ValidateRange(1, 50)] [int] $Runs = 5,
    [Parameter(ParameterSetName = 'Measure')] [switch] $Cold,
    [Parameter(ParameterSetName = 'Measure')] [switch] $CompileCache,
    [ValidateRange(10, 3600)] [int] $IdleSeconds = 120,
    [string] $ElectronExe,
    [string] $TauriExe,
    [string] $WorkRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ttoken-measure')
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Pengukuran Fase 0 dijalankan di Windows 11.' }
if ($CompileCache -and $Build -ne 'Tauri') { throw '-CompileCache hanya untuk -Build Tauri.' }
Import-Module (Join-Path $PSScriptRoot 'DesktopProcess.psm1'), (Join-Path $PSScriptRoot 'Cdp.psm1'),
(Join-Path $PSScriptRoot 'Scenario.psm1') -Force

$harnessHome = Join-Path $WorkRoot 'home'
$workspace = Join-Path $WorkRoot 'workspace'
$electronUserData = Join-Path $WorkRoot 'electron-userdata'
$compileCacheDirectory = Join-Path $WorkRoot 'node-compile-cache'
$resultsDirectory = Join-Path $WorkRoot 'results'
$origins = @{ Electron = 'dsh-app://app/'; Tauri = 'http://ttoken-app.localhost/' }

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
# Payload untuk Node biasa: project dsh hasil ekstrak app.asar, dan runtime yang ditautkan ke instalasi Electron.
$payload = Join-Path $WorkRoot 'payload'
$project = Join-Path $payload 'dsh'
$extractor = Join-Path $PSScriptRoot '..' 'scripts' 'extract-payload.mjs'
$tauri = if ($Setup -or $Build -eq 'Tauri') { Resolve-TauriExe } else { $null }

function Update-Payload {
    <# Ekstrak project dsh dari app.asar instalasi Electron; tidak melakukan apa-apa bila app.asar belum berubah. #>
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

function Start-Desktop {
    param([Parameter(Mandatory)] [string] $Name, [Parameter(Mandatory)] [int] $Port, [string] $Timeline)
    $info = [System.Diagnostics.ProcessStartInfo]::new()
    $info.UseShellExecute = $false
    $info.Environment['DSH_HOME'] = $harnessHome
    if ($Name -eq 'Electron') {
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
        if ($CompileCache) { $info.Environment['NODE_COMPILE_CACHE'] = $compileCacheDirectory }
    }
    $launchedAt = Get-UnixMilliseconds
    $process = [System.Diagnostics.Process]::Start($info)
    [pscustomobject]@{ Name = $Name; Process = $process; LaunchedAt = $launchedAt; Port = $Port; Origin = $origins[$Name] }
}

function Stop-Desktop {
    <# Tutup app dengan cara biasa: Tauri lewat WM_CLOSE; Electron lewat instance kedua --quit-for-installer, karena menutup jendelanya hanya menyembunyikan app ke tray. #>
    param([Parameter(Mandatory)] [object] $Launch)
    $tree = @(Get-ProcessTree -RootId $Launch.Process.Id)
    if (-not $Launch.Process.HasExited) {
        if ($Launch.Name -eq 'Electron') {
            $info = [System.Diagnostics.ProcessStartInfo]::new($electron)
            $info.UseShellExecute = $false
            $info.Environment['DSH_HOME'] = $harnessHome
            $info.ArgumentList.Add('--quit-for-installer')
            $info.ArgumentList.Add("--user-data-dir=$electronUserData")
            $quitter = [System.Diagnostics.Process]::Start($info)
            $null = $quitter.WaitForExit(30000)
        }
        else {
            $Launch.Process.Refresh()
            $null = $Launch.Process.CloseMainWindow()
        }
    }
    $graceful = $Launch.Process.WaitForExit(30000)
    $deadline = (Get-Date).AddSeconds(15)
    while (@(Get-RemainingProcesses -Tree $tree).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    $left = @(Get-RemainingProcesses -Tree $tree)
    Stop-ProcessTree -Tree $left
    [ordered]@{ graceful = $graceful; leftover = @($left | ForEach-Object { "$($_.Name) ($($_.Id))" }) }
}

function Stop-Strays {
    <# Hentikan sisa proses dari run sebelumnya: shell kedua build dan Node dari payload, lewat path asli atau tautannya. #>
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

function Invoke-Launch {
    param([Parameter(Mandatory)] [string] $ScenarioName, [int] $Run, [string] $RunDirectory)
    Stop-Strays
    $port = Get-FreePort
    $timeline = if ($RunDirectory) { Join-Path $RunDirectory ('{0}-{1}-{2}.timeline.jsonl' -f $Build.ToLower(), $ScenarioName, $Run) } else { $null }
    $record = [ordered]@{
        scenario = $ScenarioName; run = $Run; launchedAt = $null; windowMs = $null; composerMs = $null; composerLate = $null
        details = $null; memory = $null; stop = $null; failure = $null
    }
    $launch = Start-Desktop -Name $Build -Port $port -Timeline $timeline
    $record.launchedAt = $launch.LaunchedAt
    $session = $null
    try {
        $record.windowMs = Wait-MainWindow -Launch $launch
        $page = Find-CdpPage -Port $port -UrlPrefix $launch.Origin -TimeoutSeconds 180
        $session = Connect-Cdp -WebSocketUrl $page.webSocketDebuggerUrl
        Install-PageHelpers -Session $session
        $composer = Wait-Composer -Session $session -TimeoutSeconds 180
        $record.composerMs = [long] $composer.at - $launch.LaunchedAt
        $record.composerLate = [bool] $composer.late
        switch ($ScenarioName) {
            'S2' { $record.details = Invoke-ScenarioS2 -Session $session }
            'S3' { $record.details = Invoke-ScenarioS3 -Session $session }
            default { }
        }
        # Sampel memori diambil tanpa koneksi DevTools, sama untuk kedua build.
        Disconnect-Cdp -Session $session
        $session = $null
        Start-Sleep -Seconds $(if ($ScenarioName -eq 'S1' -or $ScenarioName -eq 'Cold') { $IdleSeconds } else { 10 })
        $samples = @(foreach ($index in 1..5) {
                Get-TreeMemory -RootId $launch.Process.Id
                if ($index -lt 5) { Start-Sleep -Seconds 1 }
            })
        $record.memory = Measure-Memory -Samples $samples
    }
    catch {
        $record.failure = $_.Exception.Message
        Write-Warning "$ScenarioName run $Run gagal: $($record.failure)"
    }
    finally {
        if ($null -ne $session) { Disconnect-Cdp -Session $session }
        $record.stop = Stop-Desktop -Launch $launch
    }
    $record
}

function Initialize-Fixture {
    New-Item -ItemType Directory -Force -Path $harnessHome, $workspace, $electronUserData, $resultsDirectory | Out-Null
    # Workspace kecil: README dan 20 modul kecil, isinya tetap.
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
    Satu peluncuran yang tidak dicatat: tutup dialog yang terbuka, buka tiap sesi fixture sekali, lalu keluar.
    Dengan -AskUser, skrip menunggu Enter dulu, supaya user sempat mengisi layar sambutan Electron.
    #>
    param([int] $ComposerTimeoutSeconds = 180, [switch] $AskUser)
    $port = Get-FreePort
    $launch = Start-Desktop -Name $Build -Port $port
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
    }
    finally {
        if ($null -ne $session) { Disconnect-Cdp -Session $session }
        $null = Stop-Desktop -Launch $launch
    }
}

if ($Setup) {
    Stop-Strays
    Write-Host "Folder kerja: $WorkRoot"
    Update-Payload
    Initialize-Fixture
    Write-Host ''
    Write-Host 'Langkah manual: TTOken Code (Electron) terbuka dengan home ukur. Isi API key TTOken Gateway di layar sambutan,'
    Write-Host 'tunggu jendela utama tampil, lalu tekan Enter di sini. Skrip melanjutkan sendiri dan menutup app.'
    $script:Build = 'Electron'
    Invoke-WarmUp -AskUser
    $script:Build = 'Tauri'
    Invoke-WarmUp
    Write-Host 'Setup selesai. Jalankan -Build Electron dan -Build Tauri.'
    return
}

New-Item -ItemType Directory -Force -Path $resultsDirectory | Out-Null
if (-not (Test-Path (Join-Path $harnessHome 'sessions'))) { throw "home ukur belum disiapkan; jalankan dulu: Measure-Desktop.ps1 -Setup" }
# Start dingin tidak boleh membaca file app sebelum peluncuran, jadi payload hasil ekstrak terakhir dipakai apa adanya.
if (-not $Cold) { Update-Payload }
elseif (-not (Test-Path (Join-Path $payload 'payload.json'))) { throw 'payload belum diekstrak; jalankan dulu: Measure-Desktop.ps1 -Setup' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$label = '{0}{1}{2}' -f $Build.ToLower(), $(if ($CompileCache) { '-cache' } else { '' }), $(if ($Cold) { '-cold' } else { '' })
$runDirectory = Join-Path $resultsDirectory "$label-$stamp"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$result = [ordered]@{
    schema   = 1
    build    = $Build
    label    = $label
    started  = (Get-Date).ToString('o')
    settings = [ordered]@{ runs = $(if ($Cold) { 1 } else { $Runs }); idleSeconds = $IdleSeconds; scenarios = $(if ($Cold) { @('Cold') } else { $Scenario }); compileCache = $CompileCache.IsPresent; cold = $Cold.IsPresent }
    machine  = [ordered]@{ os = "$($os.Caption) $($os.Version)"; cpu = $cpu.Name; memoryBytes = [long] $os.TotalVisibleMemorySize * 1024 }
    # Diisi setelah peluncuran, supaya start dingin tidak didahului pembacaan file app.
    versions = $null
    records  = @()
}

function Assert-CompileCache {
    <#
    Node menulis compile cache saat Host keluar normal. Folder kosong berarti peluncuran berikutnya diukur tanpa cache,
    jadi pengukuran -CompileCache berhenti di sini daripada melaporkan "tidak ada perbedaan".
    #>
    $entries = @(Get-ChildItem -Path $compileCacheDirectory -Recurse -File -ErrorAction SilentlyContinue)
    if ($entries.Count -eq 0) { throw "compile cache Node kosong ($compileCacheDirectory): Host tidak keluar normal setelah pemanasan." }
    $megabytes = ($entries | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host ('Compile cache Node: {0} entri, {1:N1} MB' -f $entries.Count, $megabytes)
    $result.settings['compileCacheEntries'] = $entries.Count
}

if ($Cold) {
    Write-Host 'Start dingin: satu peluncuran tanpa pemanasan.'
    if ($CompileCache) { Assert-CompileCache }
    $result.records += Invoke-Launch -ScenarioName Cold -Run 1 -RunDirectory $runDirectory
}
else {
    Write-Host 'Pemanasan (tidak dicatat).'
    Invoke-WarmUp
    if ($CompileCache) { Assert-CompileCache }
    foreach ($run in 1..$Runs) {
        foreach ($name in $Scenario) {
            Write-Host ("{0} {1} run {2}/{3}" -f $Build, $name, $run, $Runs)
            $result.records += Invoke-Launch -ScenarioName $name -Run $run -RunDirectory $runDirectory
            Start-Sleep -Seconds 5
        }
    }
}

$result.versions = [ordered]@{
    electron = (Get-Item $electron).VersionInfo.ProductVersion
    tauri    = $(if ($tauri) { (Get-Item $tauri).VersionInfo.ProductVersion } else { $null })
    host     = (Get-Content -Raw (Join-Path $project 'node_modules\@deepseek-ai\dsh-desktop-host\package.json') | ConvertFrom-Json).version
}
$jsonPath = Join-Path $runDirectory 'result.json'
$result | ConvertTo-Json -Depth 12 | Set-Content -Path $jsonPath -Encoding utf8

$lines = @("# $label ($stamp)", '', "Mesin: $($result.machine.os), $($result.machine.cpu)", '',
    '| Skenario | Run sukses | Memori total median (MB) | (a) jendela median (ms) | (b) composer median (ms) | (c) ganti sesi median (ms) |',
    '| --- | --- | --- | --- | --- | --- |')
foreach ($name in @($result.records | ForEach-Object scenario | Select-Object -Unique)) {
    $ok = @($result.records | Where-Object { $_.scenario -eq $name -and $null -eq $_.failure })
    $memory = Get-Median -Values @($ok | ForEach-Object { [double] $_.memory.medianTotal })
    $window = Get-Median -Values @($ok | ForEach-Object { [double] $_.windowMs })
    $composerTimes = Get-Median -Values @($ok | ForEach-Object { [double] $_.composerMs })
    $switches = Get-Median -Values @($ok | Where-Object { $_.details -and $_.details.Contains('switchMs') } | ForEach-Object { Get-Median -Values @($_.details.switchMs) })
    $lines += '| {0} | {1}/{2} | {3} | {4} | {5} | {6} |' -f $name, $ok.Count, @($result.records | Where-Object scenario -EQ $name).Count,
    $(if ($null -ne $memory) { [Math]::Round($memory / 1MB, 1) } else { '-' }), $(if ($null -ne $window) { [Math]::Round($window) } else { '-' }),
    $(if ($null -ne $composerTimes) { [Math]::Round($composerTimes) } else { '-' }), $(if ($null -ne $switches) { [Math]::Round($switches, 1) } else { '-' })
}
$lines | Set-Content -Path (Join-Path $runDirectory 'summary.md') -Encoding utf8
$lines | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host "Hasil: $jsonPath"
