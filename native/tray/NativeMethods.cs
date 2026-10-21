// Win32 helpers for the flyout: taskbar position, monitor DPI and DWM attributes.
using System.Runtime.InteropServices;

namespace WinDock.Tray;

internal enum TaskbarEdge { Left = 0, Top = 1, Right = 2, Bottom = 3 }

internal static partial class NativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct APPBARDATA
    {
        public int cbSize;
        public IntPtr hWnd;
        public uint uCallbackMessage;
        public uint uEdge;
        public RECT rc;
        public IntPtr lParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    private const uint ABM_GETTASKBARPOS = 5;
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const int MDT_EFFECTIVE_DPI = 0;

    [DllImport("shell32.dll")]
    private static extern UIntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(IntPtr hWnd);

    /// <summary>The primary taskbar's edge and bounds (physical pixels), or null if unknown.</summary>
    internal static (TaskbarEdge Edge, Rectangle Bounds)? GetTaskbar()
    {
        var data = new APPBARDATA { cbSize = Marshal.SizeOf<APPBARDATA>() };
        try
        {
            if (SHAppBarMessage(ABM_GETTASKBARPOS, ref data) == UIntPtr.Zero) return null;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { return null; }
        var rect = Rectangle.FromLTRB(data.rc.Left, data.rc.Top, data.rc.Right, data.rc.Bottom);
        return data.uEdge <= 3 ? ((TaskbarEdge)data.uEdge, rect) : null;
    }

    /// <summary>Effective DPI of the monitor nearest to a physical point (96 if unknown).</summary>
    internal static int DpiAt(Point point)
    {
        try
        {
            var monitor = MonitorFromPoint(new POINT { X = point.X, Y = point.Y }, MONITOR_DEFAULTTONEAREST);
            if (monitor != IntPtr.Zero && GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, out var x, out _) == 0 && x > 0)
                return (int)x;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { }
        return 96;
    }

    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_CAPTION_COLOR = 35;
    private const int DWMWCP_ROUND = 2;

    private static void SetDwm(IntPtr hwnd, int attribute, int value)
    {
        // Older Windows builds reject unknown attributes; that only loses the polish.
        try { DwmSetWindowAttribute(hwnd, attribute, ref value, sizeof(int)); }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { }
    }

    internal static void RoundCorners(IntPtr hwnd) => SetDwm(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);

    internal static void DarkTitleBar(IntPtr hwnd)
    {
        SetDwm(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1);
        SetDwm(hwnd, DWMWA_CAPTION_COLOR, 0x00100E09); // #090E10 as COLORREF (0x00BBGGRR)
    }
}
