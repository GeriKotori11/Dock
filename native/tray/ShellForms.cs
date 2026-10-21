// The two containers for the host page (HOST-CONTROL-PAGE.md 3.1): the tray
// flyout and the normal window. Both host one WebView2 each.
using Microsoft.Web.WebView2.WinForms;

namespace WinDock.Tray;

/// <summary>A form that hosts the /host page in a WebView2.</summary>
internal abstract class ShellForm : Form
{
    internal static readonly Color Background = Color.FromArgb(0x09, 0x0E, 0x10);

    internal WebView2 View { get; }
    internal abstract string ShellContainer { get; }
    /// <summary>The page in this form sent "ready" since its last navigation.</summary>
    internal bool PageReady { get; set; }
    /// <summary>Send navigate→pair once the page is ready.</summary>
    internal bool PendingPair { get; set; }
    /// <summary>The CoreWebView2 finished initialising.</summary>
    internal bool CoreReady { get; set; }

    protected ShellForm()
    {
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Background;
        Text = "WinDock";
        View = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Background };
        Controls.Add(View);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) View.Dispose();
        base.Dispose(disposing);
    }
}

/// <summary>Borderless, top-most, taskbar-less flyout anchored above the tray.</summary>
internal sealed class FlyoutForm : ShellForm
{
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WM_DPICHANGED = 0x02E0;
    private const int LogicalWidth = 380;
    private const int MinHeight = 320, MaxHeight = 680, EdgeGap = 12, WorkAreaMargin = 24;

    private int _contentHeight = 420;
    private long _hiddenAt;

    internal override string ShellContainer => "flyout";

    internal FlyoutForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        KeyPreview = true;
        Deactivate += (_, _) => HideFlyout();
    }

    internal event EventHandler<bool>? VisibilityChanged;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOOLWINDOW; // keep out of Alt+Tab
            return cp;
        }
    }

    protected override bool ShowWithoutActivation => false;

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.RoundCorners(Handle);
    }

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        // Windows suggests a rect for the new DPI; re-anchor with our own sizing instead.
        if (m.Msg == WM_DPICHANGED && Visible) BeginInvoke(Place);
    }

    /// <summary>A tray click right after deactivation is the click that closed us.</summary>
    internal bool JustHidden => Environment.TickCount64 - _hiddenAt < 200;

    internal void ShowFlyout()
    {
        Place();
        if (!Visible) Show();
        Activate();
        NativeMethods.SetForegroundWindow(Handle);
        VisibilityChanged?.Invoke(this, true);
    }

    internal void HideFlyout()
    {
        if (!Visible) return;
        _hiddenAt = Environment.TickCount64;
        Hide();
        VisibilityChanged?.Invoke(this, false);
    }

    /// <summary>Page height in CSS px (resize message); clamped per 3.1.</summary>
    internal void SetContentHeight(double height)
    {
        if (double.IsNaN(height) || height <= 0) return;
        _contentHeight = (int)Math.Ceiling(Math.Min(height, 10000));
        if (Visible) Place();
    }

    /// <summary>Anchors 12 px from the work-area corner nearest the taskbar, growing away from it.</summary>
    private void Place()
    {
        var taskbar = NativeMethods.GetTaskbar();
        var screen = taskbar is { } tb ? Screen.FromRectangle(tb.Bounds) : Screen.PrimaryScreen ?? Screen.AllScreens[0];
        var edge = taskbar?.Edge ?? TaskbarEdge.Bottom;
        var work = screen.WorkingArea;
        if (taskbar is { } bar && work == screen.Bounds)
        {
            // Auto-hide taskbar: the work area is the whole screen, so keep clear of the bar itself.
            work = edge switch
            {
                TaskbarEdge.Left => Rectangle.FromLTRB(Math.Max(work.Left, bar.Bounds.Right), work.Top, work.Right, work.Bottom),
                TaskbarEdge.Top => Rectangle.FromLTRB(work.Left, Math.Max(work.Top, bar.Bounds.Bottom), work.Right, work.Bottom),
                TaskbarEdge.Right => Rectangle.FromLTRB(work.Left, work.Top, Math.Min(work.Right, bar.Bounds.Left), work.Bottom),
                _ => Rectangle.FromLTRB(work.Left, work.Top, work.Right, Math.Min(work.Bottom, bar.Bounds.Top)),
            };
        }
        var scale = NativeMethods.DpiAt(new Point(work.Left + work.Width / 2, work.Top + work.Height / 2)) / 96.0;
        int Px(double logical) => (int)Math.Round(logical * scale);

        var maxLogical = Math.Max(MinHeight, Math.Min(MaxHeight, (int)(work.Height / scale) - WorkAreaMargin));
        var height = Px(Math.Clamp(_contentHeight, MinHeight, maxLogical));
        var width = Math.Min(Px(LogicalWidth), work.Width);
        var gap = Px(EdgeGap);
        var x = edge == TaskbarEdge.Left ? work.Left + gap : work.Right - gap - width;
        var y = edge == TaskbarEdge.Top ? work.Top + gap : work.Bottom - gap - height;
        Bounds = new Rectangle(x, y, width, height);
    }
}

/// <summary>"Open in a window": a normal resizable window with a taskbar button.</summary>
internal sealed class HostWindowForm : ShellForm
{
    internal override string ShellContainer => "window";

    internal HostWindowForm(Icon icon)
    {
        Icon = icon;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = true;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        NativeMethods.DarkTitleBar(Handle);
        ApplySize();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        MinimumSize = Scaled(640, 560);
    }

    private void ApplySize()
    {
        MinimumSize = Scaled(640, 560);
        ClientSize = Scaled(760, 600);
    }

    private Size Scaled(int w, int h)
    {
        var scale = DeviceDpi / 96.0;
        return new Size((int)Math.Round(w * scale), (int)Math.Round(h * scale));
    }
}
