#Requires -Version 7.2
<#
.SYNOPSIS
Bandingkan hasil ukur Electron dan Tauri dengan ambang gerbang Fase 0 (K1).

.DESCRIPTION
K1 (PRD-TAURI, bagian "Keputusan Naufal"): lanjut bila memori total lebih rendah di S1 sampai S3, dan (a), (b), (c)
lebih cepat, masing-masing dengan selisih lebih besar dari variasi antar-run, tanpa batas persentase minimum.

Nilai per run:
- memori: median lima sampel memori total satu peluncuran, per skenario;
- (a) dan (b): satu nilai per peluncuran, dari semua skenario;
- (c): median keenam ganti sesi dalam satu peluncuran S3.

Variasi antar-run sebuah metrik adalah rentang nilai per run (maksimum dikurangi minimum), diambil yang lebih besar dari
kedua build. Sebuah metrik lolos bila median Tauri lebih kecil dari median Electron dengan selisih lebih besar dari
variasi itu. Gerbang lolos hanya bila keenam metrik lolos.

.PARAMETER Electron
result.json dari Measure-Desktop.ps1 -Build Electron.

.PARAMETER Tauri
result.json dari Measure-Desktop.ps1 -Build Tauri (atau -Build Tauri -CompileCache).

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
    }
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
        [pscustomobject]@{ Metric = $metric.Name; Unit = $metric.Unit; Electron = $null; Tauri = $null; Difference = $null; Variation = $null; Pass = $false; Undecided = $false; Note = 'tidak ada data' }
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
    if ($metric.Key -eq 'composer') {
        # (b) yang terlambat diamati hanya batas atas. Di Electron, batas atas bisa membesar-besarkan keunggulan Tauri.
        $electronLate = @($electronResult.records | Where-Object { $null -eq $_.failure -and $_.composerLate }).Count
        $tauriLate = @($tauriResult.records | Where-Object { $null -eq $_.failure -and $_.composerLate }).Count
        if ($electronLate -gt 0 -and $pass) {
            $pass = $false
            $undecided = $true
            $note += "; $electronLate run Electron hanya batas atas, ulangi pengukurannya"
        }
        if ($tauriLate -gt 0) { $note += "; $tauriLate run Tauri hanya batas atas" }
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
    "# Gerbang Fase 0 (K1): $($electronResult.label) lawan $($tauriResult.label)"
    ''
    "Electron: $Electron  "
    "Tauri: $Tauri  "
    "Mesin: $($tauriResult.machine.os), $($tauriResult.machine.cpu)"
    ''
    '| Metrik | Electron (median) | Tauri (median) | Selisih (Electron dikurangi Tauri) | Variasi antar-run | Lolos | Catatan |'
    '| --- | --- | --- | --- | --- | --- | --- |'
)
foreach ($row in $rows) {
    $lines += '| {0} ({1}) | {2} | {3} | {4} | {5} | {6} | {7} |' -f $row.Metric, $row.Unit, (& $format $row.Electron), (& $format $row.Tauri),
    (& $format $row.Difference), (& $format $row.Variation), $(if ($row.Pass) { 'ya' } else { 'tidak' }), $row.Note
}
$passed = @($rows | Where-Object Pass).Count -eq $rows.Count
$incomplete = @(@($electronResult, $tauriResult) | Where-Object { $_.aborted })
$lines += ''
if ($incomplete.Count -gt 0) {
    $lines += 'Hasil: **belum bisa dinilai**; pengukuran ' + (($incomplete | ForEach-Object label) -join ' dan ') +
    ' berhenti sebelum selesai. Ulangi sebelum memutuskan K1.'
}
elseif ($passed) {
    $lines += 'Hasil: **lolos K1**, semua metrik lebih baik dengan selisih di atas variasi antar-run.'
}
elseif (@($rows | Where-Object { -not $_.Pass -and -not $_.Undecided }).Count -eq 0) {
    $lines += 'Hasil: **belum bisa dinilai**; (b) Electron hanya batas atas di sebagian run. Ulangi pengukuran Electron.'
}
else {
    $lines += 'Hasil: **tidak lolos K1**; metrik yang tidak lolos ditandai "tidak".'
}

if ($OutputPath) { $lines | Set-Content -Path $OutputPath -Encoding utf8 }
$lines | ForEach-Object { Write-Host $_ }
