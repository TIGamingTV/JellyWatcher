using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyWatcher.Configuration;

namespace Jellyfin.Plugin.JellyWatcher.Services;

/// <summary>What File Transformation passes to a callback.</summary>
public class PatchPayload
{
    /// <summary>Gets or sets the file contents as served by jellyfin-web.</summary>
    public string? Contents { get; set; }
}

/// <summary>
/// Changes to jellyfin-web's files, applied by the File Transformation plugin while they are
/// served (nothing on disk changes): a script tag in index.html and a menu entry in config.json.
/// </summary>
public static class WebPatches
{
    /// <summary>Route of the Watchlists page inside jellyfin-web.</summary>
    public const string PageRoute = "#/jellywatcher";

    private const string Marker = "data-jellywatcher";

    private static readonly Regex IconName = new("^[a-z0-9_]{1,40}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(250));

    /// <summary>File Transformation callback for index.html.</summary>
    /// <param name="payload">Current contents.</param>
    /// <returns>The patched contents.</returns>
    public static string IndexHtml(PatchPayload payload)
    {
        var contents = payload.Contents ?? string.Empty;
        var plugin = Plugin.Instance;
        if (plugin is null || !plugin.Configuration.Enabled)
        {
            return contents;
        }

        return InjectScript(contents, plugin.Version.ToString());
    }

    /// <summary>File Transformation callback for config.json.</summary>
    /// <param name="payload">Current contents.</param>
    /// <returns>The patched contents.</returns>
    public static string ConfigJson(PatchPayload payload)
    {
        var contents = payload.Contents ?? string.Empty;
        var plugin = Plugin.Instance;
        if (plugin is null || !plugin.Configuration.Enabled)
        {
            return contents;
        }

        return AddMenuLink(contents, plugin.Configuration);
    }

    /// <summary>Adds the page script before &lt;/body&gt; once.</summary>
    /// <param name="html">index.html.</param>
    /// <param name="version">Plugin version, for cache busting.</param>
    /// <returns>The patched html; anything that is not an html page comes back unchanged.</returns>
    public static string InjectScript(string html, string version)
    {
        // File Transformation matches file names as patterns, so "index.html" also matches chunks
        // like "session-login-index-html.*.chunk.js". Only a page with a body is changed.
        var at = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (at < 0 || html.Contains(Marker, StringComparison.Ordinal))
        {
            return html;
        }

        // Relative to /web/, so it also works when Jellyfin runs under a base path.
        var tag = $"<script {Marker} defer src=\"../JellyWatcher/client.js?v={Uri.EscapeDataString(version)}\"></script>";
        return html.Insert(at, tag);
    }

    /// <summary>Adds the Watchlists entry to menuLinks once, keeping the administrator's own links.</summary>
    /// <param name="json">config.json.</param>
    /// <param name="config">Plugin settings.</param>
    /// <returns>The patched json, or the original when it cannot be parsed.</returns>
    public static string AddMenuLink(string json, PluginConfiguration config)
    {
        JsonObject root;
        try
        {
            root = JsonNode.Parse(json, documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }) as JsonObject ?? new JsonObject();
        }
        catch (JsonException)
        {
            return json;
        }

        // Only jellyfin-web's own config.json (it lists the web plugins and themes).
        if (!root.ContainsKey("plugins") && !root.ContainsKey("themes") && !root.ContainsKey("menuLinks"))
        {
            return json;
        }

        var links = root["menuLinks"] as JsonArray;
        if (links is null)
        {
            links = new JsonArray();
            root["menuLinks"] = links;
        }

        foreach (var link in links)
        {
            if (link is JsonObject o && o["url"]?.GetValueKind() == JsonValueKind.String && o["url"]!.GetValue<string>() == PageRoute)
            {
                return json;
            }
        }

        var label = string.IsNullOrWhiteSpace(config.MenuLabel) ? "Watchlists" : config.MenuLabel.Trim();
        // jellyfin-web puts the icon name into a class attribute: only plain Material icon names.
        var icon = config.MenuIcon?.Trim() ?? string.Empty;
        if (!IconName.IsMatch(icon))
        {
            icon = "bookmarks";
        }
        links.Add(new JsonObject { ["name"] = label, ["icon"] = icon, ["url"] = PageRoute });
        return root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }
}
