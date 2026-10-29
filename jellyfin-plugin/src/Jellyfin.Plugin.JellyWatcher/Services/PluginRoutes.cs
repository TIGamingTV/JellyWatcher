using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyWatcher.Services;

/// <summary>
/// The JellyWatcher API calls the Watchlists page may make. JellyWatcher enforces the same list;
/// checking here too keeps anything else from even leaving the Jellyfin server.
/// </summary>
public static class PluginRoutes
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(250);

    private static readonly (string Method, Regex Path)[] Routes =
    [
        ("GET", Make("^plugin/bootstrap$")),
        ("GET", Make("^lists$")),
        ("GET", Make("^lists/[0-9]{1,12}(/timeline)?$")),
        ("POST", Make("^lists/[0-9]{1,12}/sync$")),
        ("POST", Make("^lists/(link|local|trakt)$")),
        ("GET", Make("^titles/[0-9]{1,12}/eligibility$")),
        ("POST", Make("^titles/[0-9]{1,12}/request$")),
        ("PUT", Make("^titles/[0-9]{1,12}/(skipped|watched)$")),
    ];

    private static readonly Regex TmdbSize = Make("^w[0-9]{2,4}$");
    private static readonly Regex TmdbFile = new("^[A-Za-z0-9_-]{1,100}\\.(jpg|jpeg|png|webp)$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase, Timeout);

    /// <summary>Whether the page may call this JellyWatcher API path (relative to /api/).</summary>
    /// <param name="method">HTTP method.</param>
    /// <param name="path">Path below /api/, e.g. "lists/3/timeline".</param>
    /// <returns>True when allowed.</returns>
    public static bool IsAllowed(string method, string? path)
    {
        if (string.IsNullOrEmpty(path) || path.Length > 200)
        {
            return false;
        }

        path = path.TrimEnd('/');
        foreach (var (m, re) in Routes)
        {
            if (string.Equals(m, method, StringComparison.OrdinalIgnoreCase) && re.IsMatch(path))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Whether a TMDb image request looks like one JellyWatcher serves.</summary>
    /// <param name="size">Size, e.g. w342.</param>
    /// <param name="file">File name, e.g. abc.jpg.</param>
    /// <returns>True when valid.</returns>
    public static bool IsTmdbImage(string? size, string? file)
        => size is not null && file is not null && TmdbSize.IsMatch(size) && TmdbFile.IsMatch(file);

    private static Regex Make(string pattern) => new(pattern, RegexOptions.CultureInvariant, Timeout);
}
