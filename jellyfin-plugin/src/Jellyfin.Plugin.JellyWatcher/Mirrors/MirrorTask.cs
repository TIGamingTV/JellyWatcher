using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.JellyWatcher.Mirrors;

/// <summary>
/// Dashboard › Scheduled Tasks entry to update the collections and playlists now. The plugin also
/// runs this on its own at the interval set on the plugin page and after library changes.
/// </summary>
public class MirrorTask : IScheduledTask, IConfigurableScheduledTask
{
    private readonly MirrorService _mirrors;

    public MirrorTask(MirrorService mirrors)
    {
        _mirrors = mirrors;
    }

    /// <inheritdoc />
    public string Name => "JellyWatcher: Sync collections and playlists";

    /// <inheritdoc />
    public string Key => "JellyWatcherMirrors";

    /// <inheritdoc />
    public string Description => "Updates the collections and playlists of JellyWatcher lists. This also runs on its own every few minutes and after library changes.";

    /// <inheritdoc />
    public string Category => "JellyWatcher";

    /// <inheritdoc />
    public bool IsHidden => false;

    /// <inheritdoc />
    public bool IsEnabled => true;

    /// <inheritdoc />
    public bool IsLogged => true;

    /// <inheritdoc />
    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var result = await _mirrors.RunAsync(cancellationToken).ConfigureAwait(false);
        progress.Report(100);
        if (!result.Ok)
        {
            throw new InvalidOperationException(result.Message);
        }
    }

    /// <inheritdoc />
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => [];
}
