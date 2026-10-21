// Whether this login session is locked (Win+L, lock screen), for the dock's
// "Locked" pill. Read-only and cheap: the host polls it with the running list.
//
// Primary: WTSQuerySessionInformation(WTSSessionInfoEx) -> SessionFlags
// (WTS_SESSIONSTATE_LOCK = 0, WTS_SESSIONSTATE_UNLOCK = 1). Fallback when that
// is unavailable: the input desktop cannot be opened while the secure
// (Winlogon) desktop is active.

using System.Runtime.InteropServices;
using System.Text.Json;

namespace WinDock;

internal static class SessionLock
{
    private const int WTSSessionInfoEx = 25;
    private const int WTS_CURRENT_SESSION = -1;
    private const int WTS_SESSIONSTATE_LOCK = 0;
    private const int WTS_SESSIONSTATE_UNLOCK = 1;
    private const uint DESKTOP_SWITCHDESKTOP = 0x0100;

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out uint bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool SwitchDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);

    public static int Run(string[] args)
    {
        if (args.Length != 1) return Program.Usage("usage: session-locked");
        var locked = FromWts() ?? FromInputDesktop();
        Console.Out.Write(JsonSerializer.Serialize(new { locked }));
        return locked is null ? 2 : 0;
    }

    /// WTSINFOEXW: DWORD Level; then the level-1 union (8-byte aligned, it
    /// holds LARGE_INTEGERs): SessionId @8, SessionState @12, SessionFlags @16.
    private static bool? FromWts()
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, WTS_CURRENT_SESSION, WTSSessionInfoEx, out var buffer, out var bytes)) return null;
        try
        {
            if (buffer == IntPtr.Zero || bytes < 20) return null;
            if (Marshal.ReadInt32(buffer, 0) != 1) return null;
            return Marshal.ReadInt32(buffer, 16) switch
            {
                WTS_SESSIONSTATE_LOCK => true,
                WTS_SESSIONSTATE_UNLOCK => false,
                _ => null,
            };
        }
        finally
        {
            if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);
        }
    }

    private static bool? FromInputDesktop()
    {
        var desktop = OpenInputDesktop(0, false, DESKTOP_SWITCHDESKTOP);
        if (desktop == IntPtr.Zero) return true;
        try
        {
            return !SwitchDesktop(desktop);
        }
        finally
        {
            CloseDesktop(desktop);
        }
    }
}
