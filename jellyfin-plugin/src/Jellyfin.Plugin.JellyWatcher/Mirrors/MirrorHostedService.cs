using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyWatcher.Mirrors;

/// <summary>
/// Runs the collection/playlist sync at the configured interval, soon after library changes (so
/// entries removed by a library scan come back and new episodes join playlists), and on request.
/// </summary>
public sealed class MirrorHostedService : BackgroundService
{
    private static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan LibraryQuiet = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan LibraryMaxWait = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan FollowUpDelay = TimeSpan.FromSeconds(60);

    private readonly MirrorService _mirrors;
    private readonly ILibraryManager _library;
    private readonly ILogger<MirrorHostedService> _logger;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly object _lock = new();
    private DateTime? _libraryChangedFirst;
    private DateTime _libraryChangedLast;
    private bool _requested;

    public MirrorHostedService(MirrorService mirrors, ILibraryManager library, ILogger<MirrorHostedService> logger)
    {
        _mirrors = mirrors;
        _library = library;
        _logger = logger;
    }

    /// <summary>Asks for a run as soon as possible (several requests make one run).</summary>
    public void RequestRun()
    {
        lock (_lock)
        {
            _requested = true;
        }

        Wake();
    }

    /// <inheritdoc />
    public override Task StartAsync(CancellationToken cancellationToken)
    {
        _library.ItemAdded += OnLibraryChanged;
        _library.ItemRemoved += OnLibraryChanged;
        return base.StartAsync(cancellationToken);
    }

    /// <inheritdoc />
    public override Task StopAsync(CancellationToken cancellationToken)
    {
        _library.ItemAdded -= OnLibraryChanged;
        _library.ItemRemoved -= OnLibraryChanged;
        return base.StopAsync(cancellationToken);
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken).ConfigureAwait(false);
            var next = DateTime.UtcNow;
            while (!stoppingToken.IsCancellationRequested)
            {
                var now = DateTime.UtcNow;
                bool due;
                lock (_lock)
                {
                    var library = _libraryChangedFirst is { } first && (now - _libraryChangedLast >= LibraryQuiet || now - first >= LibraryMaxWait);
                    due = _requested || library || now >= next;
                    if (due)
                    {
                        _requested = false;
                        _libraryChangedFirst = null;
                    }
                }

                if (due)
                {
                    var result = await _mirrors.RunAsync(stoppingToken).ConfigureAwait(false);
                    next = DateTime.UtcNow + (result.FollowUp ? FollowUpDelay : Interval());
                }

                // Wake up for requests, or check again shortly (library changes, the next interval).
                await _wake.WaitAsync(TimeSpan.FromSeconds(15), stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Jellyfin is shutting down.
        }
    }

    private static TimeSpan Interval()
        => TimeSpan.FromMinutes(Math.Clamp(Plugin.Instance?.Configuration.MirrorIntervalMinutes ?? 5, 1, 1440));

    private void OnLibraryChanged(object? sender, ItemChangeEventArgs e)
    {
        if (e.Item is not (Movie or Series or Season or Episode) || e.Item.IsVirtualItem)
        {
            return;
        }

        lock (_lock)
        {
            var now = DateTime.UtcNow;
            _libraryChangedFirst ??= now;
            _libraryChangedLast = now;
        }

        _logger.LogTrace("JellyWatcher: library changed ({Name}); collections are updated shortly", e.Item.Name);
    }

    private void Wake()
    {
        try
        {
            _wake.Release();
        }
        catch (SemaphoreFullException)
        {
            // Already awake.
        }
    }

    /// <inheritdoc />
    public override void Dispose()
    {
        _wake.Dispose();
        base.Dispose();
    }
}
