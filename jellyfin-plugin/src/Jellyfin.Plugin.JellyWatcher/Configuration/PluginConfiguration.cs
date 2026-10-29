using Jellyfin.Plugin.JellyWatcher.Mirrors;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.JellyWatcher.Configuration;

/// <summary>
/// Settings an administrator enters on the plugin page.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets a value indicating whether the Watchlists page is shown.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Gets or sets the address Jellyfin uses to reach JellyWatcher, e.g. http://jellywatcher:8484.</summary>
    public string JellyWatcherUrl { get; set; } = string.Empty;

    /// <summary>Gets or sets the plugin key from JellyWatcher › Integrations › Jellyfin.</summary>
    public string PluginKey { get; set; } = string.Empty;

    /// <summary>Gets or sets the address browsers use for JellyWatcher ("Open in JellyWatcher" links). Optional.</summary>
    public string PublicUrl { get; set; } = string.Empty;

    /// <summary>Gets or sets the name of the menu entry.</summary>
    public string MenuLabel { get; set; } = "Watchlists";

    /// <summary>Gets or sets the Material icon of the menu entry.</summary>
    public string MenuIcon { get; set; } = "bookmarks";

    /// <summary>Gets or sets a value indicating whether lists people choose are kept in Jellyfin as collections or playlists.</summary>
    public bool MirrorEnabled { get; set; } = true;

    /// <summary>Gets or sets how often (minutes) the collections and playlists are updated.</summary>
    public int MirrorIntervalMinutes { get; set; } = 5;

    /// <summary>Gets or sets who may show lists as collections (collections are visible to everyone who can see the titles).</summary>
    public CollectionPermission CollectionPermission { get; set; } = CollectionPermission.CollectionManagers;
}
