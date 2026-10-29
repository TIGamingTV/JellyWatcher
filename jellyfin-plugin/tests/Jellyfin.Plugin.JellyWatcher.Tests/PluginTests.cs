using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyWatcher.Configuration;
using Jellyfin.Plugin.JellyWatcher.Services;
using Xunit;

namespace Jellyfin.Plugin.JellyWatcher.Tests;

public class PluginRoutesTests
{
    [Theory]
    [InlineData("GET", "plugin/bootstrap")]
    [InlineData("GET", "lists")]
    [InlineData("GET", "lists/12")]
    [InlineData("GET", "lists/12/timeline")]
    [InlineData("GET", "lists/12/timeline/")]
    [InlineData("POST", "lists/12/sync")]
    [InlineData("PUT", "lists/12/mirror")]
    [InlineData("POST", "lists/link")]
    [InlineData("POST", "lists/local")]
    [InlineData("POST", "lists/trakt")]
    [InlineData("GET", "titles/5/eligibility")]
    [InlineData("POST", "titles/5/request")]
    [InlineData("PUT", "titles/5/skipped")]
    [InlineData("put", "titles/5/watched")]
    public void AllowsTheWatchlistsPageCalls(string method, string path) => Assert.True(PluginRoutes.IsAllowed(method, path));

    [Theory]
    [InlineData("GET", "admin/users")]
    [InlineData("GET", "integrations")]
    [InlineData("POST", "integrations/jellyfin-plugin")]
    [InlineData("GET", "auth/me")]
    [InlineData("DELETE", "lists/12")]
    [InlineData("PATCH", "lists/12")]
    [InlineData("POST", "lists/upload")]
    [InlineData("GET", "lists/12/../../admin/users")]
    [InlineData("GET", "lists/12%2F..%2Fadmin")]
    [InlineData("GET", "plugin/status")]
    [InlineData("GET", "plugin/mirrors")]
    [InlineData("POST", "plugin/mirrors/report")]
    [InlineData("POST", "lists/12/mirror")]
    [InlineData("GET", "")]
    [InlineData("GET", null)]
    public void RefusesEverythingElse(string method, string? path) => Assert.False(PluginRoutes.IsAllowed(method, path));

    [Theory]
    [InlineData("w185", "abc.jpg", true)]
    [InlineData("w342", "A_b-1.webp", true)]
    [InlineData("original", "abc.jpg", false)]
    [InlineData("w185", "../etc/passwd", false)]
    [InlineData("w185", "abc.svg", false)]
    public void ChecksTmdbImages(string size, string file, bool ok) => Assert.Equal(ok, PluginRoutes.IsTmdbImage(size, file));
}

public class WebPatchesTests
{
    private const string Html = "<!DOCTYPE html><html><head></head><body><div id=\"reactRoot\"></div></body></html>";

    [Fact]
    public void InjectsTheScriptOnceBeforeBody()
    {
        var once = WebPatches.InjectScript(Html, "0.5.0.0");
        Assert.Contains("<script data-jellywatcher defer src=\"../JellyWatcher/client.js?v=0.5.0.0\"></script></body>", once, StringComparison.Ordinal);
        Assert.Equal(once, WebPatches.InjectScript(once, "0.5.0.0"));
    }

    [Theory]
    [InlineData("\"use strict\";(self.webpackChunk=self.webpackChunk||[]).push([[1],{1:function(){}}]);")]
    [InlineData("<div>index html fragment</div>")]
    public void LeavesFilesWithoutABodyAlone(string contents) => Assert.Equal(contents, WebPatches.InjectScript(contents, "1"));

    [Fact]
    public void AddsTheMenuLinkOnceAndKeepsOtherLinks()
    {
        var json = "{\"includeCorsCredentials\":false,\"menuLinks\":[{\"name\":\"Requests\",\"url\":\"https://seerr\"}],\"themes\":[]}";
        var config = new PluginConfiguration { MenuLabel = " My Lists ", MenuIcon = "list" };
        var patched = WebPatches.AddMenuLink(json, config);
        var links = JsonNode.Parse(patched)!["menuLinks"]!.AsArray();
        Assert.Equal(2, links.Count);
        Assert.Equal("Requests", links[0]!["name"]!.GetValue<string>());
        Assert.Equal("My Lists", links[1]!["name"]!.GetValue<string>());
        Assert.Equal("list", links[1]!["icon"]!.GetValue<string>());
        Assert.Equal(WebPatches.PageRoute, links[1]!["url"]!.GetValue<string>());
        Assert.NotNull(JsonNode.Parse(patched)!["themes"]);
        Assert.Equal(patched, WebPatches.AddMenuLink(patched, config));
    }

