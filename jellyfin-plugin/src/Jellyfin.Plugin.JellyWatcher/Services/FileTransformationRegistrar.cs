using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyWatcher.Services;

/// <summary>
/// Registers the jellyfin-web patches with the File Transformation plugin once Jellyfin has
/// started. File Transformation lives in its own load context, so it is reached through
/// reflection, as its documentation describes.
/// </summary>
public class FileTransformationRegistrar : IScheduledTask, IConfigurableScheduledTask
{
    private static readonly (Guid Id, string File, string Method)[] Patches =
    [
        (Guid.Parse("5d8b0a52-6f7e-4f4e-9f53-2b0f0d5d6a11"), "index.html", nameof(WebPatches.IndexHtml)),
        (Guid.Parse("5d8b0a52-6f7e-4f4e-9f53-2b0f0d5d6a12"), "config.json", nameof(WebPatches.ConfigJson)),
    ];

    private readonly ILogger<FileTransformationRegistrar> _logger;

    public FileTransformationRegistrar(ILogger<FileTransformationRegistrar> logger)
    {
        _logger = logger;
    }

    /// <summary>Gets a value indicating whether the patches are registered.</summary>
    public static bool Registered { get; private set; }

    /// <inheritdoc />
    public string Name => "JellyWatcher: add the Watchlists page";

    /// <inheritdoc />
    public string Key => "JellyWatcherFileTransformation";

    /// <inheritdoc />
    public string Description => "Registers the Watchlists page with the File Transformation plugin.";

    /// <inheritdoc />
    public string Category => "JellyWatcher";

    /// <inheritdoc />
    public bool IsHidden => true;

    /// <inheritdoc />
    public bool IsEnabled => true;

    /// <inheritdoc />
    public bool IsLogged => false;

    /// <summary>Finds File Transformation's entry point, if that plugin is installed.</summary>
    /// <returns>The PluginInterface type, or null.</returns>
    public static Type? FileTransformationInterface()
    {
        var assembly = AssemblyLoadContext.All
            .SelectMany(c => c.Assemblies)
            .FirstOrDefault(a => a.GetName().Name == "Jellyfin.Plugin.FileTransformation");
        return assembly?.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
    }

    /// <inheritdoc />
    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        Register();
        progress.Report(100);
        return Task.CompletedTask;
    }

    /// <summary>Registers the patches; safe to call more than once.</summary>
    public void Register()
    {
        var api = FileTransformationInterface();
        var register = api?.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
        var payloadType = register?.GetParameters().FirstOrDefault()?.ParameterType;
        // File Transformation takes a Newtonsoft JObject from its own load context; build it with that type's Parse.
        var parse = payloadType?.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)]);
        if (register is null || parse is null)
        {
            _logger.LogWarning("JellyWatcher: the File Transformation plugin is not installed, so the Watchlists page cannot be added to Jellyfin. Install it from its plugin repository and restart Jellyfin.");
            return;
        }

        var assemblyName = typeof(WebPatches).Assembly.FullName;
        foreach (var (id, file, method) in Patches)
        {
            var json = JsonSerializer.Serialize(new Dictionary<string, string?>
            {
                ["id"] = id.ToString(),
                ["fileNamePattern"] = file,
                ["callbackAssembly"] = assemblyName,
                ["callbackClass"] = typeof(WebPatches).FullName,
                ["callbackMethod"] = method,
            });
            register.Invoke(null, [parse.Invoke(null, [json])]);
        }

        Registered = true;
        _logger.LogInformation("JellyWatcher: Watchlists page registered with File Transformation");
    }

    /// <inheritdoc />
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
    }
}
