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

    [Fact]
    public async Task GetDesktopStatusAsync_RequestsTheDesktopStatusJson()
    {
        var runner = new FakeCliProcessRunner
        {
            ResultFactory = arguments =>
            {
                Assert.Equal(new[] { "desktop", "status", "--json" }, arguments);
                return new CliProcessResult(
                    0,
                    """
                    {
                      "managed": true,
                      "running": true,
                      "desktopPid": 101,
                      "monitorPid": 202,
                      "executablePath": "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
                      "sessionHome": "C:\\Users\\user\\.codex-switch\\desktop\\session\\home",
                      "launchedAt": "2026-03-30T00:00:00.000Z",
                      "launchProfileId": "profile-1",
                      "lastObservedAccountId": "acct-1",
                      "lastObservedProfileId": "profile-1",
                      "lastSyncedAt": "2026-03-30T00:01:00.000Z",
                      "lastError": null
                    }
                    """,
                    string.Empty);
            },
        };
        var client = new CodexSwitchCliClient(runner);

        DesktopStatusDto status = await client.GetDesktopStatusAsync();

        Assert.True(status.Managed);
        Assert.True(status.Running);
        Assert.Equal("acct-1", status.LastObservedAccountId);
    }

    [Fact]
    public async Task SwitchDesktopAsync_RequestsDesktopSwitchJson()
    {
        var runner = new FakeCliProcessRunner
        {
            ResultFactory = arguments =>
            {
                Assert.Equal(new[] { "desktop", "switch", "Workspace Two", "--json" }, arguments);
                return new CliProcessResult(
                    0,
                    """
                    {
                      "managed": true,
                      "running": true,
                      "desktopPid": 303,
                      "monitorPid": 404,
                      "executablePath": "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe",
                      "sessionHome": "C:\\Users\\user\\.codex-switch\\desktop\\session\\home",
                      "launchedAt": "2026-03-30T00:00:00.000Z",
                      "launchProfileId": "profile-2",
                      "lastObservedAccountId": "acct-2",
                      "lastObservedProfileId": "profile-2",
                      "lastSyncedAt": "2026-03-30T00:02:00.000Z",
                      "lastError": null
                    }
                    """,
                    string.Empty);
            },
        };
        var client = new CodexSwitchCliClient(runner);

        DesktopStatusDto status = await client.SwitchDesktopAsync("Workspace Two");

        Assert.True(status.Managed);
        Assert.Equal("profile-2", status.LastObservedProfileId);
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
