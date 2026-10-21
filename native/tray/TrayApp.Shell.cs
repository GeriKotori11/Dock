// Shell side of the host control page: WebView2 flyout/window, the page bridge
// (HOST-CONTROL-PAGE.md 13.5), navigation rules and the login item.
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace WinDock.Tray;

internal sealed partial class TrayApp
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "WinDock";

    private bool _webViewAvailable;
    private Task<CoreWebView2Environment>? _environment;
    private FlyoutForm? _flyout;
    private HostWindowForm? _window;
    private int _offlineRevision;
    private string? _updateState;
    private string? _updateVersion;

    private string HostOrigin => $"http://127.0.0.1:{_port}";
    private string HostPage => HostOrigin + "/host";

    /// <summary>Decides once whether the WebView2 runtime is present (6.2 fallback otherwise).</summary>
    private void InitShell()
    {
        try
        {
            _webViewAvailable = !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString());
        }
        catch (Exception ex) when (ex is WebView2RuntimeNotFoundException or DllNotFoundException or BadImageFormatException or System.ComponentModel.Win32Exception)
        {
            _webViewAvailable = false;
        }
        _log.Mark(_webViewAvailable ? "WebView2 runtime found" : "WebView2 runtime missing: falling back to the browser");
        // Create the flyout now (hidden) so the first open is instant.
        if (_webViewAvailable) EnsureFlyout();
    }

    private Task<CoreWebView2Environment> Environment2()
    {
        var dataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WinDock", "WebView2");
        return _environment ??= CoreWebView2Environment.CreateAsync(null, dataFolder);
    }

    // ---- containers ------------------------------------------------------

    private FlyoutForm EnsureFlyout()
    {
        if (_flyout is { IsDisposed: false } existing) return existing;
        var flyout = new FlyoutForm();
        flyout.VisibilityChanged += (_, visible) => Send(flyout, new { type = "visibility", visible });
        _ = flyout.Handle;
        _ = flyout.View.Handle;
        _flyout = flyout;
        _ = InitPane(flyout);
        return flyout;
    }

    private void ToggleFlyout()
    {
        if (_stopping) return;
        if (!_webViewAvailable) { OpenInBrowser(); return; }
        var flyout = EnsureFlyout();
        if (flyout.Visible) flyout.HideFlyout();
        else if (!flyout.JustHidden) flyout.ShowFlyout();
    }

    private void ShowFlyout(bool pair)
    {
        if (_stopping) return;
        if (!_webViewAvailable) { OpenInBrowser(); return; }
        var flyout = EnsureFlyout();
        if (pair) RequestPair(flyout);
        flyout.ShowFlyout();
    }

    private void OpenWindow()
    {
        if (!_webViewAvailable) { OpenInBrowser(); return; }
        _flyout?.HideFlyout();
        if (_window is { IsDisposed: false } existing)
        {
            if (existing.WindowState == FormWindowState.Minimized) existing.WindowState = FormWindowState.Normal;
            existing.Activate();
            return;
        }
        var icon = LoadAppIcon(SystemInformation.IconSize);
        var window = new HostWindowForm(icon);
        window.FormClosed += (_, _) =>
        {
            if (ReferenceEquals(_window, window)) _window = null;
            window.Dispose();
            icon.Dispose();
        };
        window.Shown += (_, _) => Send(window, new { type = "visibility", visible = true });
        _window = window;
        _ = InitPane(window);
        window.Show();
        window.Activate();
    }

    private void OpenInBrowser()
    {
        if (_port <= 0) return; // host not up yet: nothing to open
        OpenExternal(new Uri(HostPage));
    }

    private void RequestPair(ShellForm form)
    {
        if (form.PageReady && IsHostOrigin(form.View.CoreWebView2?.Source))
        {
            form.PendingPair = false;
            Send(form, new { type = "navigate", view = "pair" });
        }
        else form.PendingPair = true;
    }

    private IEnumerable<ShellForm> Panes()
    {
        if (_flyout is { IsDisposed: false } flyout) yield return flyout;
        if (_window is { IsDisposed: false } window) yield return window;
    }

    // ---- WebView2 setup --------------------------------------------------

    private async Task InitPane(ShellForm form)
    {
        try
        {
            var env = await Environment2();
            await form.View.EnsureCoreWebView2Async(env);
            if (_stopping || form.IsDisposed) return;
            var core = form.View.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            await core.AddScriptToExecuteOnDocumentCreatedAsync(ShellScript(form.ShellContainer));
            core.AddWebResourceRequestedFilter(OfflinePage.Origin + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) => ServeOffline(env, e);
            core.NavigationStarting += (_, e) => OnNavigationStarting(form, e);
            core.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)) OpenExternal(uri);
            };
            core.WebMessageReceived += (_, e) => OnWebMessage(form, e);
            form.CoreReady = true;
            NavigatePane(form);
        }
        catch (Exception ex) when (ex is WebView2RuntimeNotFoundException or InvalidOperationException or System.Runtime.InteropServices.COMException or ArgumentException)
        {
            _log.Mark($"WebView2 failed to start: {ex.Message}");
            _webViewAvailable = false;
            if (form is FlyoutForm f) { f.HideFlyout(); }
            else form.Close();
            OpenInBrowser();
        }
    }

    private string ShellScript(string container)
    {
        var shell = new
        {
            os = "windows",
            container,
            version = UpdateChecker.InstalledVersion,
            capabilities = new { loginItem = true, quit = true, restart = true, logs = true, updates = true, openWindow = true, firewallSettings = false },
        };
        var json = JsonSerializer.Serialize(shell);
        // Only the loopback host page and the bundled offline page get the shell object
        // (navigation is limited to those two origins anyway; the port can change on restart).
        return "(function(){var l=location;if(!(l.origin==='" + OfflinePage.Origin + "'||(l.protocol==='http:'&&l.hostname==='127.0.0.1')))return;" +
               "Object.defineProperty(window,'WinDockShell',{value:Object.freeze(" + json + "),writable:false,configurable:false});})();";
    }

    private void NavigateAll()
    {
        foreach (var pane in Panes()) NavigatePane(pane);
    }

    private void NavigatePane(ShellForm form)
    {
        if (!form.CoreReady || form.IsDisposed) return;
        form.PageReady = false;
        if (_offline is null && _port > 0) form.View.CoreWebView2.Navigate(HostPage);
        else form.View.CoreWebView2.Navigate($"{OfflinePage.Origin}/?r={++_offlineRevision}");
    }

    private void ServeOffline(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var html = OfflinePage.Render(_offline ?? OfflineVariant.Starting, _offlinePort, _offlineDetail);
        var stream = new MemoryStream(Encoding.UTF8.GetBytes(html));
        e.Response = env.CreateWebResourceResponse(stream, 200, "OK",
            "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n" +
            "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    }

    // ---- navigation rules (13.5) -----------------------------------------

    private bool IsHostOrigin(string? source) =>
        _port > 0 && Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttp && uri.Host == "127.0.0.1" && uri.Port == _port
        && string.IsNullOrEmpty(uri.UserInfo);

    private static bool IsOfflineOrigin(string? source) =>
        Uri.TryCreate(source, UriKind.Absolute, out var uri)
        && string.Equals(uri.GetLeftPart(UriPartial.Authority), OfflinePage.Origin, StringComparison.Ordinal);

    private bool IsAllowedNavigation(string? target)
    {
        if (IsOfflineOrigin(target)) return true;
        if (!IsHostOrigin(target)) return false;
        var path = new Uri(target!).AbsolutePath;
        return path == "/host" || path.StartsWith("/host/", StringComparison.Ordinal);
    }

    private void OnNavigationStarting(ShellForm form, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsAllowedNavigation(e.Uri)) { form.PageReady = false; return; }
        e.Cancel = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri)) OpenExternal(uri);
    }

    private void OpenExternal(Uri uri)
    {
        // Only web links leave the shell; other schemes could start arbitrary handlers.
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return;
        if (IsOfflineOrigin(uri.AbsoluteUri)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { _log.Mark($"Couldn't open the browser: {ex.Message}"); }
    }

    // ---- bridge: page -> native ------------------------------------------

    private void OnWebMessage(ShellForm form, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var fromHost = IsHostOrigin(e.Source);
        var fromOffline = !fromHost && IsOfflineOrigin(e.Source);
        if (!fromHost && !fromOffline) return;

        string? type;
        JsonElement message;
        try
        {
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            message = document.RootElement.Clone();
            if (message.ValueKind != JsonValueKind.Object || !message.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) return;
            type = t.GetString();
        }
        catch (JsonException) { return; }

        // The offline page gets only the actions it shows.
        if (fromOffline && type is not ("ready" or "resize" or "close" or "openLogs" or "restart" or "quit")) return;

        switch (type)
        {
            case "ready":
                form.PageReady = true;
                if (fromHost)
                {
                    Send(form, new { type = "loginItem", state = LoginItemState() });
                    if (_updateState is not null) Send(form, new { type = "update", state = _updateState, version = _updateVersion });
                    Send(form, new { type = "visibility", visible = form.Visible });
                    if (form.PendingPair) RequestPair(form);
                }
                break;
            case "resize":
                if (form is FlyoutForm flyout && message.TryGetProperty("height", out var h) && h.ValueKind == JsonValueKind.Number)
                    flyout.SetContentHeight(h.GetDouble());
                break;
            case "close":
                if (form is FlyoutForm f) f.HideFlyout(); else form.Close();
                break;
            case "openWindow":
                BeginInvokeUi(OpenWindow);
                break;
            case "loginItem.set":
                if (message.TryGetProperty("enabled", out var enabled) && enabled.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    SetLoginItem(enabled.GetBoolean());
                Broadcast(new { type = "loginItem", state = LoginItemState() });
                break;
            case "openLogs":
                OpenLogs();
                break;
            case "checkUpdates":
                _ = CheckUpdates(false, fromPage: true);
                break;
            case "openUpdate":
                OpenRelease(_availableUpdate?.ReleasePage ?? new Uri(UpdateChecker.ReleasesUrl));
                break;
            case "restart":
                BeginInvokeUi(RestartServer);
                break;
            case "quit":
                BeginInvokeUi(async () => { if (await StopRecording()) ExitThread(); });
                break;
        }
    }

    private void BeginInvokeUi(Action action)
    {
        if (_stopping || _dispatcher.IsDisposed) return;
        _dispatcher.BeginInvoke(action);
    }

    // ---- bridge: native -> page ------------------------------------------

    private void Send(ShellForm form, object detail)
    {
        if (!form.CoreReady || form.IsDisposed || form.View.CoreWebView2 is not { } core) return;
        var json = JsonSerializer.Serialize(detail);
        try { _ = core.ExecuteScriptAsync($"window.dispatchEvent(new CustomEvent('windockshell',{{detail:{json}}}));"); }
        catch (InvalidOperationException) { /* the WebView is going away */ }
    }

    private void Broadcast(object detail)
    {
        foreach (var pane in Panes()) Send(pane, detail);
    }

    private void SetUpdateState(string state, string? version = null)
    {
        _updateState = state;
        _updateVersion = version;
        Broadcast(new { type = "update", state, version });
    }

    // ---- login item ------------------------------------------------------

    /// <summary>Same value as the installer's autostart task: "{app}\WinDockTray.exe" in quotes.</summary>
    private static string LoginCommand => "\"" + Path.Combine(AppContext.BaseDirectory, "WinDockTray.exe") + "\"";

    private static string LoginItemState()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, false);
            return key?.GetValue(RunValue) is string { Length: > 0 } ? "on" : "off";
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return "unavailable";
        }
    }

    private void SetLoginItem(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey, true);
            if (enabled) key.SetValue(RunValue, LoginCommand, RegistryValueKind.String);
            else key.DeleteValue(RunValue, false);
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            _log.Mark($"Couldn't change the login item: {ex.Message}");
        }
    }

    private static void OpenLogs()
    {
        try
        {
            Directory.CreateDirectory(HostLog.Folder);
            Process.Start(new ProcessStartInfo(HostLog.Folder) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException or UnauthorizedAccessException) { }
    }
}
