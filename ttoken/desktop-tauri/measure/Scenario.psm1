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
    <#
    .SYNOPSIS
    Define window.__ttokenMeasure in the page (page.js); it is kept until the page reloads.

    .DESCRIPTION
    A page found while its first navigation is still pending holds the initial about:blank document, where page.js
    declines to install, and an evaluation can also meet the document being replaced. The install is retried until the
    app document has the helpers.
    #>
    param([Parameter(Mandatory)] [object] $Session, [int] $TimeoutSeconds = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        # An evaluation the page holds while its document loads counts against the same deadline.
        $remaining = [int] [Math]::Max(1, [Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
        try {
            if (Invoke-CdpScript -Session $Session -Expression $script:PageHelpers -TimeoutSeconds $remaining) { return }
            $reason = 'the page stayed at about:blank'
        }
        catch {
            $reason = $_.Exception.Message
            # A reply that timed out or a page that went away closes the connection; nothing more can be tried on it.
            if ($Session.Socket.State -ne [System.Net.WebSockets.WebSocketState]::Open) {
                throw "the page helpers could not be installed: $reason"
            }
        }
        if ((Get-Date) -gt $deadline) { throw "the page helpers could not be installed within $TimeoutSeconds seconds: $reason" }
        Start-Sleep -Milliseconds 20
    }
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
    $id = ConvertTo-Json -Compress $spec.Id
    # A Session that is already open switches nothing: its last answer is on screen, so nothing is timed.
    if (Invoke-CdpScript -Session $Session -Expression "window.__ttokenMeasure.sessionSelected($id)") { return $null }
    $marker = ConvertTo-Json -Compress $spec.LastAnswer
    Invoke-CdpScript -Session $Session -Expression "window.__ttokenMeasure.prepareSwitch($marker, $($TimeoutSeconds * 1000))" | Out-Null
    $point = Invoke-CdpScript -Session $Session -Expression "window.__ttokenMeasure.sessionRow($id)"
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
    S3: open the Device panel in Sessions A, B, and C (the right sidebar belongs to each Session), open the Issues view,
    return to Chat, then switch B, C, A, B, C, A and time each switch, so every switch lands on a Session with the
    Device panel open.
    #>
    param([Parameter(Mandatory)] [object] $Session)
    foreach ($key in 'A', 'B', 'C') {
        $null = Open-FixtureSession -Session $Session -Key $key
        Invoke-RailButton -Session $Session -Name device
        Start-Sleep -Seconds 2
    }
    Invoke-RailButton -Session $Session -Name issues
    Start-Sleep -Seconds 3
    Invoke-RailButton -Session $Session -Name home
    Start-Sleep -Seconds 1
    $switches = foreach ($key in 'B', 'C', 'A', 'B', 'C', 'A') {
        $elapsed = Open-FixtureSession -Session $Session -Key $key
        if ($null -eq $elapsed) { throw "Session $key was already open, so the S3 switch order is broken" }
        $elapsed
        Start-Sleep -Milliseconds 500
    }
    [ordered]@{ switchMs = @($switches) }
}

function Get-OpenFixture {
    <# .SYNOPSIS The key of the fixture Session open in the main view (Long, A, B, C), or 'other'. #>
    param([Parameter(Mandatory)] [object] $Session)
    foreach ($key in 'A', 'B', 'C', 'Long') {
        $id = ConvertTo-Json -Compress $script:Fixture[$key].Id
        if (Invoke-CdpScript -Session $Session -Expression "window.__ttokenMeasure.sessionSelected($id)") { return $key }
    }
    'other'
}

function Reset-LaunchState {
    <#
    .SYNOPSIS
    Leave the page as every launch should find it: Session A open and no saved right-sidebar layouts.

    .DESCRIPTION
    The Web client restores the open Session (dsh.sessions.current) and each Session's right sidebar at start, so
    without this a launch would start from wherever the previous scenario ended: S3 launches would restore the long
    Session, and Device panels would stay open in later runs.
    #>
    param([Parameter(Mandatory)] [object] $Session)
    $null = Open-FixtureSession -Session $Session -Key A
    $null = Invoke-CdpScript -Session $Session -Expression 'window.__ttokenMeasure.clearSidebarLayouts()'
}

Export-ModuleMember -Function Install-PageHelpers, Wait-Composer, Invoke-RailButton, Open-FixtureSession, Invoke-ScenarioS2,
Invoke-ScenarioS3, Get-OpenFixture, Reset-LaunchState
