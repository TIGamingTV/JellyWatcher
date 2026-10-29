using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyWatcher.Configuration;
using Jellyfin.Plugin.JellyWatcher.Services;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Playlists;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyWatcher.Mirrors;

/// <summary>Result of one sync run.</summary>
/// <param name="At">When it finished.</param>
/// <param name="Ok">Whether JellyWatcher answered and the run completed.</param>
/// <param name="Message">Summary for the settings page.</param>
/// <param name="FollowUp">Something was created; check again soon in case a library scan running at the same time overwrote it.</param>
public sealed record MirrorRunInfo(DateTime At, bool Ok, string Message, bool FollowUp = false);

/// <summary>
/// Keeps the collections and playlists of JellyWatcher lists in Jellyfin up to date. JellyWatcher
/// says what each should hold; this makes Jellyfin match, deleting only what it made itself.
/// </summary>
public sealed class MirrorService
{
    /// <summary>BoxSet display order that keeps the order items were added in.</summary>
    public const string KeepOrder = "Default";

    private readonly ILibraryManager _library;
    private readonly ICollectionManager _collections;
    private readonly IPlaylistManager _playlists;
    private readonly IUserManager _users;
    private readonly IFileSystem _fileSystem;
    private readonly IApplicationPaths _paths;
    private readonly JellyWatcherProxy _proxy;
    private readonly ILogger<MirrorService> _logger;
    private readonly MirrorStateStore _state;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public MirrorService(
        ILibraryManager library,
        ICollectionManager collections,
        IPlaylistManager playlists,
        IUserManager users,
        IFileSystem fileSystem,
        IApplicationPaths paths,
        JellyWatcherProxy proxy,
        ILogger<MirrorService> logger)
    {
        _library = library;
        _collections = collections;
        _playlists = playlists;
        _users = users;
        _fileSystem = fileSystem;
        _paths = paths;
        _proxy = proxy;
        _logger = logger;
        _state = new MirrorStateStore(Path.Combine(paths.PluginConfigurationsPath, "JellyWatcher.mirrors.json"), logger);
    }

    /// <summary>Gets the result of the last run.</summary>
    public MirrorRunInfo? LastRun { get; private set; }

    /// <summary>Gets a value indicating whether a run is in progress.</summary>
    public bool Running => _gate.CurrentCount == 0;

    private static PluginConfiguration Config => Plugin.Instance?.Configuration ?? new PluginConfiguration();

