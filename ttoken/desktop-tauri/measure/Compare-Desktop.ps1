#Requires -Version 7.2
<#
.SYNOPSIS
Compare two measurement results (usually Electron against Tauri) with the phase 0 gate threshold (K1).

.DESCRIPTION
K1 (PRD-TAURI, "Keputusan Naufal"): continue when total memory is lower in S1 to S3, and (a), (b), (c) are faster,
each by a difference larger than the run-to-run variation, with no minimum percentage.

Values per run:
- memory: the median of the five total memory samples of one launch, per scenario;
- (a) and (b): one value per launch, from every scenario; every launch starts from the same state;
- (c): the median of the six session switches of one S3 launch.

A metric's run-to-run variation is the range of its per-run values (maximum minus minimum), the larger of the two
results. A metric passes when the second result's median is below the first one's by more than that variation. The
gate passes only when all six metrics pass.

Only launches that finished and started from Session A count. A metric that lost runs, or whose (b) is only an upper
bound in either result, is not judged either way: it reads "belum bisa dinilai", and the measurement is repeated.
A lost run can hide a slow or a fast one and narrows the variation, and an upper bound widens it, so neither a pass
nor a failure is safe to read from such a metric. A metric with complete data that fails still fails the gate.

A verdict needs both results from one interleaved call of Measure-Desktop.ps1 (the same stamp), measured as the PRD
asks ("Cara mengukur"): five launches per scenario and, for K1, all of S1 to S3 with S1 idling two minutes. It also
needs the results in their roles: for K1 an Electron result as -Electron and a Tauri result as -Tauri. Otherwise it
reads "belum bisa dinilai" with the reason.

The "Host mulai" row is not part of K1: it shows how much of the (a) and (b) differences comes from the startup
order (Electron loads the page before it starts the Host), not from the shell.

For D12, pass the Tauri result without the cache (tauri.json) as -Electron and the TauriCache result
(tauri-cache.json) as -Tauri. Two Tauri results are judged on (a) and (b) only, and the verdict says whether the
compile cache makes them faster. A K1 comparison with tauri-cache.json counts only when D12 is adopted. Cold start
results (-Cold) are shown without a verdict: they are recorded apart from K1.

.PARAMETER Electron
First result file (the reference), for example electron.json from Measure-Desktop.ps1.

.PARAMETER Tauri
Second result file (the one tested), for example tauri.json or tauri-cache.json.

.PARAMETER OutputPath
Markdown file for the result table; without it the table is only printed.
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

function Get-Setting {
    <# One value of a result's settings, or $null when the result does not record it (older results). #>
    param([Parameter(Mandatory)] [object] $Result, [Parameter(Mandatory)] [string] $Name)
    if ($null -ne $Result.settings -and $null -ne $Result.settings.PSObject.Properties[$Name]) { $Result.settings.$Name }
}

function Test-Counted {
    <# A launch counts when it finished and, where its start state is recorded, started from Session A. #>
    param([Parameter(Mandatory)] [object] $Record)
    if ($null -ne $Record.failure) { return $false }
    $startedOn = $Record.PSObject.Properties['startedOn']
    $null -eq $startedOn -or $startedOn.Value -eq 'A'
}

