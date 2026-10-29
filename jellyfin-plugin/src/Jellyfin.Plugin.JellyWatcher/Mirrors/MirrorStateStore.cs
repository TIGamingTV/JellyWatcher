using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyWatcher.Mirrors;

/// <summary>One collection or playlist this plugin made.</summary>
/// <param name="ItemId">Jellyfin item id.</param>
/// <param name="Tag">"instanceId:listId".</param>
public sealed record MirrorStateEntry(Guid ItemId, string Tag);

/// <summary>
/// Remembers which collections and playlists the plugin made. Each one also carries the tag as a
/// provider id; this file is the backup in case a metadata refresh drops it.
/// </summary>
public sealed class MirrorStateStore
{
    private readonly string _path;
    private readonly ILogger _logger;

    public MirrorStateStore(string path, ILogger logger)
    {
        _path = path;
        _logger = logger;
    }

    /// <summary>Reads the saved entries (empty when there are none or the file is damaged).</summary>
    /// <returns>Entries by item id.</returns>
    public Dictionary<Guid, string> Load()
    {
        try
        {
            if (!File.Exists(_path))
            {
                return [];
            }

            var entries = JsonSerializer.Deserialize<List<MirrorStateEntry>>(File.ReadAllText(_path)) ?? [];
            return entries.Where(e => e.ItemId != Guid.Empty && !string.IsNullOrEmpty(e.Tag)).GroupBy(e => e.ItemId).ToDictionary(g => g.Key, g => g.First().Tag);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning("JellyWatcher: could not read {Path}: {Message}", _path, ex.Message);
            return [];
        }
    }

    /// <summary>Saves the entries.</summary>
    /// <param name="entries">Entries by item id.</param>
    public void Save(IReadOnlyDictionary<Guid, string> entries)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var tmp = _path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(entries.Select(e => new MirrorStateEntry(e.Key, e.Value)).ToList()));
            File.Move(tmp, _path, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("JellyWatcher: could not save {Path}: {Message}", _path, ex.Message);
        }
    }
}
