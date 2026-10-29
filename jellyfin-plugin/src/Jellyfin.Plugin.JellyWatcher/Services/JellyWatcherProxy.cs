using System.Net;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyWatcher.Configuration;
using MediaBrowser.Controller;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyWatcher.Services;

/// <summary>A JellyWatcher answer, ready to pass on to the browser.</summary>
/// <param name="Status">HTTP status for the browser.</param>
/// <param name="ContentType">Content type.</param>
/// <param name="Body">Body bytes.</param>
public sealed record ProxyResult(int Status, string ContentType, byte[] Body);

/// <summary>Calls JellyWatcher for the Watchlists page.</summary>
public class JellyWatcherProxy
{
    /// <summary>Name of the HttpClient registered for JellyWatcher.</summary>
    public const string HttpClientName = "JellyWatcher";

    private const int MaxResponseBytes = 16 * 1024 * 1024;

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IServerApplicationHost _host;
    private readonly ILogger<JellyWatcherProxy> _logger;

    public JellyWatcherProxy(IHttpClientFactory httpClientFactory, IServerApplicationHost host, ILogger<JellyWatcherProxy> logger)
    {
        _httpClientFactory = httpClientFactory;
        _host = host;
        _logger = logger;
    }

    private static string Version => Plugin.Instance?.Version.ToString() ?? "0.0.0.0";

    /// <summary>Builds the JSON error body the page understands.</summary>
    /// <param name="status">HTTP status.</param>
    /// <param name="code">Error code.</param>
    /// <param name="message">Message for people.</param>
    /// <returns>The result.</returns>
    public static ProxyResult Error(int status, string code, string message)
        => new(status, "application/json", JsonSerializer.SerializeToUtf8Bytes(new { error = new { code, message } }));

    /// <summary>Sends an API call to JellyWatcher.</summary>
    /// <param name="config">Plugin settings (saved or, for the connection test, unsaved).</param>
    /// <param name="method">HTTP method.</param>
    /// <param name="apiPath">Path below /api/, already allowed.</param>
    /// <param name="user">The Jellyfin user, or null.</param>
    /// <param name="jsonBody">JSON body for writes.</param>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <returns>What to send back to the browser.</returns>
    public async Task<ProxyResult> SendAsync(PluginConfiguration config, HttpMethod method, string apiPath, (Guid Id, string Name)? user, string? jsonBody, CancellationToken cancellationToken)
    {
        var baseUri = JellyWatcherApi.BaseUri(config.JellyWatcherUrl);
        if (baseUri is null || string.IsNullOrWhiteSpace(config.PluginKey))
        {
            return Error(503, "plugin_not_configured", "The JellyWatcher plugin is not set up yet. An administrator needs to enter JellyWatcher's address and plugin key in Dashboard › Plugins › JellyWatcher.");
        }

        using var request = JellyWatcherApi.Build(baseUri, config.PluginKey, method, apiPath, user, Version, _host.SystemId);
        if (jsonBody is not null)
        {
            request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        }

        try
        {
            using var response = await _httpClientFactory.CreateClient(HttpClientName).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            var body = await ReadLimitedAsync(response.Content, cancellationToken).ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
            var status = (int)response.StatusCode;
            if (status is >= 300 and < 400)
            {
                return Error(502, "jellywatcher_redirect", "JellyWatcher answered with a redirect. Check the JellyWatcher address in the plugin settings (http or https, no trailing path).");
            }

            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                // A 401 would make Jellyfin's web app sign the person out; it is the plugin's key that failed.
                _logger.LogWarning("JellyWatcher rejected the plugin key");
                return new ProxyResult(503, contentType, body);
            }

            return new ProxyResult(status, contentType, body);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("JellyWatcher could not be reached at {Url}: {Message}", baseUri, ex.Message);
            return Error(502, "jellywatcher_unreachable", "JellyWatcher could not be reached. Ask an administrator to check the address in the plugin settings.");
        }
    }

    /// <summary>Fetches TMDb artwork through JellyWatcher's image cache.</summary>
    /// <param name="size">Image size.</param>
    /// <param name="file">File name.</param>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <returns>The image, or null.</returns>
    public async Task<ProxyResult?> TmdbImageAsync(string size, string file, CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null || !config.Enabled)
        {
            return null;
        }

        var result = await SendAsync(config, HttpMethod.Get, $"images/tmdb/{size}/{file}", null, null, cancellationToken).ConfigureAwait(false);
        return result.Status == 200 && result.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ? result : null;
    }

    private static async Task<byte[]> ReadLimitedAsync(HttpContent content, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength > MaxResponseBytes)
        {
            throw new HttpRequestException("JellyWatcher's answer is too large.");
        }

        await using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false)) > 0)
        {
            if (buffer.Length + read > MaxResponseBytes)
            {
                throw new HttpRequestException("JellyWatcher's answer is too large.");
            }

            buffer.Write(chunk, 0, read);
        }

        return buffer.ToArray();
    }
}
