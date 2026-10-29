using Jellyfin.Plugin.JellyWatcher.Mirrors;
using Jellyfin.Plugin.JellyWatcher.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyWatcher;

/// <summary>Registers the plugin's services with Jellyfin.</summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHttpClient(JellyWatcherProxy.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(60))
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5) });
        serviceCollection.AddSingleton<JellyWatcherProxy>();
        serviceCollection.AddSingleton<MirrorService>();
        serviceCollection.AddSingleton<MirrorHostedService>();
        serviceCollection.AddHostedService(sp => sp.GetRequiredService<MirrorHostedService>());
    }
}
