using Jellyfin.Plugin.JellyWatcher.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.JellyWatcher;

/// <summary>
/// Adds a Watchlists page to Jellyfin that shows the person's JellyWatcher lists and timelines.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>The plugin id (also used in manifest.json).</summary>
    public static readonly Guid PluginId = Guid.Parse("b3ad8b8e-844c-4e75-ab0c-caa0b5faeff8");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>Gets the running instance (set when Jellyfin loads the plugin).</summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "JellyWatcher";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <inheritdoc />
    public override string Description => "Your JellyWatcher watchlists and timelines inside Jellyfin, with Request, Not Watching and Watched buttons, and lists kept as collections or private playlists in their order.";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
        };
    }
}
