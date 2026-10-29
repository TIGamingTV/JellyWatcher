using System.Globalization;

namespace Jellyfin.Plugin.JellyWatcher.Mirrors;

/// <summary>A collection or playlist this plugin made: its Jellyfin id, kind, and the list it belongs to.</summary>
/// <param name="ItemId">Jellyfin item id.</param>
/// <param name="Mode">Collection or playlist.</param>
/// <param name="Tag">The JellyWatcher tag, "instanceId:listId".</param>
/// <param name="OwnerId">Playlist owner (empty for collections).</param>
public sealed record OwnedContainer(Guid ItemId, MirrorMode Mode, string Tag, Guid OwnerId);

/// <summary>How to bring a collection or playlist from what it holds to what it should hold.</summary>
/// <param name="Remove">Items to take out.</param>
/// <param name="Add">Items to add at the end, in order.</param>
/// <param name="Rewrite">Whether the order changed, so everything is written again.</param>
public sealed record ContainerPlan(IReadOnlyList<Guid> Remove, IReadOnlyList<Guid> Add, bool Rewrite)
{
    /// <summary>Gets a value indicating whether nothing needs to change.</summary>
    public bool Unchanged => !Rewrite && Remove.Count == 0 && Add.Count == 0;
}

/// <summary>Episode facts used to put a show's or season's episodes in order.</summary>
/// <param name="Id">Jellyfin item id.</param>
/// <param name="Season">Season number.</param>
/// <param name="Episode">Episode number.</param>
/// <param name="EpisodeEnd">Last episode number of a multi-episode file.</param>
/// <param name="SortName">Sort name, the last tie-breaker.</param>
public sealed record EpisodeRef(Guid Id, int? Season, int? Episode, int? EpisodeEnd, string SortName);

/// <summary>Pure decisions of the mirror sync (no Jellyfin calls, so they can be tested).</summary>
public static class MirrorPlanner
{
    /// <summary>Provider id key that marks collections and playlists made by this plugin.</summary>
    public const string ProviderKey = "JellyWatcher";

    /// <summary>Builds the tag of a list.</summary>
    /// <param name="instanceId">JellyWatcher instance id.</param>
    /// <param name="listId">List id.</param>
    /// <returns>"instanceId:listId".</returns>
    public static string Tag(string instanceId, long listId) => $"{instanceId}:{listId.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>Splits a tag into instance and list id.</summary>
    /// <param name="tag">The tag.</param>
    /// <param name="instanceId">Instance id.</param>
    /// <param name="listId">List id.</param>
    /// <returns>True when the tag is valid.</returns>
    public static bool TryParseTag(string? tag, out string instanceId, out long listId)
    {
        instanceId = string.Empty;
        listId = 0;
        var i = tag?.LastIndexOf(':') ?? -1;
        if (tag is null || i <= 0 || !long.TryParse(tag.AsSpan(i + 1), NumberStyles.None, CultureInfo.InvariantCulture, out listId) || listId <= 0)
        {
            return false;
        }

        instanceId = tag[..i];
        return true;
    }

    /// <summary>Removes repeated items, keeping each at its first place.</summary>
    /// <param name="ids">Items in order.</param>
    /// <returns>Items without repeats.</returns>
    public static List<Guid> Distinct(IEnumerable<Guid> ids)
    {
        var seen = new HashSet<Guid>();
        return ids.Where(id => id != Guid.Empty && seen.Add(id)).ToList();
    }

    /// <summary>
    /// Plans the smallest change: nothing, removals and/or additions at the end when the remaining
    /// items are already in the right order, or a full rewrite when the order changed.
    /// </summary>
    /// <param name="current">What the container holds, in order.</param>
    /// <param name="desired">What it should hold, in order, without repeats.</param>
    /// <returns>The plan.</returns>
    public static ContainerPlan Plan(IReadOnlyList<Guid> current, IReadOnlyList<Guid> desired)
    {
        if (current.SequenceEqual(desired))
        {
            return new ContainerPlan([], [], false);
        }

        var wanted = desired.ToHashSet();
        var kept = current.Where(wanted.Contains).ToList();
        if (kept.SequenceEqual(desired.Take(kept.Count)))
        {
            var remove = current.Where(id => !wanted.Contains(id)).Distinct().ToList();
            return new ContainerPlan(remove, desired.Skip(kept.Count).ToList(), false);
        }

        return new ContainerPlan(current.Distinct().ToList(), desired, true);
    }

    /// <summary>Puts episodes in watch order: by season, episode, then name; specials (season 0) are left out.</summary>
    /// <param name="episodes">Episodes of a show or season.</param>
    /// <param name="season">Only this season, or null for the whole show.</param>
    /// <returns>Episode ids in order.</returns>
    public static IEnumerable<Guid> EpisodeOrder(IEnumerable<EpisodeRef> episodes, int? season)
        => episodes
            .Where(e => season is null ? e.Season is not 0 : e.Season == season)
            .OrderBy(e => e.Season ?? int.MaxValue)
            .ThenBy(e => e.Episode ?? int.MaxValue)
            .ThenBy(e => e.SortName, StringComparer.OrdinalIgnoreCase)
            .Select(e => e.Id);

    /// <summary>Finds a numbered episode, including one inside a multi-episode file.</summary>
    /// <param name="episodes">Episodes of the show.</param>
    /// <param name="season">Season number.</param>
    /// <param name="episode">Episode number.</param>
    /// <returns>The episode, or null.</returns>
    public static Guid? FindEpisode(IEnumerable<EpisodeRef> episodes, int season, int episode)
    {
        var list = episodes.Where(e => e.Season == season).ToList();
        return list.FirstOrDefault(e => e.Episode == episode)?.Id
            ?? list.FirstOrDefault(e => e.Episode < episode && e.EpisodeEnd >= episode)?.Id;
    }

    /// <summary>
    /// Decides which existing containers stay (one per list and kind) and which are deleted. Only
    /// containers of this JellyWatcher are considered; those of another instance are left alone.
    /// </summary>
    /// <param name="owned">Containers made by this plugin.</param>
    /// <param name="instanceId">This JellyWatcher's instance id.</param>
    /// <param name="wanted">Lists that should be shown, with their mode and (for playlists) owner.</param>
    /// <returns>The container to keep per list, and those to delete.</returns>
    public static (Dictionary<long, OwnedContainer> Keep, List<OwnedContainer> Delete) Reconcile(
        IEnumerable<OwnedContainer> owned,
        string instanceId,
        IReadOnlyDictionary<long, (MirrorMode Mode, Guid Owner)> wanted)
    {
        var keep = new Dictionary<long, OwnedContainer>();
        var delete = new List<OwnedContainer>();
        foreach (var c in owned)
        {
            if (!TryParseTag(c.Tag, out var instance, out var listId) || !string.Equals(instance, instanceId, StringComparison.Ordinal))
            {
                continue;
            }

            var ok = wanted.TryGetValue(listId, out var w)
                && w.Mode == c.Mode
                && (c.Mode != MirrorMode.Playlist || c.OwnerId == w.Owner)
                && !keep.ContainsKey(listId);
            if (ok)
            {
                keep[listId] = c;
            }
            else
            {
                delete.Add(c);
            }
        }

        return (keep, delete);
    }
}
