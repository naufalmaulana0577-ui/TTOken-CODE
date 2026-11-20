<#
.SYNOPSIS
Process tree, memory, window, and screenshot helpers for the TTOken Code desktop measurements and smoke tests.

.DESCRIPTION
Memory follows the PRD: the private working set of every process in the application's tree, which on Windows includes
msedgewebview2.exe (Tauri) or the Electron helpers, and node.exe (the Host). On macOS and Linux the module reports the
resident set size instead; those numbers are recorded separately and are not compared with Windows.
#>

Set-StrictMode -Version Latest

# The type survives a second import in the same session, so it is added once.
if ($IsWindows -and -not ('TTokenWindows' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TTokenWindows {
    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    /// True when the process owns a visible top-level window of at least the given size.
    public static bool HasVisibleWindow(uint processId, int minimumWidth, int minimumHeight) {
        bool found = false;
        EnumWindows((window, parameter) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != processId || !IsWindowVisible(window)) return true;
            Rect rect;
            if (!GetWindowRect(window, out rect)) return true;
            if (rect.Right - rect.Left >= minimumWidth && rect.Bottom - rect.Top >= minimumHeight) {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
}

function Get-UnixMilliseconds {
    <# .SYNOPSIS Current wall-clock time in milliseconds since the Unix epoch; the shell timeline uses the same clock. #>
    [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Get-ProcessTree {
    <#
    .SYNOPSIS
    The process with id RootId and all of its descendants, as objects with Id, ParentId, Name, and CommandLine.

    .DESCRIPTION
    A child is accepted only when it started after its parent, so a recycled parent id never adopts an unrelated
    process.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int] $RootId)

    if ($IsWindows) {
        $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate |
            ForEach-Object {
                [pscustomobject]@{
                    Id          = [int] $_.ProcessId
                    ParentId    = [int] $_.ParentProcessId
                    Name        = $_.Name
                    CommandLine = $_.CommandLine
                    Started     = $_.CreationDate
                }
            })
    }
    else {
        $all = @(& ps -A -o 'pid=,ppid=,lstart=,args=' | ForEach-Object {
                $fields = $_.Trim() -split '\s+', 8
                if ($fields.Count -lt 8) { return }
                [pscustomobject]@{
                    Id          = [int] $fields[0]
                    ParentId    = [int] $fields[1]
                    Name        = Split-Path -Leaf ($fields[7] -split ' ')[0]
                    CommandLine = $fields[7]
                    Started     = [datetime]::ParseExact(($fields[2..6] -join ' '), 'ddd MMM d HH:mm:ss yyyy',
                        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AllowWhiteSpaces)
                }
            })
    }
    $byId = @{}
    foreach ($process in $all) { $byId[$process.Id] = $process }
    if (-not $byId.ContainsKey($RootId)) { return @() }
    $tree = [System.Collections.Generic.List[object]]::new()
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue($byId[$RootId])
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        $tree.Add($parent)
        foreach ($child in $all) {
            if ($child.ParentId -eq $parent.Id -and $child.Id -ne $parent.Id -and $child.Started -ge $parent.Started) {
                $queue.Enqueue($child)
            }
        }
    }
    $tree.ToArray()
}

function Get-ProcessKind {
    <# .SYNOPSIS Classify a process of the application tree for the per-process report. #>
    param([Parameter(Mandatory)] [object] $Process, [Parameter(Mandatory)] [int] $RootId)

    if ($Process.Id -eq $RootId) { return 'shell' }
    $command = [string] $Process.CommandLine
    if ($command -match 'dsh-desktop-host[\\/]lib[\\/]index\.js') { return 'host' }
    if ($Process.Name -match '^node(\.exe)?$') { return 'node-child' }
    if ($command -match '--type=renderer') { return 'webview-renderer' }
    if ($command -match '--type=gpu-process') { return 'webview-gpu' }
    if ($command -match '--type=utility') { return 'webview-utility' }
    if ($command -match '--type=crashpad-handler') { return 'crashpad' }
    if ($Process.Name -match '^msedgewebview2(\.exe)?$') { return 'webview-browser' }
    'other'
}

function Get-TreeMemory {
    <#
    .SYNOPSIS
    One memory sample of the application tree: total and per-process bytes.

    .DESCRIPTION
    Windows reports the private working set (Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate), the
    number Task Manager shows by default. macOS and Linux report the resident set size.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] [int] $RootId)

    $tree = @(Get-ProcessTree -RootId $RootId)
    if ($tree.Count -eq 0) { throw "process $RootId is not running" }
    $ids = $tree.Id
    if ($IsWindows) {
        $counters = @{}
        Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Property IDProcess, WorkingSetPrivate |
            Where-Object { $ids -contains [int] $_.IDProcess } |
            ForEach-Object { $counters[[int] $_.IDProcess] = [long] $_.WorkingSetPrivate }
        $metric = 'privateWorkingSet'
    }
    else {
        $counters = @{}
        & ps -o 'pid=,rss=' -p ($ids -join ',') | ForEach-Object {
            $fields = $_.Trim() -split '\s+'
            if ($fields.Count -eq 2) { $counters[[int] $fields[0]] = [long] $fields[1] * 1024 }
        }
        $metric = 'residentSet'
    }
    $processes = @(foreach ($process in $tree) {
            if (-not $counters.ContainsKey($process.Id)) { continue }
            [pscustomobject]@{
                id    = $process.Id
                name  = $process.Name
                kind  = Get-ProcessKind -Process $process -RootId $RootId
                bytes = $counters[$process.Id]
            }
        })
    [pscustomobject]@{
        metric    = $metric
        takenAt   = Get-UnixMilliseconds
        total     = [long] ($processes | Measure-Object -Property bytes -Sum).Sum
        processes = $processes
    }
}

