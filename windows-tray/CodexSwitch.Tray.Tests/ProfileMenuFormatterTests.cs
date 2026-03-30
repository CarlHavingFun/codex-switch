using CodexSwitch.Tray.Models;
using CodexSwitch.Tray.Presentation;

namespace CodexSwitch.Tray.Tests;

public sealed class ProfileMenuFormatterTests
{
    [Fact]
    public void FormatProfileLabel_PrefersManualWorkspaceNameAndCreditsSummary()
    {
        ManagedProfileDto profile = CreateProfile();
        ProfileStatusDto status = CreateStatus(profile, new UsageSummaryDto(
            "credits",
            "42.00",
            25,
            75,
            1_730_947_200,
            5,
            95,
            1_731_033_600,
            "team"));

        string label = ProfileMenuFormatter.FormatProfileLabel(profile, status);

        Assert.Contains("workspace-a [chatgpt]", label);
        Assert.Contains("Manual Team", label);
        Assert.DoesNotContain("Manual Team / Observed Team", label);
        Assert.Contains("credits 42.00", label);
        Assert.Contains(
            DateTimeOffset.FromUnixTimeSeconds(1_730_947_200).ToLocalTime().ToString("MM-dd HH:mm"),
            label);
    }

    [Fact]
    public void FormatActiveSummary_UsesWindowUsageWhenCreditsAreUnavailable()
    {
        ManagedProfileDto profile = CreateProfile();
        ProfileStatusDto status = CreateStatus(profile, new UsageSummaryDto(
            "window",
            null,
            42,
            58,
            1_735_693_200,
            null,
            null,
            null,
            "pro"));

        string summary = ProfileMenuFormatter.FormatActiveSummary(
            profile,
            new Dictionary<string, ProfileStatusDto>
            {
                [profile.Id] = status,
            });

        Assert.Contains("Current: workspace-a", summary);
        Assert.Contains("58% left", summary);
    }

    [Fact]
    public void FormatDesktopSummary_UsesObservedProfileWhenAvailable()
    {
        ManagedProfileDto profile = CreateProfile();
        DesktopStatusDto status = new(
            true,
            true,
            101,
            202,
            @"C:\Program Files\WindowsApps\OpenAI.Codex\app\Codex.exe",
            @"C:\Users\user\.codex-switch\desktop\session\home",
            "2026-03-30T00:00:00.000Z",
            profile.Id,
            "acct_1",
            profile.Id,
            "2026-03-30T00:01:00.000Z",
            null);

        string summary = ProfileMenuFormatter.FormatDesktopSummary(
            status,
            new Dictionary<string, ManagedProfileDto>
            {
                [profile.Id] = profile,
            });

        Assert.Equal("Desktop sync: running | workspace-a", summary);
    }

    private static ManagedProfileDto CreateProfile() =>
        new(
            "profile-1",
            "workspace-a",
            @"C:\profiles\workspace-a\home",
            "chatgpt",
            "acct_1",
            "team",
            "Manual Team",
            "Observed Team",
            "fingerprint-1",
            null,
            null,
            true);

    private static ProfileStatusDto CreateStatus(
        ManagedProfileDto profile,
        UsageSummaryDto usageSummary) =>
        new(
            profile,
            "Logged in using ChatGPT",
            new AccountDto("chatgpt", "person@example.com", "team"),
            null,
            false,
            usageSummary);
}
