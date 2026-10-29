using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyWatcher.Mirrors;

/// <summary>
/// Finds the Jellyfin items for list entries: by the item id JellyWatcher saw, then by provider ids
/// (so titles added since JellyWatcher's last library sync are found too). One instance per sync run.
/// </summary>
public sealed class MirrorResolver
{
    private readonly ILibraryManager _library;
    private readonly Dictionary<string, BaseItem?> _titles = new(StringComparer.Ordinal);
    private readonly Dictionary<Guid, List<EpisodeRef>> _episodes = [];
    private readonly Dictionary<Guid, List<Season>> _seasons = [];

    public MirrorResolver(ILibraryManager library)
    {
        _library = library;
    }

    /// <summary>The items an entry stands for, in watch order.</summary>
    /// <param name="entry">The entry.</param>
    /// <param name="mode">Collections hold shows and seasons as one item; playlists hold their episodes.</param>
    /// <returns>Item ids (empty when the entry is not in the library).</returns>
    public IEnumerable<Guid> Resolve(MirrorEntry entry, MirrorMode mode)
    {
        switch (entry.Kind)
        {
            case "movie":
                return Title(entry, BaseItemKind.Movie) is { } movie ? [movie.Id] : [];

            case "show":
                if (Title(entry, BaseItemKind.Series) is not { } show)
                {
                    return [];
                }

                return mode == MirrorMode.Collection ? [show.Id] : MirrorPlanner.EpisodeOrder(Episodes(show.Id), null).ToList();

            case "season" when entry.Season is { } s:
                if (Title(entry, BaseItemKind.Series) is not { } series)
                {
                    return [];
                }

                if (mode == MirrorMode.Collection)
                {
                    return Seasons(series.Id).FirstOrDefault(x => x.IndexNumber == s) is { } season ? [season.Id] : [];
                }

                return MirrorPlanner.EpisodeOrder(Episodes(series.Id), s).ToList();

            case "episode" when entry.Season is { } s && entry.Episode is { } e:
                if (ParseId(entry.JellyfinItemId) is { } id && _library.GetItemById(id) is Episode { IsVirtualItem: false } known)
                {
                    return [known.Id];
                }

                return Title(entry, BaseItemKind.Series) is { } parent && MirrorPlanner.FindEpisode(Episodes(parent.Id), s, e) is { } found ? [found] : [];

            default:
                return [];
        }
    }

    private BaseItem? Title(MirrorEntry entry, BaseItemKind kind)
    {
        // Movie and show entries carry the title's own item; season/episode entries may carry an episode.
        var candidates = new List<string?>();
        if (entry.Kind is "movie" or "show")
        {
            candidates.Add(entry.JellyfinItemId);
        }

        candidates.AddRange(entry.JellyfinIds);
        foreach (var candidate in candidates)
        {
            if (ParseId(candidate) is { } id && _library.GetItemById(id) is { IsVirtualItem: false } item && Is(item, kind))
            {
                return item;
            }
        }

        foreach (var (provider, value) in new[] { (MetadataProvider.Tmdb, entry.TmdbId), (MetadataProvider.Tvdb, entry.TvdbId), (MetadataProvider.Imdb, entry.ImdbId) })
        {
            if (string.IsNullOrWhiteSpace(value) || (provider == MetadataProvider.Tvdb && kind == BaseItemKind.Movie))
            {
                continue;
            }

            var key = $"{kind}:{provider}:{value}";
            if (!_titles.TryGetValue(key, out var found))
            {
                found = _library.GetItemList(new InternalItemsQuery
                {
                    IncludeItemTypes = [kind],
                    HasAnyProviderId = new Dictionary<string, string> { [provider.ToString()] = value },
                    Recursive = true,
                    IsVirtualItem = false,
                }).FirstOrDefault();
                _titles[key] = found;
            }

            if (found is not null)
            {
                return found;
            }
        }

        return null;
    }

    private List<EpisodeRef> Episodes(Guid seriesId)
    {
        if (!_episodes.TryGetValue(seriesId, out var list))
        {
            list = _library.GetItemList(new InternalItemsQuery
            {
                AncestorIds = [seriesId],
                IncludeItemTypes = [BaseItemKind.Episode],
                Recursive = true,
                IsVirtualItem = false,
            })
            .OfType<Episode>()
            .Select(e => new EpisodeRef(e.Id, e.ParentIndexNumber, e.IndexNumber, e.IndexNumberEnd, e.SortName ?? e.Name ?? string.Empty))
            .ToList();
            _episodes[seriesId] = list;
        }

        return list;
    }

    private List<Season> Seasons(Guid seriesId)
    {
        if (!_seasons.TryGetValue(seriesId, out var list))
        {
            list = _library.GetItemList(new InternalItemsQuery
            {
                AncestorIds = [seriesId],
                IncludeItemTypes = [BaseItemKind.Season],
                Recursive = true,
                IsVirtualItem = false,
            }).OfType<Season>().ToList();
            _seasons[seriesId] = list;
        }

        return list;
    }

    private static bool Is(BaseItem item, BaseItemKind kind)
        => kind == BaseItemKind.Movie ? item is Movie : item is Series;

    private static Guid? ParseId(string? value)
        => Guid.TryParse(value, out var id) && id != Guid.Empty ? id : null;
}
