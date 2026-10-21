// Now-playing via the Windows media transport controls.
//
// GlobalSystemMediaTransportControlsSessionManager reports whatever app owns
// the current media session (Spotify, a browser tab, a local player), so the
// dock shows real track information instead of guessing from window titles.
//
// Every verb is stateless: a session is named by its SourceAppUserModelId on
// each call (the host passes it back), so nothing is remembered between runs.
// Output is one JSON object on stdout, bounded: at most MaxSessions sessions,
// strings truncated, artwork capped at MaxArtworkBytes.

using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Windows.Media;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace WinDock;

internal static class MediaSession
{
    public const int MaxSessions = 16;
    public const int MaxText = 512;
    /** Encoded artwork larger than this is never printed. */
    public const int MaxArtworkBytes = 2 * 1024 * 1024;
    /** A raw thumbnail stream larger than this is not even read. */
    private const ulong MaxThumbnailStreamBytes = 16 * 1024 * 1024;
    public const int MaxArtworkEdge = 512;

    // ---- legacy: nowplaying -------------------------------------------------

    public static object? Current()
    {
        try
        {
            var manager = Manager();
            var session = manager?.GetCurrentSession();
            if (session is null) return null;

            var props = session.TryGetMediaPropertiesAsync()
                .AsTask().GetAwaiter().GetResult();
            if (props is null || string.IsNullOrWhiteSpace(props.Title)) return null;

            var playback = session.GetPlaybackInfo();
            var playing = playback?.PlaybackStatus
                == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;

            return new
            {
                title = props.Title,
                artist = props.Artist ?? string.Empty,
                playing,
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"nowplaying: {ex.Message}");
            return null;
        }
    }

    // ---- shared -----------------------------------------------------------

    private static GlobalSystemMediaTransportControlsSessionManager? Manager() =>
        GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask().GetAwaiter().GetResult();

    /** Same rule as the host contract: 1..256 printable ASCII, no spaces. */
    public static bool ValidSessionId(string? id) =>
        !string.IsNullOrEmpty(id) && id.Length <= 256 && id.All(c => c >= 0x21 && c <= 0x7e);

    private static string Clip(string? value) =>
        string.IsNullOrEmpty(value) ? string.Empty : (value.Length > MaxText ? value[..MaxText] : value);