    [Fact]
    public void CreatesMenuLinksWhenMissing()
    {
        var patched = WebPatches.AddMenuLink("{\"multiserver\":false,\"plugins\":[]}", new PluginConfiguration { MenuLabel = "", MenuIcon = "" });
        var link = JsonNode.Parse(patched)!["menuLinks"]![0]!;
        Assert.Equal("Watchlists", link["name"]!.GetValue<string>());
        Assert.Equal("bookmarks", link["icon"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("movie_filter", "movie_filter")]
    [InlineData("x\" onmouseover=\"alert(1)", "bookmarks")]
    [InlineData("List", "bookmarks")]
    public void OnlyUsesPlainIconNames(string icon, string expected)
    {
        var patched = WebPatches.AddMenuLink("{\"plugins\":[]}", new PluginConfiguration { MenuIcon = icon });
        Assert.Equal(expected, JsonNode.Parse(patched)!["menuLinks"]![0]!["icon"]!.GetValue<string>());
    }

    [Fact]
    public void LeavesOtherJsonFilesAlone() => Assert.Equal("{\"name\":\"x\"}", WebPatches.AddMenuLink("{\"name\":\"x\"}", new PluginConfiguration()));

    [Fact]
    public void LeavesBrokenJsonAlone() => Assert.Equal("{nope", WebPatches.AddMenuLink("{nope", new PluginConfiguration()));
}

public class JellyWatcherApiTests
{
    [Theory]
    [InlineData("http://jellywatcher:8484", "http://jellywatcher:8484/")]
    [InlineData(" https://watch.example.com/base/ ", "https://watch.example.com/base/")]
    [InlineData("ftp://x", null)]
    [InlineData("http://x/?a=1", null)]
    [InlineData("http://user:pw@x/", null)]
    [InlineData("jellywatcher:8484", null)]
    [InlineData("", null)]
    public void NormalizesTheAddress(string input, string? expected) => Assert.Equal(expected, JellyWatcherApi.BaseUri(input)?.ToString());

    [Fact]
    public void BuildsRequestsWithKeyAndUser()
    {
        var id = Guid.Parse("a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1");
        using var req = JellyWatcherApi.Build(JellyWatcherApi.BaseUri("http://jw:8484/base")!, " jwp_key ", HttpMethod.Put, "titles/3/skipped", (id, "Zoë"), "0.5.0.0", "srv");
        Assert.Equal("http://jw:8484/base/api/titles/3/skipped", req.RequestUri!.ToString());
        Assert.Equal("jwp_key", req.Headers.GetValues(JellyWatcherApi.KeyHeader).Single());
        Assert.Equal("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", req.Headers.GetValues(JellyWatcherApi.UserHeader).Single());
        Assert.Equal("Zo%C3%AB", req.Headers.GetValues(JellyWatcherApi.NameHeader).Single());
        Assert.Equal("0.5.0.0", req.Headers.GetValues(JellyWatcherApi.VersionHeader).Single());
    }

    [Fact]
    public void LeavesOutUserHeadersWithoutAUser()
    {
        using var req = JellyWatcherApi.Build(JellyWatcherApi.BaseUri("http://jw:8484")!, "k", HttpMethod.Get, "images/tmdb/w185/a.jpg", null, "1", "srv");
        Assert.False(req.Headers.Contains(JellyWatcherApi.UserHeader));
    }

    [Theory]
    [InlineData("http://jw:8484", "http://JW:8484/base/", true)]
    [InlineData("https://watch.example.com", "https://watch.example.com:443", true)]
    [InlineData("http://jw:8484", "https://jw:8484", false)]
    [InlineData("http://jw:8484", "http://jw:8485", false)]
    [InlineData("http://jw:8484", "http://evil:8484", false)]
    [InlineData("http://jw:8484", "", false)]
    public void ComparesServers(string a, string b, bool same) => Assert.Equal(same, JellyWatcherApi.SameServer(a, b));

    [Fact]
    public void KnowsWhenItIsConfigured()
    {
        Assert.False(JellyWatcherApi.IsConfigured(new PluginConfiguration { JellyWatcherUrl = "http://jw:8484" }));
        Assert.True(JellyWatcherApi.IsConfigured(new PluginConfiguration { JellyWatcherUrl = "http://jw:8484", PluginKey = "k" }));
    }
}
