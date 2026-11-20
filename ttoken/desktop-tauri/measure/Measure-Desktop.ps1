#Requires -Version 7.2
<#
.SYNOPSIS
Ukur RAM dan waktu TTOken Code Desktop, build Electron dan prototipe Tauri, untuk gerbang Fase 0 PRD-TAURI.

.DESCRIPTION
Skrip ini menjalankan skenario S1 sampai S3 dari PRD (ttoken/docs/PRD-TAURI.md, bagian "Cara mengukur") di Windows 11,
dengan home Harness terpisah supaya data harian tidak tersentuh. Kedua build memakai Host dan Web client yang sama:
prototipe Tauri menjalankan payload instalasi Electron. Electron menyimpan project dsh di dalam app.asar, yang tidak
bisa dibaca Node biasa, jadi skrip ini mengekstraknya dulu ke folder kerja (scripts/extract-payload.mjs).

Build diukur bergantian dalam satu pemanggilan: tiap run dan skenario meluncurkan semua build yang dipilih, dengan
urutan yang diputar, jadi panas, mode daya, dan pekerjaan latar mengenai semua build sama rata. Tiap peluncuran mulai
dari keadaan yang sama: sesi A terbuka dan sidebar kanan bawaan, karena akhir peluncuran sebelumnya mengembalikannya.

Tiap peluncuran mencatat:
- (a) waktu dari start proses sampai jendela utama tampil;
- (b) waktu sampai composer bisa diketik;
- (c) waktu ganti sesi (S3), dari tekan tombol mouse sampai jawaban terakhir sesi tujuan tampil;
- memori: jumlah private working set seluruh pohon proses app, beserta angka per jenis proses;
- hostStartMs: kapan proses Host dibuat, sejak start. Electron memuat halaman dulu baru menjalankan Host, prototipe
  menjalankan Host sambil memuat halaman; selisih ini masuk ke selisih (a) dan (b), padahal bukan sifat Tauri.

Langkah:
1. Pasang build Electron dari CI (installer ttoken-code-windows-x64-unsigned), lalu jalankan -Setup sekali.
2. Jalankan tanpa parameter: Electron, Tauri, dan Tauri dengan compile cache diukur bergantian.
3. Bandingkan hasilnya dengan Compare-Desktop.ps1.
Start dingin: reboot, lalu -Build Electron -Cold; reboot lagi, lalu -Build Tauri -Cold.

.PARAMETER Setup
Siapkan home ukur: ekstrak payload, workspace kecil, sesi sintetis S2 dan S3, satu peluncuran Electron untuk mengisi
API key di layar sambutan, lalu pemanasan kedua build.

.PARAMETER Build
Build yang diukur bergantian: Electron, Tauri, dan TauriCache (Tauri dengan compile cache Node, D12). Bawaannya
ketiganya. Dengan -Cold, tepat satu build.

.PARAMETER Scenario
Skenario yang dijalankan; bawaan S1, S2, dan S3.

.PARAMETER Runs
Jumlah peluncuran per skenario dan build; laporan memakai median.

.PARAMETER Cold
Satu peluncuran tanpa pemanasan, untuk start dingin setelah reboot.

.PARAMETER SettleSeconds
Untuk -Cold: berapa detik CPU dan disk harus tenang sebelum peluncuran (paling lama ditunggu 15 menit).

.PARAMETER IdleSeconds
Lama idle S1 setelah composer siap.

.PARAMETER ElectronExe
Path "TTOken Code.exe"; bawaannya dicari di %LOCALAPPDATA%\Programs.

.PARAMETER TauriExe
Path ttoken-code-desktop.exe; bawaannya di samping folder measure (isi artifact CI).

.PARAMETER WorkRoot
Folder kerja: home Harness, workspace, data Electron, cache, payload, dan hasil.
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

# Build yang bisa diukur. TauriCache adalah prototipe yang sama dengan compile cache Node (D12).
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
# Payload untuk Node biasa: project dsh hasil ekstrak app.asar, dan runtime yang ditautkan ke instalasi Electron.
$payload = Join-Path $WorkRoot 'payload'
$project = Join-Path $payload 'dsh'
$extractor = Join-Path $PSScriptRoot '..' 'scripts' 'extract-payload.mjs'
$tauri = if (@($arms | Where-Object Shell -EQ 'Tauri').Count -gt 0) { Resolve-TauriExe } else { $null }

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