    /** Sessions with a usable id, first occurrence of each id only. */
    private static List<GlobalSystemMediaTransportControlsSession> Sessions(GlobalSystemMediaTransportControlsSessionManager manager)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var list = new List<GlobalSystemMediaTransportControlsSession>();
        foreach (var session in manager.GetSessions())
        {
            var id = session.SourceAppUserModelId;
            if (!ValidSessionId(id) || !seen.Add(id)) continue;
            list.Add(session);
            if (list.Count >= MaxSessions) break;
        }
        return list;
    }

    /** The named session, or the current one when no id is given. Null when absent. */
    private static GlobalSystemMediaTransportControlsSession? Find(GlobalSystemMediaTransportControlsSessionManager manager, string sessionId)
    {
        if (sessionId.Length == 0) return manager.GetCurrentSession() ?? Sessions(manager).FirstOrDefault();
        return Sessions(manager).FirstOrDefault(s => s.SourceAppUserModelId == sessionId);
    }

    /** 32 lowercase hex characters, stable per track and session. */
    public static string ArtworkKey(string sessionId, string title, string artist, string album)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"windows\0{sessionId}\0{title}\0{artist}\0{album}"));
        return Convert.ToHexString(bytes)[..32].ToLowerInvariant();
    }

    private static string Status(GlobalSystemMediaTransportControlsSessionPlaybackStatus? status) => status switch
    {
        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "playing",
        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => "paused",
        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped => "stopped",
        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Changing => "changing",
        GlobalSystemMediaTransportControlsSessionPlaybackStatus.Opened => "opened",
        _ => "closed",
    };

    private static string? Repeat(MediaPlaybackAutoRepeatMode? mode) => mode switch
    {
        MediaPlaybackAutoRepeatMode.None => "off",
        MediaPlaybackAutoRepeatMode.List => "all",
        MediaPlaybackAutoRepeatMode.Track => "one",
        _ => null,
    };

    /**
     * Best-effort display name and executable path for a session's source.
     * Packaged apps are named by their package; desktop apps report
     * "name.exe", resolved through a running process with that image name.
     */
    private static (string? name, string? path) Identify(string sessionId)
    {
        try
        {
            if (sessionId.Contains('!') && OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
            {
                var info = Windows.ApplicationModel.AppInfo.GetFromAppUserModelId(sessionId);
                var name = info?.DisplayInfo?.DisplayName;
                if (!string.IsNullOrWhiteSpace(name)) return (Clip(name), null);
            }
        }
        catch
        {
            /* not a packaged id */
        }

        var image = sessionId.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? sessionId[..^4] : null;
        if (image is null || image.Length == 0 || image.IndexOfAny(new[] { '\\', '/', ':' }) >= 0) return (null, null);
        string? path = null;
        string? display = null;
        foreach (var proc in System.Diagnostics.Process.GetProcessesByName(image))
        {
            using (proc)
            {
                if (path is not null) continue;
                try
                {
                    path = proc.MainModule?.FileName;
                    if (path is not null)
                    {
                        var description = System.Diagnostics.FileVersionInfo.GetVersionInfo(path).FileDescription;
                        if (!string.IsNullOrWhiteSpace(description)) display = description.Trim();
                    }
                }
                catch
                {
                    /* access denied: another user's or an elevated process */
                }
            }
        }
        return (Clip(display ?? image), path is null ? null : Clip(path));
    }

    private static long? UnixMs(DateTimeOffset value) =>
        value.Year < 2000 ? null : value.ToUnixTimeMilliseconds();

    private static object Describe(GlobalSystemMediaTransportControlsSession session, bool current)
    {
        var id = session.SourceAppUserModelId;
        GlobalSystemMediaTransportControlsSessionMediaProperties? props = null;
        try
        {
            props = session.TryGetMediaPropertiesAsync().AsTask().GetAwaiter().GetResult();
        }
        catch
        {
            /* a session can vanish between listing and reading */
        }
        var playback = session.GetPlaybackInfo();
        var controls = playback?.Controls;
        var timeline = session.GetTimelineProperties();

        long? durationMs = null;
        long? positionMs = null;
        long? updatedAt = null;
        if (timeline is not null)
        {
            var duration = timeline.EndTime - timeline.StartTime;
            if (duration > TimeSpan.Zero)
            {
                durationMs = (long)duration.TotalMilliseconds;
                var position = timeline.Position - timeline.StartTime;
                positionMs = position < TimeSpan.Zero ? 0 : (long)position.TotalMilliseconds;
                updatedAt = UnixMs(timeline.LastUpdatedTime);
            }
        }

        var title = Clip(props?.Title);
        var artist = Clip(props?.Artist);
        if (artist.Length == 0) artist = Clip(props?.AlbumArtist);
        var album = Clip(props?.AlbumTitle);
        var (name, path) = Identify(id);

        return new
        {
            sessionId = id,
            name,
            path,
            current,
            title,
            artist,
            album,
            status = Status(playback?.PlaybackStatus),
            positionMs,
            durationMs,
            updatedAt,
            shuffle = playback?.IsShuffleActive,
            repeat = Repeat(playback?.AutoRepeatMode),
            controls = new
            {
                previous = controls?.IsPreviousEnabled == true,
                next = controls?.IsNextEnabled == true,
                playPause = controls?.IsPlayPauseToggleEnabled == true || controls?.IsPlayEnabled == true || controls?.IsPauseEnabled == true,
                seek = controls?.IsPlaybackPositionEnabled == true && durationMs > 0,
                shuffle = controls?.IsShuffleEnabled == true,
                repeat = controls?.IsRepeatEnabled == true,
            },
            artworkKey = props?.Thumbnail is not null && title.Length > 0 ? ArtworkKey(id, title, artist, album) : null,
        };
    }

    // ---- media-state ------------------------------------------------------

    public static int State(string[] args)
    {
        if (args.Length != 1) return Program.Usage("usage: media-state");
        var manager = Manager();
        if (manager is null)
        {
            Console.Out.Write(JsonSerializer.Serialize(new { current = (string?)null, sessions = Array.Empty<object>() }));
            return 0;
        }
        var currentId = manager.GetCurrentSession()?.SourceAppUserModelId;
        if (!ValidSessionId(currentId)) currentId = null;
        var sessions = Sessions(manager).Select(s => Describe(s, s.SourceAppUserModelId == currentId)).ToList();
        Console.Out.Write(JsonSerializer.Serialize(new { current = currentId, sessions }));
        return 0;
    }

    // ---- media-command ----------------------------------------------------

    private static int Outcome(bool ok, string? error = null)
    {
        Console.Out.Write(ok ? "{\"ok\":true}" : JsonSerializer.Serialize(new { ok = false, error }));
        return 0;
    }

    /** media-command <action> [value] [sessionId]; an empty value or id means none. */
    public static int Command(string[] args)
    {
        if (args.Length is < 2 or > 4) return Program.Usage("usage: media-command <action> [value] [sessionId]");
        var action = args[1];
        var value = args.Length > 2 ? args[2] : string.Empty;
        var sessionId = args.Length > 3 ? args[3] : string.Empty;
        if (sessionId.Length > 0 && !ValidSessionId(sessionId)) return Program.Usage("media-command: invalid session id");

        long seekMs = 0;
        bool shuffle = false;
        MediaPlaybackAutoRepeatMode repeat = MediaPlaybackAutoRepeatMode.None;
        switch (action)
        {
            case "play":
            case "pause":
            case "toggle":
            case "next":
            case "previous":
                if (value.Length != 0) return Program.Usage($"media-command: {action} takes no value");
                break;
            case "seek":
                // Same ceiling as the host contract: 24 h.
                if (!long.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out seekMs)
                    || seekMs < 0 || seekMs > 86_400_000) return Program.Usage("media-command: seek takes 0..86400000 ms");
                break;
            case "shuffle":
                if (value == "true") shuffle = true;
                else if (value == "false") shuffle = false;
                else return Program.Usage("media-command: shuffle takes true or false");
                break;
            case "repeat":
                switch (value)
                {
                    case "off": repeat = MediaPlaybackAutoRepeatMode.None; break;
                    case "all": repeat = MediaPlaybackAutoRepeatMode.List; break;
                    case "one": repeat = MediaPlaybackAutoRepeatMode.Track; break;
                    default: return Program.Usage("media-command: repeat takes off, all or one");
                }
                break;
            default:
                return Program.Usage($"media-command: unknown action {action}");
        }

        var manager = Manager();
        var session = manager is null ? null : Find(manager, sessionId);
        if (session is null) return Outcome(false, sessionId.Length > 0 ? "unknown-session" : "no-session");

        var accepted = action switch
        {
            "play" => session.TryPlayAsync().AsTask().GetAwaiter().GetResult(),
            "pause" => session.TryPauseAsync().AsTask().GetAwaiter().GetResult(),
            "toggle" => session.TryTogglePlayPauseAsync().AsTask().GetAwaiter().GetResult(),
            "next" => session.TrySkipNextAsync().AsTask().GetAwaiter().GetResult(),
            "previous" => session.TrySkipPreviousAsync().AsTask().GetAwaiter().GetResult(),
            // The requested position is on the session's own timeline.
            "seek" => session.TryChangePlaybackPositionAsync(
                (session.GetTimelineProperties()?.StartTime ?? TimeSpan.Zero).Ticks + seekMs * TimeSpan.TicksPerMillisecond)
                .AsTask().GetAwaiter().GetResult(),
            "shuffle" => session.TryChangeShuffleActiveAsync(shuffle).AsTask().GetAwaiter().GetResult(),
            "repeat" => session.TryChangeAutoRepeatModeAsync(repeat).AsTask().GetAwaiter().GetResult(),
            _ => false,
        };
        return accepted ? Outcome(true) : Outcome(false, "rejected");
    }

    // ---- media-artwork ----------------------------------------------------

    /** media-artwork [sessionId]: the session's thumbnail as PNG/JPEG, at most 512 px. */
    public static int Artwork(string[] args)
    {
        if (args.Length > 2) return Program.Usage("usage: media-artwork [sessionId]");
        var sessionId = args.Length == 2 ? args[1] : string.Empty;
        if (sessionId.Length > 0 && !ValidSessionId(sessionId)) return Program.Usage("media-artwork: invalid session id");

        var manager = Manager();
        var session = manager is null ? null : Find(manager, sessionId);
        if (session is null) return Outcome(false, sessionId.Length > 0 ? "unknown-session" : "no-session");

        var props = session.TryGetMediaPropertiesAsync().AsTask().GetAwaiter().GetResult();
        var title = Clip(props?.Title);
        if (props?.Thumbnail is null || title.Length == 0) return Outcome(false, "no-artwork");
        var artist = Clip(props.Artist);
        if (artist.Length == 0) artist = Clip(props.AlbumArtist);
        var key = ArtworkKey(session.SourceAppUserModelId, title, artist, Clip(props.AlbumTitle));

        byte[] raw;
        using (var stream = props.Thumbnail.OpenReadAsync().AsTask().GetAwaiter().GetResult())
        {
            if (stream.Size == 0 || stream.Size > MaxThumbnailStreamBytes) return Outcome(false, "no-artwork");
            var size = (uint)stream.Size;
            using var reader = new DataReader(stream.GetInputStreamAt(0));
            var loaded = reader.LoadAsync(size).AsTask().GetAwaiter().GetResult();
            raw = new byte[loaded];
            reader.ReadBytes(raw);
        }

        var encoded = Fit(raw);
        if (encoded is null) return Outcome(false, "no-artwork");
        Console.Out.Write(JsonSerializer.Serialize(new { ok = true, key, mime = encoded.Value.mime, data = Convert.ToBase64String(encoded.Value.bytes) }));
        return 0;
    }

    private static bool IsPng(byte[] b) => b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47;
    private static bool IsJpeg(byte[] b) => b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8;

    /** PNG/JPEG bytes at most MaxArtworkEdge on the larger edge and MaxArtworkBytes long. */
    private static (string mime, byte[] bytes)? Fit(byte[] raw)
    {
        try
        {
            using var input = new MemoryStream(raw, writable: false);
            using var image = Image.FromStream(input, useEmbeddedColorManagement: false, validateImageData: true);
            var edge = Math.Max(image.Width, image.Height);
            if (edge <= 0) return null;
            if (edge <= MaxArtworkEdge && raw.Length <= MaxArtworkBytes && (IsPng(raw) || IsJpeg(raw)))
            {
                return (IsPng(raw) ? "image/png" : "image/jpeg", raw);
            }

            var scale = Math.Min(1.0, (double)MaxArtworkEdge / edge);
            var width = Math.Max(1, (int)Math.Round(image.Width * scale));
            var height = Math.Max(1, (int)Math.Round(image.Height * scale));
            using var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.Black);
                g.DrawImage(image, 0, 0, width, height);
            }
            var codec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(c => c.FormatID == ImageFormat.Jpeg.Guid);
            using var output = new MemoryStream();
            if (codec is null)
            {
                bitmap.Save(output, ImageFormat.Png);
            }
            else
            {
                using var parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 88L);
                bitmap.Save(output, codec, parameters);
            }
            var bytes = output.ToArray();
            if (bytes.Length > MaxArtworkBytes) return null;
            return (codec is null ? "image/png" : "image/jpeg", bytes);
        }
        catch (ArgumentException)
        {
            return null; // not an image GDI+ can read
        }
        catch (System.Runtime.InteropServices.ExternalException)
        {
            return null;
        }
    }
}