    /// <summary>Brings Jellyfin in line with JellyWatcher (waits for a run already in progress).</summary>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <returns>What happened.</returns>
    public async Task<MirrorRunInfo> RunAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            LastRun = await RunCoreAsync(cancellationToken).ConfigureAwait(false);
            return LastRun;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "JellyWatcher: updating collections and playlists failed");
            LastRun = new MirrorRunInfo(DateTime.UtcNow, false, "Updating collections and playlists failed: " + ex.Message);
            return LastRun;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Turns the feature off and deletes every collection and playlist this plugin made, for any JellyWatcher.</summary>
    /// <param name="cancellationToken">Cancellation.</param>
    /// <returns>How many were deleted.</returns>
    public async Task<int> RemoveAllAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // Otherwise the next run would create them again.
            if (Plugin.Instance is { } plugin)
            {
                plugin.Configuration.MirrorEnabled = false;
                plugin.SaveConfiguration();
            }

            var owned = Owned(_state.Load());
            foreach (var c in owned)
            {
                Delete(c);
            }

            _state.Save(new Dictionary<Guid, string>());
            LastRun = new MirrorRunInfo(DateTime.UtcNow, true, $"Removed {owned.Count} collection(s) and playlist(s).");
            return owned.Count;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<MirrorRunInfo> RunCoreAsync(CancellationToken ct)
    {
        var config = Config;
        if (!JellyWatcherApi.IsConfigured(config))
        {
            return new MirrorRunInfo(DateTime.UtcNow, true, "The plugin is not set up yet.");
        }

        var response = await _proxy.SendAsync(config, HttpMethod.Get, "plugin/mirrors", null, null, ct).ConfigureAwait(false);
        MirrorPayload? payload = null;
        if (response.Status == 200)
        {
            try
            {
                payload = JsonSerializer.Deserialize<MirrorPayload>(response.Body, MirrorPayload.Json);
            }
            catch (JsonException ex)
            {
                _logger.LogWarning("JellyWatcher: unreadable collection list: {Message}", ex.Message);
            }
        }

        // Without a complete answer nothing is changed, and above all nothing is deleted.
        if (payload is null || string.IsNullOrWhiteSpace(payload.InstanceId))
        {
            _logger.LogWarning("JellyWatcher: could not get the lists to show in Jellyfin (status {Status}); nothing was changed", response.Status);
            return new MirrorRunInfo(DateTime.UtcNow, false, $"JellyWatcher did not send the lists (status {response.Status}). Nothing was changed.");
        }

        var reports = new List<MirrorReport>();
        if (!config.MirrorEnabled)
        {
            // Nothing is touched in Jellyfin; people see why their lists do not show up.
            reports.AddRange(payload.Lists.Select(l => new MirrorReport(l.ListId, ModeName(l.Mode), null, 0, 0, "An administrator turned off collections and playlists in the JellyWatcher plugin for Jellyfin.")));
            await ReportAsync(config, reports, ct).ConfigureAwait(false);
            return new MirrorRunInfo(DateTime.UtcNow, true, "Collections and playlists are turned off.");
        }

        var wanted = new Dictionary<long, (MirrorMode Mode, Guid Owner)>();
        var lists = new List<MirrorList>();
        foreach (var list in payload.Lists)
        {
            var error = Check(list, config, out var owner);
            if (error is not null)
            {
                reports.Add(new MirrorReport(list.ListId, ModeName(list.Mode), null, 0, 0, error));
                continue;
            }

            if (wanted.TryAdd(list.ListId, (list.Mode, owner)))
            {
                lists.Add(list);
            }
        }

        var state = _state.Load();
        var (keep, delete) = MirrorPlanner.Reconcile(Owned(state), payload.InstanceId, wanted);
        foreach (var c in delete)
        {
            try
            {
                Delete(c);
                state.Remove(c.ItemId);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                _logger.LogError(ex, "JellyWatcher: could not delete the {Mode} {ItemId}", c.Mode, c.ItemId);
            }
        }

        var resolver = new MirrorResolver(_library);
        var changed = 0;
        var created = 0;
        foreach (var list in lists)
        {
            ct.ThrowIfCancellationRequested();
            var tag = MirrorPlanner.Tag(payload.InstanceId, list.ListId);
            var desired = new List<Guid>();
            var missing = 0;
            foreach (var entry in list.Entries)
            {
                var ids = resolver.Resolve(entry, list.Mode).ToList();
                if (ids.Count == 0)
                {
                    missing++;
                }

                desired.AddRange(ids);
            }

            desired = MirrorPlanner.Distinct(desired);
            keep.TryGetValue(list.ListId, out var existing);
            try
            {
                var (id, didChange, isNew) = list.Mode == MirrorMode.Collection
                    ? await ApplyCollectionAsync(list, tag, existing, desired, ct).ConfigureAwait(false)
                    : await ApplyPlaylistAsync(list, tag, wanted[list.ListId].Owner, existing, desired, ct).ConfigureAwait(false);
                state[id] = tag;
                changed += didChange ? 1 : 0;
                created += isNew ? 1 : 0;
                reports.Add(new MirrorReport(list.ListId, ModeName(list.Mode), id.ToString("N"), desired.Count, missing, null));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "JellyWatcher: could not update the {Mode} for list {ListId}", list.Mode, list.ListId);
                if (existing is not null)
                {
                    state[existing.ItemId] = tag;
                }

                reports.Add(new MirrorReport(list.ListId, ModeName(list.Mode), existing?.ItemId.ToString("N"), 0, missing, "Jellyfin could not update it: " + ex.Message));
            }
        }

        _state.Save(state);
        await ReportAsync(config, reports, ct).ConfigureAwait(false);
        if (changed > 0 || delete.Count > 0)
        {
            _logger.LogInformation("JellyWatcher: updated {Changed} and removed {Removed} collection(s)/playlist(s)", changed, delete.Count);
        }

        return new MirrorRunInfo(DateTime.UtcNow, true, $"{lists.Count} list(s) in Jellyfin; {changed} updated, {delete.Count} removed.", created > 0);
    }

    /// <summary>Checks the owner and permissions of a list; returns a message for people when it cannot be shown.</summary>
    private string? Check(MirrorList list, PluginConfiguration config, out Guid owner)
    {
        if (!Guid.TryParse(list.Owner, out owner) || _users.GetUserById(owner) is not { } user)
        {
            return "The Jellyfin account of this list's owner was not found.";
        }

        if (list.Mode != MirrorMode.Collection)
        {
            return null;
        }

        return config.CollectionPermission switch
        {
            CollectionPermission.Everyone => null,
            CollectionPermission.CollectionManagers when user.HasPermission(PermissionKind.IsAdministrator) || user.HasPermission(PermissionKind.EnableCollectionManagement) => null,
            CollectionPermission.CollectionManagers => "Your Jellyfin account may not manage collections. Choose Private Playlist, or ask an administrator to allow collection management for your account.",
            _ => "Collections are turned off in the JellyWatcher plugin for Jellyfin. Choose Private Playlist instead.",
        };
    }

    private List<OwnedContainer> Owned(Dictionary<Guid, string> state)
    {
        var items = _library.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.BoxSet, BaseItemKind.Playlist],
            Recursive = true,
        });
        var owned = new List<OwnedContainer>();
        var seen = new HashSet<Guid>();
        foreach (var item in items)
        {
            var tag = item.GetProviderId(MirrorPlanner.ProviderKey);
            if (string.IsNullOrEmpty(tag) && !state.TryGetValue(item.Id, out tag))
            {
                continue;
            }

            if (!seen.Add(item.Id))
            {
                continue;
            }

            owned.Add(item switch
            {
                Playlist p => new OwnedContainer(p.Id, MirrorMode.Playlist, tag, p.OwnerUserId),
                _ => new OwnedContainer(item.Id, MirrorMode.Collection, tag, Guid.Empty),
            });
        }

        // Saved entries whose item is gone are forgotten.
        foreach (var id in state.Keys.Where(id => !seen.Contains(id)).ToList())
        {
            state.Remove(id);
        }

        // Prefer the containers the state file knows, so a copy made by a restored backup is the one deleted.
        return owned.OrderByDescending(c => state.ContainsKey(c.ItemId)).ToList();
    }

    private async Task<(Guid Id, bool Changed, bool Created)> ApplyCollectionAsync(MirrorList list, string tag, OwnedContainer? existing, List<Guid> desired, CancellationToken ct)
    {
        var changed = false;
        var box = existing is null ? null : _library.GetItemById(existing.ItemId) as BoxSet;
        var created = box is null;
        if (box is null)
        {
            box = await _collections.CreateCollectionAsync(new CollectionCreationOptions
            {
                Name = await FreeCollectionNameAsync(list.Name).ConfigureAwait(false),
                IsLocked = true,
                ProviderIds = new Dictionary<string, string> { [MirrorPlanner.ProviderKey] = tag },
                ItemIdList = desired.Select(id => id.ToString("N")).ToList(),
            }).ConfigureAwait(false);
            changed = true;
            _logger.LogInformation("JellyWatcher: created the collection {Name} for list {ListId}", list.Name, list.ListId);
        }

        var meta = false;
        if (!string.Equals(box.DisplayOrder, KeepOrder, StringComparison.Ordinal))
        {
            box.DisplayOrder = KeepOrder;
            meta = true;
        }

        meta |= SetCommon(box, list, tag);
        if (meta)
        {
            await box.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, ct).ConfigureAwait(false);
            changed = true;
        }

        var plan = MirrorPlanner.Plan(box.GetLinkedChildren().Select(i => i.Id).ToList(), desired);
        if (plan.Remove.Count > 0)
        {
            await _collections.RemoveFromCollectionAsync(box.Id, plan.Remove).ConfigureAwait(false);
        }

        if (plan.Add.Count > 0)
        {
            await _collections.AddToCollectionAsync(box.Id, plan.Add).ConfigureAwait(false);
        }

        return (box.Id, changed || !plan.Unchanged, created);
    }

    private async Task<(Guid Id, bool Changed, bool Created)> ApplyPlaylistAsync(MirrorList list, string tag, Guid owner, OwnedContainer? existing, List<Guid> desired, CancellationToken ct)
    {
        var playlist = existing is null ? null : _library.GetItemById(existing.ItemId) as Playlist;
        if (playlist is null)
        {
            var created = await _playlists.CreatePlaylist(new PlaylistCreationRequest
            {
                Name = list.Name,
                ItemIdList = desired,
                MediaType = MediaType.Video,
                UserId = owner,
                Public = false,
            }).ConfigureAwait(false);
            playlist = _library.GetItemById(Guid.Parse(created.Id)) as Playlist
                ?? throw new InvalidOperationException("The new playlist was not found.");
            SetCommon(playlist, list, tag);
            await playlist.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, ct).ConfigureAwait(false);
            _logger.LogInformation("JellyWatcher: created the playlist {Name} for list {ListId}", list.Name, list.ListId);
            return (playlist.Id, true, true);
        }

        var changed = false;
        if (!string.Equals(playlist.Name, list.Name, StringComparison.Ordinal))
        {
            await _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlist.Id, UserId = owner, Name = list.Name }).ConfigureAwait(false);
            changed = true;
        }

        if (SetCommon(playlist, list, tag))
        {
            await playlist.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, ct).ConfigureAwait(false);
            changed = true;
        }

        var current = playlist.LinkedChildren
            .Where(c => c.ItemId is { } id && _library.GetItemById(id) is not null)
            .Select(c => c.ItemId!.Value)
            .ToList();
        var plan = MirrorPlanner.Plan(current, desired);
        if (plan.Unchanged)
        {
            return (playlist.Id, changed, false);
        }

        if (!plan.Rewrite && plan.Remove.Count == 0)
        {
            await _playlists.AddItemToPlaylistAsync(playlist.Id, plan.Add.ToList(), null, owner).ConfigureAwait(false);
        }
        else
        {
            await _playlists.UpdatePlaylist(new PlaylistUpdateRequest { Id = playlist.Id, UserId = owner, Ids = desired }).ConfigureAwait(false);
        }

        return (playlist.Id, true, false);
    }

    /// <summary>Sets the name (collections), description and tag; returns whether anything changed.</summary>
    private static bool SetCommon(BaseItem item, MirrorList list, string tag)
    {
        var changed = false;
        if (item is BoxSet && !string.Equals(item.Name, list.Name, StringComparison.Ordinal))
        {
            item.Name = list.Name;
            changed = true;
        }

        var overview = string.IsNullOrWhiteSpace(list.Description) ? null : list.Description;
        if (!string.Equals(item.Overview, overview, StringComparison.Ordinal))
        {
            item.Overview = overview;
            changed = true;
        }

        if (!string.Equals(item.GetProviderId(MirrorPlanner.ProviderKey), tag, StringComparison.Ordinal))
        {
            item.SetProviderId(MirrorPlanner.ProviderKey, tag);
            changed = true;
        }

        return changed;
    }

    /// <summary>
    /// Jellyfin stores a collection in a folder named after it, so two collections with the same name
    /// would share one. A taken name gets a number for the folder; the collection is renamed after.
    /// </summary>
    private async Task<string> FreeCollectionNameAsync(string name)
    {
        var folder = await _collections.GetCollectionsFolder(false).ConfigureAwait(false);
        if (folder?.Path is not { } root)
        {
            return name;
        }

        for (var n = 1; n < 1000; n++)
        {
            var candidate = n == 1 ? name : $"{name} ({n})";
            if (!Directory.Exists(Path.Combine(root, _fileSystem.GetValidFilename(candidate) + " [boxset]")))
            {
                return candidate;
            }
        }

        return $"{name} ({Guid.NewGuid():N})";
    }

    private void Delete(OwnedContainer c)
    {
        var item = _library.GetItemById(c.ItemId);
        if (item is not (BoxSet or Playlist))
        {
            return;
        }

        // The plugin's collections and playlists live in folders of their own in Jellyfin's data
        // folder; that folder goes too, or a library scan would bring the item back. Anything stored
        // elsewhere (such as a collection folder inside a media library) is never touched.
        if (string.IsNullOrEmpty(item.Path) || !IsBelow(item.Path, _paths.DataPath))
        {
            _logger.LogWarning("JellyWatcher: not deleting {Name}: it is not stored in Jellyfin's data folder ({Path})", item.Name, item.Path);
            return;
        }

        _library.DeleteItem(item, new DeleteOptions { DeleteFileLocation = true }, true);
        _logger.LogInformation("JellyWatcher: deleted the {Mode} {Name}", c.Mode, item.Name);
    }

    private static bool IsBelow(string path, string root)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var full = Path.GetFullPath(path);
        var parent = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return full.StartsWith(parent, comparison) && full.Length > parent.Length;
    }

    private async Task ReportAsync(PluginConfiguration config, List<MirrorReport> reports, CancellationToken ct)
    {
        if (reports.Count == 0)
        {
            return;
        }

        var body = JsonSerializer.Serialize(new { results = reports }, MirrorPayload.Json);
        var result = await _proxy.SendAsync(config, HttpMethod.Post, "plugin/mirrors/report", null, body, ct).ConfigureAwait(false);
        if (result.Status != 200)
        {
            _logger.LogWarning("JellyWatcher: could not report the collection status (status {Status})", result.Status);
        }
    }

    private static string ModeName(MirrorMode mode) => mode == MirrorMode.Playlist ? "playlist" : "collection";
}