function Get-PowerState {
    <# Sumber daya dan skema daya Windows; skema dan mode daya mengubah frekuensi CPU. #>
    Add-Type -AssemblyName System.Windows.Forms
    $overlay = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes' -ErrorAction SilentlyContinue
    [ordered]@{
        line    = [string] [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus
        scheme  = ((& powercfg /getactivescheme) -join ' ').Trim()
        overlay = $(if ($null -ne $overlay -and $overlay.PSObject.Properties['ActiveOverlayAcPowerScheme']) { [string] $overlay.ActiveOverlayAcPowerScheme } else { $null })
    }
}

function Assert-OnPower {
    <# Dengan baterai, Windows menurunkan frekuensi CPU; pengukuran hanya jalan dengan charger terpasang. #>
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
    # Hanya build TauriCache yang memakai compile cache, apa pun isi environment pemanggil.
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
    <# Tutup app dengan cara biasa: Tauri lewat WM_CLOSE; Electron lewat instance kedua --quit-for-installer, karena menutup jendelanya hanya menyembunyikan app ke tray. #>
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
    TTOken Code milik user harus ditutup dulu: Stop-Strays menghentikan paksa proses dengan path yang sama, dan app yang
    berjalan ikut mengganggu angka. Proses utama instance user tidak membawa --type, --user-data-dir, atau entry Host.
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
    Hentikan sisa proses dari run sebelumnya: shell kedua build dan Node dari payload, lewat path asli atau tautannya.
    Bila TTOken Code milik user dibuka di tengah pengukuran, skrip berhenti alih-alih menghentikannya.
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
    <# Start dingin: tunggu sampai CPU dan disk tenang selama $Seconds detik berturut-turut, paling lama 15 menit. #>
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
    <# Kejadian pertama bernama $Name di timeline shell Tauri, atau $null. #>
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
    Kembalikan halaman ke keadaan awal untuk peluncuran berikutnya (sesi A, sidebar kanan bawaan). Dijalankan setelah
    pengukuran peluncuran ini selesai, jadi tidak mengubah angkanya.
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
        scenario = $ScenarioName; run = $Run; launchedAt = $null; windowMs = $null; composerMs = $null; composerLate = $null
        startedOn = $null; hostStartMs = $null; details = $null; memory = $null; reset = $null; stop = $null; failure = $null
    }
    $launch = Start-Desktop -Arm $Arm -Port $port -Timeline $timeline
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
        # Sesi yang dipulihkan saat start; harusnya A di tiap peluncuran.
        $record.startedOn = Get-OpenFixture -Session $session
        switch ($ScenarioName) {
            'S2' { $record.details = Invoke-ScenarioS2 -Session $session }
            'S3' { $record.details = Invoke-ScenarioS3 -Session $session }
            default { }
        }
        # Sampel memori diambil tanpa koneksi DevTools, sama untuk kedua build.
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
        # Jendela yang tampil karena batas 30 detik prototipe berarti halaman belum boot; (a) itu bukan waktu, melainkan batas.
        if ($timeline) {
            $shown = Get-TimelineEvent -Path $timeline -Name 'window-shown'
            if ($null -ne $shown -and $shown.PSObject.Properties['detail'] -and $shown.detail -eq 'deadline') {
                throw 'jendela prototipe tampil karena batas 30 detik, bukan karena halaman boot'
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
    Satu peluncuran yang tidak dicatat: tutup dialog yang terbuka, buka tiap sesi fixture sekali, lalu kembali ke
    keadaan awal dan keluar. Dengan -AskUser, skrip menunggu Enter dulu, supaya user sempat mengisi layar sambutan
    Electron.
    #>
    param([Parameter(Mandatory)] [object] $Arm, [int] $ComposerTimeoutSeconds = 180, [switch] $AskUser)
    # Sisa run yang terputus memegang kunci instance Electron dengan --user-data-dir yang sama.
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
# Start dingin tidak boleh membaca file app sebelum peluncuran, jadi payload hasil ekstrak terakhir dipakai apa adanya.
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
        # Diisi setelah peluncuran, supaya start dingin tidak didahului pembacaan file app.
        versions = $null
        records  = @()
    }
}

function Assert-CompileCache {
    <#
    Node menulis compile cache saat Host keluar normal. Folder kosong berarti peluncuran berikutnya diukur tanpa cache,
    jadi pengukuran TauriCache berhenti di sini daripada melaporkan "tidak ada perbedaan".
    #>
    param([Parameter(Mandatory)] [System.Collections.IDictionary] $Result)
    $entries = @(Get-ChildItem -Path $compileCacheDirectory -Recurse -File -ErrorAction SilentlyContinue)
    if ($entries.Count -eq 0) { throw "compile cache Node kosong ($compileCacheDirectory): Host tidak keluar normal setelah pemanasan." }
    $megabytes = ($entries | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host ('Compile cache Node: {0} entri, {1:N1} MB' -f $entries.Count, $megabytes)
    $Result.settings['compileCacheEntries'] = $entries.Count
}

# Bila pengukuran berhenti di tengah, run yang sudah selesai tetap ditulis, ditandai "aborted".
$aborted = $null
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
                # Urutan build diputar per run dan skenario, supaya tidak ada build yang selalu jalan pertama.
                $offset = ($run - 1 + $index) % $arms.Count
                $order = @($arms[$offset..($arms.Count - 1)]) + @(if ($offset -gt 0) { $arms[0..($offset - 1)] })
                foreach ($arm in $order) {
                    Write-Host ("{0} {1} run {2}/{3}" -f $arm.Name, $name, $run, $Runs)
                    $results[$arm.Name].records += Invoke-Launch -Arm $arm -ScenarioName $name -Run $run -RunDirectory $runDirectory
                    Start-Sleep -Seconds 5
                }
            }
        }
    }
}
catch {
    $aborted = $_.Exception.Message
    Write-Warning "pengukuran berhenti: $aborted"
}

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
    $lines += '| Skenario | Run sukses | Memori total median (MB) | (a) jendela median (ms) | (b) composer median (ms) | (b) batas atas | Host mulai median (ms) | Mulai bukan dari sesi A | (c) ganti sesi median (ms) |'
    $lines += '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    foreach ($name in @($result.records | ForEach-Object scenario | Select-Object -Unique)) {
        $ok = @($result.records | Where-Object { $_.scenario -eq $name -and $null -eq $_.failure })
        $memory = Get-Median -Values @($ok | ForEach-Object { [double] $_.memory.medianTotal })
        $window = Get-Median -Values @($ok | ForEach-Object { [double] $_.windowMs })
        $composerTimes = Get-Median -Values @($ok | ForEach-Object { [double] $_.composerMs })
        # Composer yang sudah siap sebelum pengamat terpasang: waktunya hanya batas atas.
        $late = @($ok | Where-Object composerLate).Count
        $hostStart = Get-Median -Values @($ok | Where-Object { $null -ne $_.hostStartMs } | ForEach-Object { [double] $_.hostStartMs })
        $offState = @($ok | Where-Object { $_.startedOn -ne 'A' }).Count
        $switches = Get-Median -Values @($ok | Where-Object { $_.details -and $_.details.Contains('switchMs') } | ForEach-Object { Get-Median -Values @($_.details.switchMs) })
        $lines += '| {0} | {1}/{2} | {3} | {4} | {5} | {6} | {7} | {8} | {9} |' -f $name, $ok.Count, @($result.records | Where-Object scenario -EQ $name).Count,
        $(if ($null -ne $memory) { [Math]::Round($memory / 1MB, 1) } else { '-' }), $(if ($null -ne $window) { [Math]::Round($window) } else { '-' }),
        $(if ($null -ne $composerTimes) { [Math]::Round($composerTimes) } else { '-' }), $late,
        $(if ($null -ne $hostStart) { [Math]::Round($hostStart) } else { '-' }), $offState,
        $(if ($null -ne $switches) { [Math]::Round($switches, 1) } else { '-' })
    }
    $lines += ''
}
$lines | Set-Content -Path (Join-Path $runDirectory 'summary.md') -Encoding utf8
$lines | ForEach-Object { Write-Host $_ }
Write-Host 'Hasil:'
$paths | ForEach-Object { Write-Host "  $_" }
if ($null -ne $aborted) { throw "pengukuran berhenti sebelum selesai; hasil sebagian di $runDirectory" }
