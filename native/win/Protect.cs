// DPAPI (CurrentUser) storage for the host's Spotify tokens.
//
//   protect-write <path>   read the secret from stdin, encrypt it for this
//                          Windows user, write the blob to <path> atomically
//   protect-read <path>    decrypt <path> and write the secret to stdout
//
// The secret only ever travels on stdin/stdout, never in argv. The blob is
// bound to the current user (CRYPTPROTECT_UI_FORBIDDEN, no machine scope)
// and to a fixed entropy string, so another user or another program using
// DPAPI with its own entropy cannot read it.

using System.Runtime.InteropServices;
using System.Text;

namespace WinDock;

internal static class Protect
{
    private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;
    private const int MaxSecretBytes = 16 * 1024;
    private const int MaxBlobBytes = 64 * 1024;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("WinDock.Spotify.v1");

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Size;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(ref DataBlob input, string? description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(ref DataBlob input, IntPtr description, ref DataBlob entropy, IntPtr reserved, IntPtr prompt, int flags, out DataBlob output);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static int Write(string[] args)
    {
        if (args.Length != 2 || !ValidPath(args[1])) return Program.Usage("usage: protect-write <absolute path>");
        using var stdin = Console.OpenStandardInput();
        using var buffer = new MemoryStream();
        var chunk = new byte[4096];
        int read;
        while ((read = stdin.Read(chunk, 0, chunk.Length)) > 0)
        {
            buffer.Write(chunk, 0, read);
            if (buffer.Length > MaxSecretBytes) return Program.Usage("protect-write: secret too large");
        }
        var secret = buffer.ToArray();
        if (secret.Length == 0) return Program.Usage("protect-write: empty secret");
        var blob = Transform(secret, protect: true);
        Array.Clear(secret);
        var path = args[1];
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = $"{path}.{Environment.ProcessId}.tmp";
        File.WriteAllBytes(temp, blob);
        File.Move(temp, path, overwrite: true);
        return 0;
    }

    public static int Read(string[] args)
    {
        if (args.Length != 2 || !ValidPath(args[1])) return Program.Usage("usage: protect-read <absolute path>");
        var path = args[1];
        if (!File.Exists(path)) return 3;
        var blob = File.ReadAllBytes(path);
        if (blob.Length == 0 || blob.Length > MaxBlobBytes) return 2;
        var secret = Transform(blob, protect: false);
        using var stdout = Console.OpenStandardOutput();
        stdout.Write(secret, 0, secret.Length);
        Array.Clear(secret);
        return 0;
    }

    /// An absolute path to a .dpapi file; the host only ever passes its own data-dir path.
    private static bool ValidPath(string path) =>
        !string.IsNullOrWhiteSpace(path) && Path.IsPathFullyQualified(path) &&
        path.EndsWith(".dpapi", StringComparison.OrdinalIgnoreCase) && path.IndexOfAny(Path.GetInvalidPathChars()) < 0;

    private static byte[] Transform(byte[] data, bool protect)
    {
        var input = Pin(data, out var inputHandle);
        var entropy = Pin(Entropy, out var entropyHandle);
        try
        {
            DataBlob output;
            var ok = protect
                ? CryptProtectData(ref input, "WinDock Spotify", ref entropy, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out output)
                : CryptUnprotectData(ref input, IntPtr.Zero, ref entropy, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, out output);
            if (!ok) throw new InvalidOperationException($"DPAPI failed ({Marshal.GetLastWin32Error()})");
            try
            {
                var result = new byte[output.Size];
                Marshal.Copy(output.Data, result, 0, output.Size);
                return result;
            }
            finally
            {
                LocalFree(output.Data);
            }
        }
        finally
        {
            inputHandle.Free();
            entropyHandle.Free();
        }
    }

    private static DataBlob Pin(byte[] data, out GCHandle handle)
    {
        handle = GCHandle.Alloc(data, GCHandleType.Pinned);
        return new DataBlob { Size = data.Length, Data = handle.AddrOfPinnedObject() };
    }
}
