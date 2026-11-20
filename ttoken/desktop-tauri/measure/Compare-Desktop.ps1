#Requires -Version 7.2
<#
.SYNOPSIS
Bandingkan dua hasil ukur (biasanya Electron lawan Tauri) dengan ambang gerbang Fase 0 (K1).

.DESCRIPTION
K1 (PRD-TAURI, bagian "Keputusan Naufal"): lanjut bila memori total lebih rendah di S1 sampai S3, dan (a), (b), (c)
lebih cepat, masing-masing dengan selisih lebih besar dari variasi antar-run, tanpa batas persentase minimum.

Nilai per run:
- memori: median lima sampel memori total satu peluncuran, per skenario;
- (a) dan (b): satu nilai per peluncuran, dari semua skenario; tiap peluncuran mulai dari keadaan yang sama;
- (c): median keenam ganti sesi dalam satu peluncuran S3.

Variasi antar-run sebuah metrik adalah rentang nilai per run (maksimum dikurangi minimum), diambil yang lebih besar dari
kedua hasil. Sebuah metrik lolos bila median hasil kedua lebih kecil dari median hasil pertama dengan selisih lebih
besar dari variasi itu. Gerbang lolos hanya bila keenam metrik lolos. Metrik yang kehilangan run (run gagal) atau
yang nilai (b) Electron-nya hanya batas atas tidak bisa dinilai; hasilnya "belum bisa dinilai", bukan "lolos".

Baris "Host mulai" tidak ikut K1: ia menunjukkan berapa bagian dari selisih (a) dan (b) yang datang dari urutan start
(Electron memuat halaman dulu baru menjalankan Host), bukan dari shell.

Untuk D12, pakai hasil Tauri tanpa cache sebagai -Electron dan hasil TauriCache sebagai -Tauri.

.PARAMETER Electron
File hasil pertama (pembanding), misalnya electron.json dari Measure-Desktop.ps1.

.PARAMETER Tauri
File hasil kedua (yang diuji), misalnya tauri.json atau tauri-cache.json.

.PARAMETER OutputPath
File Markdown untuk tabel hasil; tanpa parameter ini tabel hanya ditampilkan.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Electron,
    [Parameter(Mandatory)] [string] $Tauri,
    [string] $OutputPath
)

$ErrorActionPreference = 'Stop'
$electronResult = Get-Content -Raw $Electron | ConvertFrom-Json -Depth 30
$tauriResult = Get-Content -Raw $Tauri | ConvertFrom-Json -Depth 30
$first = $electronResult.label
$second = $tauriResult.label

