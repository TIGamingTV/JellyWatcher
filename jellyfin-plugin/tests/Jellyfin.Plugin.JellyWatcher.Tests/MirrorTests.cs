using System.Text.Json;
using Jellyfin.Plugin.JellyWatcher.Mirrors;
using Xunit;

namespace Jellyfin.Plugin.JellyWatcher.Tests;

public class MirrorPlannerTests
{
    private static readonly Guid A = Guid.NewGuid(), B = Guid.NewGuid(), C = Guid.NewGuid(), D = Guid.NewGuid();

    [Fact]
    public void LeavesAMatchingContainerAlone()
    {
        Assert.True(MirrorPlanner.Plan([A, B, C], [A, B, C]).Unchanged);
    }

    [Fact]
    public void AppendsNewItemsWithoutRewriting()
    {
        var plan = MirrorPlanner.Plan([A, B], [A, B, C, D]);
        Assert.False(plan.Rewrite);
        Assert.Empty(plan.Remove);
        Assert.Equal([C, D], plan.Add);
    }

    [Fact]
    public void RemovesItemsWhenTheRestStaysInOrder()
    {
        var plan = MirrorPlanner.Plan([A, B, C], [A, C, D]);
        Assert.False(plan.Rewrite);
        Assert.Equal([B], plan.Remove);
        Assert.Equal([D], plan.Add);
    }

    [Fact]
    public void RewritesWhenTheOrderChanged()
    {
        var plan = MirrorPlanner.Plan([A, B, C], [B, A, C]);
        Assert.True(plan.Rewrite);
        Assert.Equal([A, B, C], plan.Remove);
        Assert.Equal([B, A, C], plan.Add);
    }

    [Fact]
    public void RewritesWhenSomethingIsInsertedInTheMiddle()
    {
        Assert.True(MirrorPlanner.Plan([A, C], [A, B, C]).Rewrite);
    }

    [Fact]
    public void KeepsTheFirstPlaceOfRepeatedItems()
    {
        Assert.Equal([A, B, C], MirrorPlanner.Distinct([A, B, A, Guid.Empty, C, B]));
    }

    [Fact]
    public void OrdersEpisodesBySeasonAndNumberWithoutSpecials()
    {
        var eps = new[]
        {
            new EpisodeRef(C, 2, 1, null, "c"),
            new EpisodeRef(D, 0, 1, null, "special"),
            new EpisodeRef(B, 1, 2, null, "b"),
            new EpisodeRef(A, 1, 1, null, "a"),
        };
        Assert.Equal([A, B, C], MirrorPlanner.EpisodeOrder(eps, null));
        Assert.Equal([A, B], MirrorPlanner.EpisodeOrder(eps, 1));
        Assert.Equal([D], MirrorPlanner.EpisodeOrder(eps, 0));
    }

    [Fact]
    public void FindsEpisodesInsideMultiEpisodeFiles()
    {
        var eps = new[] { new EpisodeRef(A, 1, 1, 2, "a"), new EpisodeRef(B, 1, 3, null, "b") };
        Assert.Equal(A, MirrorPlanner.FindEpisode(eps, 1, 2));
        Assert.Equal(B, MirrorPlanner.FindEpisode(eps, 1, 3));
        Assert.Null(MirrorPlanner.FindEpisode(eps, 2, 1));
    }

    [Theory]
    [InlineData("abc-123:42", "abc-123", 42L)]
    [InlineData("a:b:7", "a:b", 7L)]
    public void ParsesTags(string tag, string instance, long listId)
    {
        Assert.True(MirrorPlanner.TryParseTag(tag, out var i, out var l));
        Assert.Equal(instance, i);
        Assert.Equal(listId, l);
        Assert.Equal(tag, MirrorPlanner.Tag(i, l));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("abc")]
    [InlineData(":5")]
    [InlineData("abc:")]
    [InlineData("abc:0")]
    [InlineData("abc:-3")]
    [InlineData("abc:1x")]
    public void RejectsBadTags(string? tag) => Assert.False(MirrorPlanner.TryParseTag(tag, out _, out _));

    [Fact]
    public void KeepsOneContainerPerListAndDeletesTheRest()
    {
        var owner = Guid.NewGuid();
        var other = Guid.NewGuid();
        var owned = new[]
        {
            new OwnedContainer(A, MirrorMode.Collection, "jw:1", Guid.Empty),
            new OwnedContainer(B, MirrorMode.Collection, "jw:1", Guid.Empty), // second copy
            new OwnedContainer(C, MirrorMode.Collection, "jw:2", Guid.Empty), // list 2 is now a playlist
            new OwnedContainer(D, MirrorMode.Playlist, "jw:3", other), // owner changed
            new OwnedContainer(Guid.NewGuid(), MirrorMode.Playlist, "jw:4", owner), // mirroring turned off
            new OwnedContainer(Guid.NewGuid(), MirrorMode.Collection, "another-jw:1", Guid.Empty), // another JellyWatcher
            new OwnedContainer(Guid.NewGuid(), MirrorMode.Collection, "garbage", Guid.Empty),
        };
        var wanted = new Dictionary<long, (MirrorMode, Guid)>
        {
            [1] = (MirrorMode.Collection, owner),
            [2] = (MirrorMode.Playlist, owner),
            [3] = (MirrorMode.Playlist, owner),
        };

        var (keep, delete) = MirrorPlanner.Reconcile(owned, "jw", wanted);

        Assert.Equal(A, Assert.Single(keep).Value.ItemId);
        Assert.Equal([B, C, D, owned[4].ItemId], delete.Select(c => c.ItemId));
    }

    [Fact]
    public void ReadsJellyWatchersPayload()
    {
        const string json = """
            {"instanceId":"i-1","lists":[{"listId":3,"mode":"playlist","name":"MCU","description":null,"owner":"0123456789abcdef0123456789abcdef",
              "entries":[{"kind":"season","mediaType":"tv","season":2,"episode":null,"jellyfinItemId":null,"jellyfinIds":["a"],"tmdbId":"1","tvdbId":null,"imdbId":"tt1"}]}]}
            """;
        var p = JsonSerializer.Deserialize<MirrorPayload>(json, MirrorPayload.Json)!;
        var list = Assert.Single(p.Lists);
        Assert.Equal(MirrorMode.Playlist, list.Mode);
        Assert.Equal(2, list.Entries[0].Season);
        Assert.Equal("season", list.Entries[0].Kind);

        var report = JsonSerializer.Serialize(new { results = new[] { new MirrorReport(3, "playlist", null, 4, 1, null) } }, MirrorPayload.Json);
        Assert.Contains("\"listId\":3", report, StringComparison.Ordinal);
        Assert.Contains("\"jellyfinId\":null", report, StringComparison.Ordinal);
    }
}
