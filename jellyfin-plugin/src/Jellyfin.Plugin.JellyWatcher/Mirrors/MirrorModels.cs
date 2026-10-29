using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyWatcher.Mirrors;

/// <summary>How a list is shown in Jellyfin.</summary>
public enum MirrorMode
{
    /// <summary>A Jellyfin collection (BoxSet).</summary>
    Collection,

    /// <summary>A private playlist of the list owner.</summary>
    Playlist,
}

/// <summary>Who may have lists shown as collections (collections are visible to everyone who can see the titles).</summary>
public enum CollectionPermission
{
    /// <summary>Administrators and people allowed to manage collections in Jellyfin.</summary>
    CollectionManagers,

    /// <summary>Everyone.</summary>
    Everyone,

    /// <summary>Nobody: only private playlists.</summary>
    Nobody,
}

/// <summary>GET /api/plugin/mirrors.</summary>
public sealed class MirrorPayload
{
    /// <summary>Gets or sets the JellyWatcher instance id.</summary>
    public string InstanceId { get; set; } = string.Empty;

    /// <summary>Gets or sets the lists to show in Jellyfin.</summary>
    public List<MirrorList> Lists { get; set; } = [];

    /// <summary>Options for reading JellyWatcher's JSON.</summary>
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };
}

/// <summary>One list to show in Jellyfin.</summary>
public sealed class MirrorList
{
    /// <summary>Gets or sets the JellyWatcher list id.</summary>
    public long ListId { get; set; }

    /// <summary>Gets or sets the kind of container.</summary>
    public MirrorMode Mode { get; set; }

    /// <summary>Gets or sets the list name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Gets or sets the description.</summary>
    public string? Description { get; set; }

    /// <summary>Gets or sets the owner's Jellyfin user id (32 hex characters).</summary>
    public string Owner { get; set; } = string.Empty;

    /// <summary>Gets or sets the entries in list order.</summary>
    public List<MirrorEntry> Entries { get; set; } = [];
}

/// <summary>One entry of a list.</summary>
public sealed class MirrorEntry
{
    /// <summary>Gets or sets the kind: movie, show, season or episode.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Gets or sets the media type: movie or tv.</summary>
    public string MediaType { get; set; } = string.Empty;

    /// <summary>Gets or sets the season number (season and episode entries).</summary>
    public int? Season { get; set; }

    /// <summary>Gets or sets the episode number (episode entries).</summary>
    public int? Episode { get; set; }

    /// <summary>Gets or sets the Jellyfin item JellyWatcher last saw for the entry.</summary>
    public string? JellyfinItemId { get; set; }

    /// <summary>Gets or sets every Jellyfin movie/series item of the title JellyWatcher knows of.</summary>
    public List<string> JellyfinIds { get; set; } = [];

    /// <summary>Gets or sets the TMDb id.</summary>
    public string? TmdbId { get; set; }

    /// <summary>Gets or sets the TVDB id.</summary>
    public string? TvdbId { get; set; }

    /// <summary>Gets or sets the IMDb id.</summary>
    public string? ImdbId { get; set; }
}

/// <summary>What the plugin did with one list (POST /api/plugin/mirrors/report).</summary>
/// <param name="ListId">List id.</param>
/// <param name="Mode">Mode, as JellyWatcher writes it.</param>
/// <param name="JellyfinId">The collection or playlist, if there is one.</param>
/// <param name="Applied">Items in it.</param>
/// <param name="Missing">Entries not found in the library.</param>
/// <param name="Error">What went wrong, for people.</param>
public sealed record MirrorReport(long ListId, string Mode, string? JellyfinId, int Applied, int Missing, string? Error);