function Get-Median {
    param([AllowEmptyCollection()] [double[]] $Values)
    if ($null -eq $Values -or $Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $middle = [int] [Math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2 -eq 1) { return $sorted[$middle] }
    ($sorted[$middle - 1] + $sorted[$middle]) / 2
}

function Get-RunValues {
    param([Parameter(Mandatory)] [object] $Result, [Parameter(Mandatory)] [string] $Metric)
    $records = @($Result.records | Where-Object { $null -eq $_.failure })
    switch -Regex ($Metric) {
        '^memory-(S[123])$' {
            $scenario = $Matches[1]
            return @($records | Where-Object scenario -EQ $scenario | ForEach-Object { [double] $_.memory.medianTotal })
        }
        '^window$' { return @($records | ForEach-Object { [double] $_.windowMs }) }
        '^composer$' { return @($records | ForEach-Object { [double] $_.composerMs }) }
        '^switch$' {
            return @($records | Where-Object { $_.scenario -eq 'S3' -and $null -ne $_.details } | ForEach-Object {
                    Get-Median -Values @($_.details.switchMs | ForEach-Object { [double] $_ })
                })
        }
        '^host$' {
            return @($records | Where-Object { $null -ne $_.PSObject.Properties['hostStartMs'] -and $null -ne $_.hostStartMs } |
                    ForEach-Object { [double] $_.hostStartMs })
        }
    }
}

function Get-ExpectedCount {
    <# Run yang seharusnya ada untuk sebuah metrik, dari pengaturan pengukuran. #>
    param([Parameter(Mandatory)] [object] $Result, [Parameter(Mandatory)] [string] $Metric)
    $runs = [int] $Result.settings.runs
    $scenarios = @($Result.settings.scenarios)
    switch -Regex ($Metric) {
        '^memory-(S[123])$' { if ($scenarios -contains $Matches[1]) { return $runs } return 0 }
        '^(window|composer)$' { return $runs * $scenarios.Count }
        '^switch$' { if ($scenarios -contains 'S3') { return $runs } return 0 }
    }
    0
}

$metrics = @(
    @{ Key = 'memory-S1'; Name = 'Memori total S1'; Unit = 'MB'; Scale = 1MB }
    @{ Key = 'memory-S2'; Name = 'Memori total S2'; Unit = 'MB'; Scale = 1MB }
    @{ Key = 'memory-S3'; Name = 'Memori total S3'; Unit = 'MB'; Scale = 1MB }
    @{ Key = 'window'; Name = '(a) jendela tampil'; Unit = 'ms'; Scale = 1 }
    @{ Key = 'composer'; Name = '(b) composer bisa diketik'; Unit = 'ms'; Scale = 1 }
    @{ Key = 'switch'; Name = '(c) ganti sesi'; Unit = 'ms'; Scale = 1 }
)

$rows = foreach ($metric in $metrics) {
    $electronValues = @(Get-RunValues -Result $electronResult -Metric $metric.Key)
    $tauriValues = @(Get-RunValues -Result $tauriResult -Metric $metric.Key)
    if ($electronValues.Count -eq 0 -or $tauriValues.Count -eq 0) {
        [pscustomobject]@{ Metric = $metric.Name; Unit = $metric.Unit; Electron = $null; Tauri = $null; Difference = $null; Variation = $null; Pass = $false; Undecided = $true; Note = 'tidak ada data' }
        continue
    }
    $electronMedian = Get-Median -Values $electronValues
    $tauriMedian = Get-Median -Values $tauriValues
    $variation = [Math]::Max(($electronValues | Measure-Object -Maximum -Minimum | ForEach-Object { $_.Maximum - $_.Minimum }),
        ($tauriValues | Measure-Object -Maximum -Minimum | ForEach-Object { $_.Maximum - $_.Minimum }))
    $difference = $electronMedian - $tauriMedian
    $pass = $difference -gt 0 -and $difference -gt $variation
    $undecided = $false
    $note = "$($electronValues.Count) dan $($tauriValues.Count) run"
    # Run yang gagal hilang dari nilai, dan yang tersisa bisa saja run tercepat. Metrik yang tetap kalah tetap "tidak";
    # yang tampak lolos belum bisa dinilai.
    $missing = @(
        @{ Label = $first; Have = $electronValues.Count; Want = Get-ExpectedCount -Result $electronResult -Metric $metric.Key }
        @{ Label = $second; Have = $tauriValues.Count; Want = Get-ExpectedCount -Result $tauriResult -Metric $metric.Key }
    ) | Where-Object { $_.Have -lt $_.Want }
    foreach ($gap in $missing) { $note += "; $($gap.Label) hanya $($gap.Have) dari $($gap.Want) run berhasil" }
    if (@($missing).Count -gt 0 -and $pass) {
        $pass = $false
        $undecided = $true
    }
    if ($metric.Key -eq 'composer') {
        # (b) yang terlambat diamati hanya batas atas; di hasil pertama, batas atas bisa membesar-besarkan keunggulan hasil kedua.
        $electronLate = @($electronResult.records | Where-Object { $null -eq $_.failure -and $_.composerLate }).Count
        $tauriLate = @($tauriResult.records | Where-Object { $null -eq $_.failure -and $_.composerLate }).Count
        if ($electronLate -gt 0 -and $pass) {
            $pass = $false
            $undecided = $true
        }
        if ($electronLate -gt 0) { $note += "; $electronLate run $first hanya batas atas, ulangi pengukurannya" }
        if ($tauriLate -gt 0) { $note += "; $tauriLate run $second hanya batas atas" }
    }
    if ($metric.Key -in 'window', 'composer') {
        $offState = @(@($electronResult.records) + @($tauriResult.records) | Where-Object {
                $null -eq $_.failure -and $null -ne $_.PSObject.Properties['startedOn'] -and $_.startedOn -ne 'A'
            }).Count
        if ($offState -gt 0) { $note += "; $offState peluncuran tidak mulai dari sesi A" }
    }
    [pscustomobject]@{
        Metric     = $metric.Name
        Unit       = $metric.Unit
        Electron   = $electronMedian / $metric.Scale
        Tauri      = $tauriMedian / $metric.Scale
        Difference = $difference / $metric.Scale
        Variation  = $variation / $metric.Scale
        Pass       = $pass
        Undecided  = $undecided
        Note       = $note
    }
}

$format = { param($value) if ($null -eq $value) { '-' } else { '{0:N1}' -f $value } }
$lines = @(
    "# Gerbang Fase 0 (K1): $first lawan $second"
    ''
    "$($first): $Electron  "
    "$($second): $Tauri  "
    "Mesin: $($tauriResult.machine.os), $($tauriResult.machine.cpu)"
    ''
)
# Selisih hanya berarti bila kedua hasil diukur bergantian pada waktu dan mode daya yang sama.
$stampOf = { param($result) if ($null -ne $result.settings -and $null -ne $result.settings.PSObject.Properties['stamp']) { $result.settings.stamp } }
$sameRun = $null -ne (& $stampOf $electronResult) -and (& $stampOf $electronResult) -eq (& $stampOf $tauriResult)
if (-not $sameRun) {
    $lines += 'Peringatan: kedua hasil tidak diukur bergantian dalam satu pemanggilan Measure-Desktop.ps1, jadi waktu pengukuran ikut memengaruhi selisihnya.', ''
}
$powerOf = { param($result) if ($null -ne $result.machine) { $result.machine.PSObject.Properties['power'] } }
$powerFirst = & $powerOf $electronResult
$powerSecond = & $powerOf $tauriResult
if ($null -ne $powerFirst -and $null -ne $powerSecond -and (($powerFirst.Value | ConvertTo-Json -Compress) -ne ($powerSecond.Value | ConvertTo-Json -Compress))) {
    $lines += 'Peringatan: sumber atau skema daya berbeda di kedua hasil.', ''
}
$lines += "| Metrik | $first (median) | $second (median) | Selisih ($first dikurangi $second) | Variasi antar-run | Lolos | Catatan |"
$lines += '| --- | --- | --- | --- | --- | --- | --- |'
foreach ($row in $rows) {
    $verdict = if ($row.Pass) { 'ya' } elseif ($row.Undecided) { 'belum bisa dinilai' } else { 'tidak' }
    $lines += '| {0} ({1}) | {2} | {3} | {4} | {5} | {6} | {7} |' -f $row.Metric, $row.Unit, (& $format $row.Electron), (& $format $row.Tauri),
    (& $format $row.Difference), (& $format $row.Variation), $verdict, $row.Note
}
$electronHost = Get-Median -Values @(Get-RunValues -Result $electronResult -Metric host)
$tauriHost = Get-Median -Values @(Get-RunValues -Result $tauriResult -Metric host)
if ($null -ne $electronHost -and $null -ne $tauriHost) {
    $lines += '| Host mulai (ms sejak start, bukan bagian K1) | {0} | {1} | {2} | - | - | Bagian selisih (a) dan (b) yang datang dari urutan start, bukan dari shell |' -f
    (& $format $electronHost), (& $format $tauriHost), (& $format ($electronHost - $tauriHost))
}

$passed = @($rows | Where-Object Pass).Count -eq $rows.Count
$incomplete = @(@($electronResult, $tauriResult) | Where-Object { $null -ne $_.PSObject.Properties['aborted'] -and $_.aborted })
$lines += ''
if ($incomplete.Count -gt 0) {
    $lines += 'Hasil: **belum bisa dinilai**; pengukuran ' + (($incomplete | ForEach-Object label) -join ' dan ') +
    ' berhenti sebelum selesai. Ulangi sebelum memutuskan K1.'
}
elseif ($passed) {
    $lines += 'Hasil: **lolos K1**, semua metrik lebih baik dengan selisih di atas variasi antar-run.'
}
elseif (@($rows | Where-Object { -not $_.Pass -and -not $_.Undecided }).Count -eq 0) {
    $lines += 'Hasil: **belum bisa dinilai**; metrik yang ditandai "belum bisa dinilai" kehilangan run atau hanya punya batas atas. Ulangi pengukurannya.'
}
else {
    $lines += 'Hasil: **tidak lolos K1**; metrik yang tidak lolos ditandai "tidak".'
}

if ($OutputPath) { $lines | Set-Content -Path $OutputPath -Encoding utf8 }
$lines | ForEach-Object { Write-Host $_ }
