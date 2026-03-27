using CodexSwitch.Tray.Cli;
using CodexSwitch.Tray.Models;

namespace CodexSwitch.Tray.Tests;

public sealed class CodexSwitchCliClientTests
{
    [Fact]
    public async Task ListProfilesAsync_ParsesManagedProfilesFromJson()
    {
        var runner = new FakeCliProcessRunner
        {
            ResultFactory = arguments =>
            {
                Assert.Equal(new[] { "list", "--json" }, arguments);
                return new CliProcessResult(
                    0,
                    """
                    [
                      {
                        "id": "profile-1",
                        "displayName": "team-a",
                        "codexHome": "C:\\profiles\\team-a\\home",
                        "authMode": "chatgpt",
                        "accountId": "acct_1",
                        "planType": "team",
                        "workspaceLabel": "Team A",
                        "workspaceObserved": "Workspace A",
                        "authFingerprint": "abc123",
                        "lastVerifiedAt": null,
                        "lastRateLimitSnapshot": null,
                        "isActive": true
                      }
                    ]
                    """,
                    string.Empty);
            },
        };
        var client = new CodexSwitchCliClient(runner);

        IReadOnlyList<ManagedProfileDto> profiles = await client.ListProfilesAsync();

        ManagedProfileDto profile = Assert.Single(profiles);
        Assert.Equal("team-a", profile.DisplayName);
        Assert.Equal("abc123", profile.AuthFingerprint);
        Assert.True(profile.IsActive);
    }

    [Fact]
    public async Task UseProfileAsync_ForwardsTheRequestedProfileName()
    {
        var runner = new FakeCliProcessRunner
        {
            ResultFactory = arguments =>
            {
                Assert.Equal(new[] { "use", "Workspace One", "--json" }, arguments);
                return new CliProcessResult(
                    0,
                    """
                    {
                      "id": "profile-2",
                      "displayName": "Workspace One",
                      "codexHome": "C:\\profiles\\workspace-one\\home",
                      "authMode": "chatgpt",
                      "accountId": "acct_2",
                      "planType": "pro",
                      "workspaceLabel": null,
                      "workspaceObserved": "Workspace One",
                      "authFingerprint": "fingerprint-2",
                      "lastVerifiedAt": null,
                      "lastRateLimitSnapshot": null,
                      "isActive": true
                    }
                    """,
                    string.Empty);
            },
        };
        var client = new CodexSwitchCliClient(runner);

        ManagedProfileDto profile = await client.UseProfileAsync("Workspace One");

        Assert.Equal("Workspace One", profile.DisplayName);
        Assert.True(profile.IsActive);
    }

    private sealed class FakeCliProcessRunner : ICliProcessRunner
    {
        public required Func<IReadOnlyList<string>, CliProcessResult> ResultFactory { get; init; }

        public Task<CliProcessResult> RunAsync(
            IReadOnlyList<string> arguments,
            CancellationToken cancellationToken = default) =>
            Task.FromResult(ResultFactory(arguments));
    }
}
