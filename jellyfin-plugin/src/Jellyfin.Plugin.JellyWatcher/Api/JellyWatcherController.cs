using System.Net.Mime;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyWatcher.Configuration;
using Jellyfin.Plugin.JellyWatcher.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyWatcher.Api;

/// <summary>
/// Endpoints of the Watchlists page: its script, TMDb artwork, and the JellyWatcher API calls it
/// makes, sent on for the signed-in Jellyfin user.
/// </summary>
[ApiController]
[Route("JellyWatcher")]
public class JellyWatcherController : ControllerBase
{
    private const int MaxBodyBytes = 1024 * 1024;
    private const string UserIdClaim = "Jellyfin-UserId";
    private const string IsApiKeyClaim = "Jellyfin-IsApiKey";

    private readonly JellyWatcherProxy _proxy;

    public JellyWatcherController(JellyWatcherProxy proxy)
    {
        _proxy = proxy;
    }

    /// <summary>The Watchlists page script (loaded by jellyfin-web through File Transformation).</summary>
    /// <returns>The script.</returns>
    [HttpGet("client.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ActionResult GetClientScript()
    {
        var stream = typeof(Plugin).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyWatcher.Web.client.js");
        if (stream is null)
        {
            return NotFound();
        }

        // The URL carries the plugin version, so a new version is fetched after an update.
        Response.Headers.CacheControl = Request.Query.ContainsKey("v") ? "public, max-age=604800" : "no-cache";
        return File(stream, "application/javascript; charset=utf-8");
    }

    /// <summary>TMDb artwork through JellyWatcher's image cache (public images; img tags send no auth headers).</summary>
    /// <param name="size">Size, e.g. w342.</param>
    /// <param name="file">File name.</param>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <returns>The image.</returns>
    [HttpGet("img/tmdb/{size}/{file}")]
    [AllowAnonymous]
    public async Task<ActionResult> GetTmdbImage([FromRoute] string size, [FromRoute] string file, CancellationToken cancellationToken)
    {
        if (!PluginRoutes.IsTmdbImage(size, file))
        {
            return BadRequest();
        }

        var image = await _proxy.TmdbImageAsync(size, file, cancellationToken).ConfigureAwait(false);
        if (image is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=604800";
        Response.Headers.XContentTypeOptions = "nosniff";
        return File(image.Body, image.ContentType);
    }

    /// <summary>What the page needs from the plugin settings (nothing secret).</summary>
    /// <returns>Page settings.</returns>
    [HttpGet("Settings")]
    [Authorize]
    public ActionResult GetPageSettings()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        Response.Headers.CacheControl = "no-store";
        return Ok(new
        {
            enabled = config.Enabled,
            configured = JellyWatcherApi.IsConfigured(config),
            menuLabel = string.IsNullOrWhiteSpace(config.MenuLabel) ? "Watchlists" : config.MenuLabel.Trim(),
            publicUrl = JellyWatcherApi.BaseUri(config.PublicUrl)?.ToString(),
        });
    }

    /// <summary>Sends one of the allowed JellyWatcher API calls for the signed-in Jellyfin user.</summary>
    /// <param name="path">Path below JellyWatcher's /api/.</param>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <returns>JellyWatcher's answer.</returns>
    [AcceptVerbs("GET", "POST", "PUT")]
    [Route("api/{**path}")]
    [Authorize]
    [RequestSizeLimit(MaxBodyBytes)]
    public async Task<ActionResult> Forward([FromRoute] string? path, CancellationToken cancellationToken)
    {
        Response.Headers.CacheControl = "no-store";
        var config = Plugin.Instance?.Configuration;
        if (config is null || !config.Enabled)
        {
            return Result(JellyWatcherProxy.Error(404, "plugin_disabled", "The Watchlists page is turned off."));
        }

        if (!PluginRoutes.IsAllowed(Request.Method, path))
        {
            return Result(JellyWatcherProxy.Error(403, "plugin_forbidden", "The Watchlists page cannot use this part of JellyWatcher."));
        }

        var user = CurrentUser();
        if (user is null)
        {
            return Result(JellyWatcherProxy.Error(403, "plugin_user", "Sign in to Jellyfin with a user account to use your watchlists."));
        }

        string? body = null;
        if (!HttpMethods.IsGet(Request.Method))
        {
            using var reader = new StreamReader(Request.Body, Encoding.UTF8);
            body = await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(body))
            {
                body = "{}";
            }
        }

        var method = new HttpMethod(Request.Method.ToUpperInvariant());
        return Result(await _proxy.SendAsync(config, method, path!.TrimEnd('/'), user, body, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>Whether File Transformation is installed and the page is registered (settings page).</summary>
    /// <returns>Setup state.</returns>
    [HttpGet("Setup")]
    [Authorize(Policy = "RequiresElevation")]
    public ActionResult GetSetup()
    {
        Response.Headers.CacheControl = "no-store";
        return Ok(new
        {
            fileTransformation = FileTransformationRegistrar.FileTransformationInterface() is not null,
            registered = FileTransformationRegistrar.Registered,
            version = Plugin.Instance?.Version.ToString(),
        });
    }

    /// <summary>Tests the address and key entered on the settings page (saved values fill empty fields).</summary>
    /// <param name="request">Address and key to test.</param>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <returns>The result.</returns>
    [HttpPost("Test")]
    [Authorize(Policy = "RequiresElevation")]
    [Consumes(MediaTypeNames.Application.Json)]
    public async Task<ActionResult> Test([FromBody] TestRequest request, CancellationToken cancellationToken)
    {
        var saved = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var url = string.IsNullOrWhiteSpace(request.JellyWatcherUrl) ? saved.JellyWatcherUrl : request.JellyWatcherUrl;
        if (JellyWatcherApi.BaseUri(url) is null)
        {
            return Ok(new { ok = false, message = "Enter JellyWatcher's address, starting with http:// or https://." });
        }

        // The saved key is only sent to the saved address, never to a new one typed in for the test.
        var key = request.PluginKey;
        if (string.IsNullOrWhiteSpace(key))
        {
            if (!JellyWatcherApi.SameServer(url, saved.JellyWatcherUrl))
            {
                return Ok(new { ok = false, message = "Enter the plugin key to test a new address." });
            }

            key = saved.PluginKey;
        }

        var config = new PluginConfiguration { JellyWatcherUrl = url, PluginKey = key };

        var result = await _proxy.SendAsync(config, HttpMethod.Get, "plugin/status", null, null, cancellationToken).ConfigureAwait(false);
        if (result.Status != 200 || !result.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
        {
            return Ok(new { ok = false, message = ErrorMessage(result) ?? $"The address did not answer like JellyWatcher (status {result.Status})." });
        }

        using var doc = JsonDocument.Parse(result.Body);
        var version = doc.RootElement.TryGetProperty("version", out var v) ? v.GetString() : null;
        return Ok(new { ok = true, message = $"Connected to JellyWatcher {version}.", version });
    }

    private static string? ErrorMessage(ProxyResult result)
    {
        try
        {
            using var doc = JsonDocument.Parse(result.Body);
            return doc.RootElement.GetProperty("error").GetProperty("message").GetString();
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return null;
        }
    }

    private (Guid Id, string Name)? CurrentUser()
    {
        if (string.Equals(User.FindFirstValue(IsApiKeyClaim), "true", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        if (!Guid.TryParse(User.FindFirstValue(UserIdClaim), out var id) || id == Guid.Empty)
        {
            return null;
        }

        return (id, User.FindFirstValue(ClaimTypes.Name) ?? string.Empty);
    }

    private ContentResult Result(ProxyResult r)
    {
        // Only JSON is passed on: whatever answers at the configured address, nothing it sends can be
        // rendered as a page on Jellyfin's origin.
        Response.Headers.XContentTypeOptions = "nosniff";
        var json = r.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase);
        return new ContentResult
        {
            StatusCode = json ? r.Status : 502,
            ContentType = "application/json; charset=utf-8",
            Content = json ? Encoding.UTF8.GetString(r.Body) : Encoding.UTF8.GetString(JellyWatcherProxy.Error(502, "jellywatcher_bad_answer", "The address in the plugin settings did not answer like JellyWatcher.").Body),
        };
    }

    /// <summary>Body of the connection test.</summary>
    public class TestRequest
    {
        /// <summary>Gets or sets the address to test.</summary>
        public string? JellyWatcherUrl { get; set; }

        /// <summary>Gets or sets the key to test.</summary>
        public string? PluginKey { get; set; }
    }
}
