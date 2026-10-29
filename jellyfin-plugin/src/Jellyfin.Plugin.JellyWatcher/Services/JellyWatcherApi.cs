using System.Net.Http.Headers;
using Jellyfin.Plugin.JellyWatcher.Configuration;

namespace Jellyfin.Plugin.JellyWatcher.Services;

/// <summary>
/// Builds requests to JellyWatcher. The plugin key proves the request comes from this plugin; the
/// Jellyfin user headers say whom it is for (Jellyfin has already authenticated that person).
/// </summary>
public static class JellyWatcherApi
{
    /// <summary>Header carrying the shared plugin key.</summary>
    public const string KeyHeader = "X-JW-Plugin-Key";

    /// <summary>Header carrying the Jellyfin user id.</summary>
    public const string UserHeader = "X-JW-Jellyfin-User";

    /// <summary>Header carrying the (URL-encoded) Jellyfin user name.</summary>
    public const string NameHeader = "X-JW-Jellyfin-Name";

    /// <summary>Header carrying the plugin version.</summary>
    public const string VersionHeader = "X-JW-Plugin-Version";

    /// <summary>Header carrying the Jellyfin server id.</summary>
    public const string ServerHeader = "X-JW-Jellyfin-Server";

    /// <summary>Validates and normalizes a JellyWatcher address (http or https, no query).</summary>
    /// <param name="value">What the administrator entered.</param>
    /// <returns>The base URL without a trailing slash, or null when it is not usable.</returns>
    public static Uri? BaseUri(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)
            || !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.UserInfo))
        {
            return null;
        }

        return new Uri(uri.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/", UriKind.Absolute);
    }

    /// <summary>Whether the settings are complete enough to call JellyWatcher.</summary>
    /// <param name="config">Plugin settings.</param>
    /// <returns>True when a valid address and a key are set.</returns>
    public static bool IsConfigured(PluginConfiguration config)
        => BaseUri(config.JellyWatcherUrl) is not null && !string.IsNullOrWhiteSpace(config.PluginKey);

    /// <summary>Builds a request to a JellyWatcher API path.</summary>
    /// <param name="baseUri">JellyWatcher base URL from <see cref="BaseUri"/>.</param>
    /// <param name="key">Plugin key.</param>
    /// <param name="method">HTTP method.</param>
    /// <param name="apiPath">Path below /api/, already checked against <see cref="PluginRoutes"/>.</param>
    /// <param name="user">Jellyfin user id and name, or null for requests not made for a person.</param>
    /// <param name="pluginVersion">Plugin version.</param>
    /// <param name="serverId">Jellyfin server id.</param>
    /// <returns>The request.</returns>
    public static HttpRequestMessage Build(Uri baseUri, string key, HttpMethod method, string apiPath, (Guid Id, string Name)? user, string pluginVersion, string serverId)
    {
        var req = new HttpRequestMessage(method, new Uri(baseUri, "api/" + apiPath.TrimStart('/')));
        req.Headers.TryAddWithoutValidation(KeyHeader, key.Trim());
        req.Headers.TryAddWithoutValidation(VersionHeader, pluginVersion);
        req.Headers.TryAddWithoutValidation(ServerHeader, serverId);
        if (user is { } u)
        {
            req.Headers.TryAddWithoutValidation(UserHeader, u.Id.ToString("N"));
            req.Headers.TryAddWithoutValidation(NameHeader, Uri.EscapeDataString(u.Name));
        }

        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Headers.UserAgent.TryParseAdd($"JellyWatcher-Jellyfin-Plugin/{pluginVersion}");
        return req;
    }
}
