// Host stdout/stderr log: %LOCALAPPDATA%\WinDock\Logs\host.log, rotated at 1 MB,
// keeping host.log plus host.1.log and host.2.log (three files in all).
using System.Text;

namespace WinDock.Tray;

internal sealed class HostLog : IDisposable
{
    private const long MaxBytes = 1024 * 1024;
    private const int Keep = 3;
    private readonly object _gate = new();
    private StreamWriter? _writer;

    internal static string Folder => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WinDock", "Logs");

    private static string FilePath(int index) => Path.Combine(Folder, index == 0 ? "host.log" : $"host.{index}.log");

    /// <summary>Appends one line. Called from process output threads; never throws.</summary>
    internal void Write(string stream, string line)
    {
        lock (_gate)
        {
            try
            {
                if (_writer is null) Open();
                if (_writer!.BaseStream.Length >= MaxBytes) { Close(); Rotate(); Open(); }
                _writer!.WriteLine($"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{stream}] {line}");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Close(); }
        }
    }

    internal void Mark(string message) => Write("tray", message);

    private void Open()
    {
        Directory.CreateDirectory(Folder);
        var stream = new FileStream(FilePath(0), FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        _writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
    }

    private static void Rotate()
    {
        var oldest = FilePath(Keep - 1);
        if (File.Exists(oldest)) File.Delete(oldest);
        for (var i = Keep - 2; i >= 0; i--)
            if (File.Exists(FilePath(i))) File.Move(FilePath(i), FilePath(i + 1));
    }

    private void Close()
    {
        try { _writer?.Dispose(); } catch (IOException) { }
        _writer = null;
    }

    public void Dispose() { lock (_gate) Close(); }
}