function Test-ProcessWindow {
    <# .SYNOPSIS True when the process owns a visible top-level window of at least 400 by 300 pixels (Windows only). #>
    param([Parameter(Mandatory)] [int] $ProcessId)
    if (-not $IsWindows) { throw 'Test-ProcessWindow needs Windows' }
    [TTokenWindows]::HasVisibleWindow([uint32] $ProcessId, 400, 300)
}

function Save-Screenshot {
    <# .SYNOPSIS Save the whole primary screen as a PNG file. #>
    param([Parameter(Mandatory)] [string] $Path)
    if ($IsWindows) {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try { $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size) }
            finally { $graphics.Dispose() }
            $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally { $bitmap.Dispose() }
    }
    elseif ($IsMacOS) { & screencapture -x $Path }
    else { & import -window root $Path }
}

function Test-StillRunning {
    <#
    .SYNOPSIS
    True when a captured process is still the same running process: same id and the same start time. Names are not
    compared because a process may rename itself (Node's process.title on Linux).
    #>
    param([Parameter(Mandatory)] [object] $Process)
    $running = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
    if ($null -eq $running) { return $false }
    try { $started = $running.StartTime } catch { return $true }
    # ps reports start times to the second; CIM to the microsecond.
    [Math]::Abs(($started - $Process.Started).TotalSeconds) -lt 2
}

function Stop-ProcessTree {
    <# .SYNOPSIS Kill every process of a previously captured tree that is still running. #>
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Tree)
    foreach ($process in $Tree) {
        if (Test-StillRunning -Process $process) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
}

function Get-RemainingProcesses {
    <# .SYNOPSIS Processes of a previously captured tree that are still running. #>
    param([Parameter(Mandatory)] [AllowEmptyCollection()] [object[]] $Tree)
    @($Tree | Where-Object { Test-StillRunning -Process $_ })
}

Export-ModuleMember -Function Get-UnixMilliseconds, Get-ProcessTree, Get-ProcessKind, Get-TreeMemory, Test-ProcessWindow,
Save-Screenshot, Test-StillRunning, Stop-ProcessTree, Get-RemainingProcesses