function Get-RunValues {
    param([Parameter(Mandatory)] [object] $Result, [Parameter(Mandatory)] [string] $Metric)
    $records = @($Result.records | Where-Object { Test-Counted -Record $_ })
    switch -Regex ($Metric) {
        '^memory-(S[123]|Cold)$' {
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
    <# The runs a metric should have, from the measurement settings. #>
    param([Parameter(Mandatory)] [object] $Result, [Parameter(Mandatory)] [string] $Metric)
    $runs = [int] $Result.settings.runs
    $scenarios = @($Result.settings.scenarios)
    switch -Regex ($Metric) {
        '^memory-(S[123]|Cold)$' { if ($scenarios -contains $Matches[1]) { return $runs } return 0 }
        '^(window|composer)$' { return $runs * $scenarios.Count }
        '^switch$' { if ($scenarios -contains 'S3') { return $runs } return 0 }
    }
    0
}

# What the comparison decides. Cold starts are recorded apart from K1 (PRD, "Cara mengukur" point 5), so they get no
# verdict. Two Tauri results, without and with Node's compile cache, decide D12, which asks only whether the start
# times (a) and (b) are faster.
$coldResults = @(@($electronResult, $tauriResult) | Where-Object { Get-Setting -Result $_ -Name 'cold' })
$mode = if ($coldResults.Count -gt 0) { 'cold' }
elseif ($electronResult.build -in 'Tauri', 'TauriCache' -and $tauriResult.build -in 'Tauri', 'TauriCache') { 'D12' }
else { 'K1' }

$metrics = @(
    if ($mode -eq 'cold') { @{ Key = 'memory-Cold'; Name = 'Memori total start dingin'; Unit = 'MB'; Scale = 1MB } }
    else {
        @{ Key = 'memory-S1'; Name = 'Memori total S1'; Unit = 'MB'; Scale = 1MB }
        @{ Key = 'memory-S2'; Name = 'Memori total S2'; Unit = 'MB'; Scale = 1MB }
        @{ Key = 'memory-S3'; Name = 'Memori total S3'; Unit = 'MB'; Scale = 1MB }
    }
    @{ Key = 'window'; Name = '(a) jendela tampil'; Unit = 'ms'; Scale = 1 }
    @{ Key = 'composer'; Name = '(b) composer bisa diketik'; Unit = 'ms'; Scale = 1 }
    if ($mode -ne 'cold') { @{ Key = 'switch'; Name = '(c) ganti sesi'; Unit = 'ms'; Scale = 1 } }
)
$judged = switch ($mode) { 'cold' { @() } 'D12' { @('window', 'composer') } default { @($metrics | ForEach-Object { $_.Key }) } }

$rows = foreach ($metric in $metrics) {
    $electronValues = @(Get-RunValues -Result $electronResult -Metric $metric.Key)
    $tauriValues = @(Get-RunValues -Result $tauriResult -Metric $metric.Key)
    if ($electronValues.Count -eq 0 -or $tauriValues.Count -eq 0) {
        [pscustomobject]@{ Key = $metric.Key; Metric = $metric.Name; Unit = $metric.Unit; Electron = $null; Tauri = $null; Difference = $null; Variation = $null; Pass = $false; Undecided = $true; Note = 'tidak ada data' }
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
    # A lost run can hide a slow or a fast one and narrows the variation, so the metric is not judged either way.
    $missing = @(
        @{ Label = $first; Have = $electronValues.Count; Want = Get-ExpectedCount -Result $electronResult -Metric $metric.Key }
        @{ Label = $second; Have = $tauriValues.Count; Want = Get-ExpectedCount -Result $tauriResult -Metric $metric.Key }
    ) | Where-Object { $_.Have -lt $_.Want }
    foreach ($gap in $missing) { $note += "; $($gap.Label) hanya $($gap.Have) dari $($gap.Want) run yang bisa dipakai" }
    if (@($missing).Count -gt 0) { $undecided = $true }
    if ($metric.Key -eq 'window') {
        foreach ($result in $electronResult, $tauriResult) {
            $fromBoot = @($result.records | Where-Object {
                    (Test-Counted -Record $_) -and $null -ne $_.PSObject.Properties['windowFrom'] -and $_.windowFrom -eq 'boot-answered'
                }).Count
            if ($fromBoot -gt 0) { $note += "; $fromBoot run $($result.label) diambil dari saat halaman boot (jendela tampil karena batas 30 detik)" }
        }
    }
    if ($metric.Key -eq 'composer') {
        # A (b) observed late is only an upper bound; in either result it can widen the variation or the difference.
        $electronLate = @($electronResult.records | Where-Object { (Test-Counted -Record $_) -and $_.composerLate }).Count
        $tauriLate = @($tauriResult.records | Where-Object { (Test-Counted -Record $_) -and $_.composerLate }).Count
        if ($electronLate -gt 0) { $note += "; $electronLate run $first hanya batas atas" }
        if ($tauriLate -gt 0) { $note += "; $tauriLate run $second hanya batas atas" }
        if ($electronLate + $tauriLate -gt 0) { $undecided = $true }
    }
    if ($undecided) { $pass = $false }
    [pscustomobject]@{
        Key        = $metric.Key
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

$title = switch ($mode) {
    'cold' { "# Start dingin, bukan K1: $first lawan $second" }
    'D12' { "# D12, compile cache Node: $first lawan $second" }
    default { "# Gerbang Fase 0 (K1): $first lawan $second" }
}

$format = { param($value) if ($null -eq $value) { '-' } else { '{0:N1}' -f $value } }
$lines = @(
    $title
    ''
    "$($first): $Electron  "
    "$($second): $Tauri  "
    "Mesin: $($tauriResult.machine.os), $($tauriResult.machine.cpu)"
    ''
)
# A difference means something only when both results were measured interleaved, at the same time and power mode.
$stampOf = { param($result) if ($null -ne $result.settings -and $null -ne $result.settings.PSObject.Properties['stamp']) { $result.settings.stamp } }
$sameRun = $null -ne (& $stampOf $electronResult) -and (& $stampOf $electronResult) -eq (& $stampOf $tauriResult)
if ($mode -eq 'cold' -and $coldResults.Count -lt 2) {
    $lines += "Peringatan: hanya $($coldResults[0].label) yang start dingin, jadi kedua hasil tidak sebanding.", ''
}
if (-not $sameRun -and $mode -ne 'cold') {
    $lines += 'Peringatan: kedua hasil tidak diukur bergantian dalam satu pemanggilan Measure-Desktop.ps1, jadi waktu pengukuran ikut memengaruhi selisihnya.', ''
}
$powerOf = { param($result) if ($null -ne $result.machine) { $result.machine.PSObject.Properties['power'] } }
$powerFirst = & $powerOf $electronResult
$powerSecond = & $powerOf $tauriResult
if ($null -ne $powerFirst -and $null -ne $powerSecond -and (($powerFirst.Value | ConvertTo-Json -Compress) -ne ($powerSecond.Value | ConvertTo-Json -Compress))) {
    $lines += 'Peringatan: sumber atau skema daya berbeda di kedua hasil.', ''
}
# Launches that finished but did not start from Session A are left out like failed ones.
foreach ($result in $electronResult, $tauriResult) {
    $offState = @($result.records | Where-Object {
            $null -eq $_.failure -and $null -ne $_.PSObject.Properties['startedOn'] -and $_.startedOn -ne 'A'
        }).Count
    if ($offState -gt 0) { $lines += "Peringatan: $offState peluncuran $($result.label) tidak mulai dari sesi A, jadi tidak dipakai.", '' }
}
$lines += "| Metrik | $first (median) | $second (median) | Selisih ($first dikurangi $second) | Variasi antar-run | Lolos | Catatan |"
$lines += '| --- | --- | --- | --- | --- | --- | --- |'
foreach ($row in $rows) {
    $verdict = if ($row.Key -notin $judged) { '-' } elseif ($row.Pass) { 'ya' } elseif ($row.Undecided) { 'belum bisa dinilai' } else { 'tidak' }
    $lines += '| {0} ({1}) | {2} | {3} | {4} | {5} | {6} | {7} |' -f $row.Metric, $row.Unit, (& $format $row.Electron), (& $format $row.Tauri),
    (& $format $row.Difference), (& $format $row.Variation), $verdict, $row.Note
}
if ($mode -ne 'D12') {
    $electronHost = Get-Median -Values @(Get-RunValues -Result $electronResult -Metric host)
    $tauriHost = Get-Median -Values @(Get-RunValues -Result $tauriResult -Metric host)
    if ($null -ne $electronHost -and $null -ne $tauriHost) {
        $lines += '| Host mulai (ms sejak start, bukan bagian K1) | {0} | {1} | {2} | - | - | Bagian selisih (a) dan (b) yang datang dari urutan start, bukan dari shell |' -f
        (& $format $electronHost), (& $format $tauriHost), (& $format ($electronHost - $tauriHost))
    }
}

$judgedRows = @($rows | Where-Object { $_.Key -in $judged })
$incomplete = @(@($electronResult, $tauriResult) | Where-Object { $null -ne $_.PSObject.Properties['aborted'] -and $_.aborted })
# PRD, "Cara mengukur" point 5: five launches per scenario.
$fewRuns = @(@($electronResult, $tauriResult) | Where-Object { [int] (Get-Setting -Result $_ -Name 'runs') -lt 5 })
# PRD, "Cara mengukur" point 2: K1 covers S1 to S3, and S1 idles two minutes after the composer is ready.
$partial = @(@($electronResult, $tauriResult) | Where-Object {
        $scenarios = @(Get-Setting -Result $_ -Name 'scenarios')
        @('S1', 'S2', 'S3' | Where-Object { $scenarios -notcontains $_ }).Count -gt 0
    })
$shortIdle = @(@($electronResult, $tauriResult) | Where-Object { [int] (Get-Setting -Result $_ -Name 'idleSeconds') -lt 120 })
$rolesWrong = switch ($mode) {
    'K1' { $electronResult.build -ne 'Electron' -or $tauriResult.build -notin 'Tauri', 'TauriCache' }
    'D12' { $electronResult.build -ne 'Tauri' -or $tauriResult.build -ne 'TauriCache' }
    default { $false }
}
$lines += ''
if ($mode -eq 'cold') {
    $lines += 'Start dingin dicatat terpisah dan bukan bagian K1 (PRD, "Cara mengukur" butir 5), jadi tabel ini tanpa putusan.'
}
elseif ($incomplete.Count -gt 0) {
    $lines += 'Hasil: **belum bisa dinilai**; pengukuran ' + (($incomplete | ForEach-Object label) -join ' dan ') +
    ' berhenti sebelum selesai. Ulangi pengukurannya.'
}
elseif ($rolesWrong) {
    $lines += if ($mode -eq 'D12') { 'Hasil: **belum bisa dinilai**; untuk D12, -Electron harus tauri.json (tanpa compile cache) dan -Tauri harus tauri-cache.json.' }
    else { 'Hasil: **belum bisa dinilai**; untuk K1, -Electron harus hasil build Electron dan -Tauri hasil build Tauri.' }
}
elseif (-not $sameRun) {
    $lines += 'Hasil: **belum bisa dinilai**; kedua hasil tidak diukur bergantian dalam satu pemanggilan Measure-Desktop.ps1. Ulangi pengukurannya.'
}
elseif ($fewRuns.Count -gt 0) {
    $lines += 'Hasil: **belum bisa dinilai**; PRD meminta lima peluncuran per skenario, dan ' + (($fewRuns | ForEach-Object label) -join ' dan ') +
    ' diukur dengan kurang dari itu. Ulangi pengukurannya.'
}
elseif ($mode -eq 'K1' -and $partial.Count -gt 0) {
    $lines += 'Hasil: **belum bisa dinilai**; K1 butuh S1, S2, dan S3, dan ' + (($partial | ForEach-Object label) -join ' dan ') +
    ' tidak mengukur semuanya. Ulangi Measure-Desktop.ps1 tanpa -Scenario.'
}
elseif ($mode -eq 'K1' -and $shortIdle.Count -gt 0) {
    $lines += 'Hasil: **belum bisa dinilai**; PRD meminta S1 idle 2 menit, dan ' + (($shortIdle | ForEach-Object label) -join ' dan ') +
    ' diukur dengan idle lebih singkat. Ulangi Measure-Desktop.ps1 tanpa -IdleSeconds.'
}
elseif (@($judgedRows | Where-Object Pass).Count -eq $judgedRows.Count) {
    $lines += if ($mode -eq 'D12') { 'Hasil D12: **compile cache mempercepat (a) dan (b)**, dengan selisih di atas variasi antar-run.' }
    else { 'Hasil: **lolos K1**, semua metrik lebih baik dengan selisih di atas variasi antar-run.' }
}
elseif (@($judgedRows | Where-Object { -not $_.Pass -and -not $_.Undecided }).Count -eq 0) {
    $lines += 'Hasil: **belum bisa dinilai**; metrik yang ditandai "belum bisa dinilai" kehilangan run atau hanya punya batas atas. Ulangi pengukurannya.'
}
else {
    $lines += if ($mode -eq 'D12') { 'Hasil D12: **compile cache tidak terbukti mempercepat (a) dan (b)**; yang ditandai "tidak" tidak lebih cepat dengan selisih di atas variasi antar-run.' }
    else { 'Hasil: **tidak lolos K1**; metrik yang tidak lolos ditandai "tidak".' }
}

if ($mode -eq 'K1' -and $tauriResult.build -eq 'TauriCache') {
    $lines += '', 'Catatan: ini K1 dengan compile cache, yang berlaku hanya bila D12 dipakai (perbandingan tauri.json lawan tauri-cache.json berbunyi "compile cache mempercepat (a) dan (b)"). Bila tidak, K1 diputuskan oleh perbandingan electron.json lawan tauri.json.'
}

if ($OutputPath) { $lines | Set-Content -Path $OutputPath -Encoding utf8 }
$lines | ForEach-Object { Write-Host $_ }
