$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -ReferencedAssemblies @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.AutomationIdentifier].Assembly.Location,
    [System.Windows.Rect].Assembly.Location
) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class GenieTaskbars {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA { public uint cbSize; public IntPtr hWnd; public uint callback, edge; public RECT rect; public IntPtr param; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public uint cbSize; public RECT monitor, work; public uint flags; }
    public class Bar { public string edge; public RECT bounds, monitor; public long handle; }
    public class Bounds { public double x, y, width, height; }
    public class Match { public Bounds bounds; public string match = "app-id"; }
    public delegate bool EnumProc(IntPtr window, IntPtr param);
    [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint message, ref APPBARDATA data);
    [DllImport("user32.dll")] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    static readonly string[] edges = { "left", "top", "right", "bottom" };
    static MONITORINFO Info(IntPtr window) { var info = new MONITORINFO(); info.cbSize=(uint)Marshal.SizeOf(info); GetMonitorInfo(MonitorFromWindow(window,2),ref info); return info; }
    static Bar Read(IntPtr window, string edge, RECT bounds) {
        var info=Info(window); return new Bar { edge=edge, bounds=bounds, monitor=info.monitor, handle=window.ToInt64() };
    }
    public static Match FindButton(IntPtr window, string appId) {
        if (String.IsNullOrWhiteSpace(appId)) return null;
        try {
            var root = System.Windows.Automation.AutomationElement.FromHandle(window);
            var cache = new System.Windows.Automation.CacheRequest();
            cache.AutomationElementMode = System.Windows.Automation.AutomationElementMode.None;
            cache.Add(System.Windows.Automation.AutomationElement.AutomationIdProperty);
            cache.Add(System.Windows.Automation.AutomationElement.BoundingRectangleProperty);
            System.Windows.Automation.AutomationElementCollection elements;
            // One fresh property batch; no live references or positions retained between queries.
            using (cache.Activate()) {
                elements = root.FindAll(System.Windows.Automation.TreeScope.Descendants,
                    System.Windows.Automation.Condition.TrueCondition);
            }
            Match found = null;
            foreach (System.Windows.Automation.AutomationElement element in elements) {
                var data = element.Cached;
                var id = data.AutomationId ?? "";
                var identity = id.StartsWith("Appid:", StringComparison.OrdinalIgnoreCase)
                    ? id.Substring(6).Trim() : id.Trim();
                if (!String.Equals(identity, appId, StringComparison.OrdinalIgnoreCase)) continue;
                var bounds = data.BoundingRectangle;
                if (bounds.IsEmpty || bounds.Width <= 0 || bounds.Height <= 0) continue;
                if (found != null) return null;
                found = new Match { bounds = new Bounds {
                    x = bounds.X, y = bounds.Y, width = bounds.Width, height = bounds.Height
                }};
            }
            return found;
        } catch { return null; }
    }
    public static Bar[] Query() {
        var old=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            var bars=new List<Bar>();
            var primary=FindWindow("Shell_TrayWnd",null);
            var data=new APPBARDATA(); data.cbSize=(uint)Marshal.SizeOf(data);
            if(primary!=IntPtr.Zero && SHAppBarMessage(5,ref data)!=UIntPtr.Zero && data.edge<4)
                bars.Add(Read(primary,edges[data.edge],data.rect));
            EnumWindows((window,param)=>{
                var name=new StringBuilder(128); GetClassName(window,name,128);
                if(name.ToString()!="Shell_SecondaryTrayWnd") return true;
                RECT rect; if(!GetWindowRect(window,out rect)) return true;
                var info=Info(window); var monitor=info.monitor;
                var distances=rect.Right-rect.Left < rect.Bottom-rect.Top
                    ? new[] { Math.Abs(rect.Left-monitor.Left), Int32.MaxValue, Math.Abs(rect.Right-monitor.Right), Int32.MaxValue }
                    : new[] { Int32.MaxValue, Math.Abs(rect.Top-monitor.Top), Int32.MaxValue, Math.Abs(rect.Bottom-monitor.Bottom) };
                var best=0; for(var i=1;i<4;i++) if(distances[i]<distances[best]) best=i;
                bars.Add(Read(window,edges[best],rect)); return true;
            },IntPtr.Zero);
            return bars.ToArray();
        } finally { SetThreadDpiAwarenessContext(old); }
    }
}
'@
function Find-OwnTaskbarButton($Bar, $Request) {
    return [GenieTaskbars]::FindButton([IntPtr]::new($Bar.handle), [string]$Request.appId)
}
while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -eq 'quit') { break }
    try {
        $request = if ($line -eq 'query') { @{ command = 'query' } } else { $line | ConvertFrom-Json }
        if ($request.command -ne 'query') { continue }
        $bars = @([GenieTaskbars]::Query() | ForEach-Object {
            $button = Find-OwnTaskbarButton $_ $request
            $bar = @{ edge = $_.edge; bounds = @{ x = $_.bounds.Left; y = $_.bounds.Top; width = $_.bounds.Right - $_.bounds.Left; height = $_.bounds.Bottom - $_.bounds.Top }; monitor = @{ x = $_.monitor.Left; y = $_.monitor.Top; width = $_.monitor.Right - $_.monitor.Left; height = $_.monitor.Bottom - $_.monitor.Top } }
            if ($button.bounds) { $bar.button = $button.bounds; $bar.buttonMatch = $button.match }

            $bar
        })
        @{ bars = $bars } | ConvertTo-Json -Depth 5 -Compress
    } catch { '{"bars":[]}' }
}
