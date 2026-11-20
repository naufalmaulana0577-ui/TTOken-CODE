<#
.SYNOPSIS
Steps of the S2 and S3 measurement scenarios, driven through the DevTools protocol (Cdp.psm1).

.DESCRIPTION
The fixture Sessions come from seed-fixture.mjs; their ids and last answers are fixed there. Session rows are found by
their `data-row-key`, so the steps do not depend on the interface language or on Session titles.
#>

Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Cdp.psm1')

$script:PageHelpers = Get-Content -Raw (Join-Path $PSScriptRoot 'page.js')

# Ids and last answers of the fixture Sessions in seed-fixture.mjs.
$script:Fixture = @{
    Long = @{ Id = 'ttoken-measure-s2-long'; LastAnswer = 'S2-LONG answer 240.' }
    A    = @{ Id = 'ttoken-measure-s3-a'; LastAnswer = 'S3-SESSION-A answer 30.' }
    B    = @{ Id = 'ttoken-measure-s3-b'; LastAnswer = 'S3-SESSION-B answer 30.' }
    C    = @{ Id = 'ttoken-measure-s3-c'; LastAnswer = 'S3-SESSION-C answer 30.' }
}

function Install-PageHelpers {
    <# .SYNOPSIS Define window.__ttokenMeasure in the page (page.js); it is kept until the page reloads. #>
    param([Parameter(Mandatory)] [object] $Session)
    Invoke-CdpScript -Session $Session -Expression $script:PageHelpers | Out-Null
}

function Wait-Composer {
    <#
    .SYNOPSIS
    Wait until the composer accepts input; returns @{ at = <epoch ms>; late = <bool> }.
    #>
    param([Parameter(Mandatory)] [object] $Session, [int] $TimeoutSeconds = 180)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $state = Invoke-CdpScript -Session $Session -Expression 'window.__ttokenMeasure.composerState()'
        if ($null -ne $state) { return $state }
        Start-Sleep -Milliseconds 50
    }
    throw "the composer did not accept input within $TimeoutSeconds seconds"
}

function Invoke-RailButton {
    <# .SYNOPSIS Click a rail button: device, issues, or home. #>
    param([Parameter(Mandatory)] [object] $Session, [Parameter(Mandatory)] [ValidateSet('device', 'issues', 'home')] [string] $Name)
    $point = Invoke-CdpScript -Session $Session -Expression "window.__ttokenMeasure.railButton('$Name')"
    if ($null -eq $point) { throw "the rail has no $Name button" }
    Invoke-CdpClick -Session $Session -X $point.x -Y $point.y
}

function Open-FixtureSession {
    <#
    .SYNOPSIS
    Click a fixture Session in the sidebar and return the milliseconds from the press until its last answer rendered.
    #>
    param(
        [Parameter(Mandatory)] [object] $Session,
        [Parameter(Mandatory)] [ValidateSet('Long', 'A', 'B', 'C')] [string] $Key,
        [int] $TimeoutSeconds = 90
    )
    $spec = $script:Fixture[$Key]
    $marker = ConvertTo-Json -Compress $spec.LastAnswer
    Invoke-CdpScript -Session $Session -Expression "window.__ttokenMeasure.prepareSwitch($marker, $($TimeoutSeconds * 1000))" | Out-Null
    $point = Invoke-CdpScript -Session $Session -Expression "window.__ttokenMeasure.sessionRow($(ConvertTo-Json -Compress $spec.Id))"
    if ($null -eq $point) { throw "Session $($spec.Id) is not in the sidebar; run Measure-Desktop.ps1 -Setup" }
    Invoke-CdpClick -Session $Session -X $point.x -Y $point.y
    [math]::Round([double] (Invoke-CdpScript -Session $Session -Expression 'window.__ttokenMeasure.awaitSwitch()' -AwaitPromise -TimeoutSeconds ($TimeoutSeconds + 10)), 1)
}

function Invoke-ScenarioS2 {
    <#
    .SYNOPSIS
    S2: open the long Session, load every older page, then scroll its transcript from top to bottom.
    #>
    param([Parameter(Mandatory)] [object] $Session)
    $openMs = Open-FixtureSession -Session $Session -Key Long
    $history = Invoke-CdpScript -Session $Session -Expression 'window.__ttokenMeasure.loadAllHistory(300000)' -AwaitPromise -TimeoutSeconds 320
    $scroll = Invoke-CdpScript -Session $Session -Expression 'window.__ttokenMeasure.scrollTranscript()' -AwaitPromise -TimeoutSeconds 300
    [ordered]@{ openMs = $openMs; olderPages = $history.pages; turns = $scroll.turns; scrollSteps = $scroll.steps }
}

function Invoke-ScenarioS3 {
    <#
    .SYNOPSIS
    S3: open the Device panel and the Issues view, return to Chat, then switch B, C, A, B, C, A and time each switch.
    #>
    param([Parameter(Mandatory)] [object] $Session)
    Invoke-RailButton -Session $Session -Name device
    Start-Sleep -Seconds 2
    $null = Open-FixtureSession -Session $Session -Key A
    Invoke-RailButton -Session $Session -Name issues
    Start-Sleep -Seconds 3
    Invoke-RailButton -Session $Session -Name home
    Start-Sleep -Seconds 1
    $switches = foreach ($key in 'B', 'C', 'A', 'B', 'C', 'A') {
        Open-FixtureSession -Session $Session -Key $key
        Start-Sleep -Milliseconds 500
    }
    [ordered]@{ switchMs = @($switches) }
}

Export-ModuleMember -Function Install-PageHelpers, Wait-Composer, Invoke-RailButton, Open-FixtureSession, Invoke-ScenarioS2, Invoke-ScenarioS3
